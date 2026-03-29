/**
 * Stream CRUD routes: create, list, get, delete streams.
 * Also includes viewer heartbeat and auto-cleanup.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { requireApiKey, requireViewerAuth } from "../auth.js";
import { streamMeta, restreamer, minio, oscManager, collectors, clipsByStream } from "../state.js";
import { SegmentCollector } from "../segment-collector.js";
import { getViewerCount, registerViewer, viewers } from "../viewer-tracking.js";
import { determineStreamStatus } from "../stream-status.js";
import { uploadPauseSegments } from "../pause-segments.js";
import { stitchPlaylist, buildPartList } from "../playlist-stitcher.js";
import type { CreateStreamBody, StreamInfo, StreamPublicInfo, VodEntry } from "../types.js";
import { getBroadcastState, setBroadcastState } from "../broadcast-state.js";

/** DVR playlist URL for a stream (relative path — frontend prepends API base). */
function dvrUrl(id: string): string {
  return `/api/streams/${id}/dvr.m3u8`;
}

export default async function streamRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/streams — Create a new stream (or resume existing one for same device)
  app.post<{ Body: CreateStreamBody }>("/api/streams", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;

    const { name, deviceId, opponent, team } = request.body || {};
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return reply.code(400).send({ error: "missing_name", message: "Namn saknas" });
    }

    // Ensure Restreamer is available
    let oscState = oscManager.getState();
    if (oscState === "stopping") {
      // Grace period active — instant cancel, Restreamer is still running
      try {
        await oscManager.ensureRunning();
        oscState = oscManager.getState();
      } catch {
        // Fall through to state check below
      }
    } else if (oscState === "stopped") {
      // Restreamer is fully stopped — kick off start in background (takes 1-3 min)
      // Don't block the request; return 409 and let the client retry
      oscManager.ensureRunning().catch((err) => {
        app.log.error(err, "Background Restreamer start failed");
      });
      return reply.code(409).send({
        error: "restreamer_not_ready",
        message: "Sändningsmotorn startar automatiskt. Försök igen om ca 1 minut.",
      });
    }
    const oscInfo = oscManager.getInfo();
    if (oscState !== "running" || !oscInfo) {
      const stateMessages: Record<string, string> = {
        starting: "Sändningsmotorn startar. Vänta tills den är redo och försök igen (~1 min).",
        stopping: "Sändningsmotorn håller på att stängas ner. Försök igen om en stund.",
      };
      return reply.code(409).send({
        error: "restreamer_not_ready",
        message: stateMessages[oscState] || "Sändningsmotorn är inte redo.",
      });
    }
    restreamer.rtmpHost = oscInfo.rtmpHost;

    const displayName = `${name.trim()} kamera`;

    // If deviceId provided, reconnect to an ACTIVE (non-stopped) stream from same device
    if (deviceId) {
      for (const [existingId, meta] of streamMeta) {
        if (meta.deviceId !== deviceId || meta.name !== displayName) continue;

        // Only reconnect to active streams — stopped streams always create a new one
        // to avoid overwriting previous recordings in MinIO
        if (meta.stoppedAt) continue;

        oscManager.streamStarted();

        const info: StreamInfo = {
          id: existingId,
          name: meta.name,
          rtmpUrl: restreamer.rtmpUrl(existingId),
          hlsUrl: restreamer.hlsUrl(existingId),
          createdAt: meta.createdAt,
        };
        return reply.code(200).send(info);
      }
    }

    // No existing stream for this device — create new
    const streamId = crypto.randomUUID().slice(0, 8);

    try {
      // Restreamer recording disabled — SegmentCollector handles recording via HTTP polling
      await restreamer.createProcess(streamId, { recording: false, partNumber: 1 });

      oscManager.streamStarted();

      // Start collecting HLS segments for VOD recording
      const collector = new SegmentCollector(streamId, config.RESTREAMER_URL, minio, request.log, 1);
      collector.start();
      collectors.set(streamId, collector);

      const info: StreamInfo = {
        id: streamId,
        name: displayName,
        rtmpUrl: restreamer.rtmpUrl(streamId),
        hlsUrl: restreamer.hlsUrl(streamId),
        createdAt: new Date().toISOString(),
      };

      streamMeta.set(streamId, { name: displayName, createdAt: info.createdAt, deviceId, partNumber: 1, completedParts: [] });

      // Auto-transition broadcast state to "live" (only if idle or upcoming)
      const bState = getBroadcastState().status;
      if (bState === "idle" || bState === "upcoming") {
        setBroadcastState("live");
      }

      // Create VOD entry with match metadata from request
      const homeTeam = team || "Älta IF";
      const awayTeam = opponent || "Motståndare";
      const vodEntry: VodEntry = {
        id: streamId,
        matchTitle: `${homeTeam} vs ${awayTeam}`,
        location: "Ältahallen",
        homeTeam,
        awayTeam,
        matchDate: new Date().toISOString().slice(0, 10),
        cameraName: name.trim(),
        hlsUrl: minio.hlsUrl(streamId),
        createdAt: info.createdAt,
      };

      minio.addVodEntry(vodEntry).catch((err) => {
        request.log.error(err, "Failed to save VOD entry");
      });

      return reply.code(201).send(info);
    } catch (err) {
      request.log.error(err, "Failed to create stream");
      return reply.code(500).send({
        error: "stream_creation_failed",
        message: "Kunde inte skapa strömmen. Försök igen.",
      });
    }
  });

  // PATCH /api/streams/:id/pause — Pause a live stream
  app.patch<{ Params: { id: string } }>("/api/streams/:id/pause", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;

    const { id } = request.params;
    const meta = streamMeta.get(id);

    if (!meta) {
      return reply.code(404).send({ error: "not_found", message: "Strömmen hittades inte" });
    }
    if (meta.stoppedAt) {
      return reply.code(409).send({ error: "already_stopped", message: "Strömmen är redan stoppad" });
    }
    if (meta.pausedAt) {
      return reply.code(409).send({ error: "already_paused", message: "Strömmen är redan pausad" });
    }

    // Stop collecting segments and build part manifest BEFORE killing Restreamer
    const pauseCollector = collectors.get(id);
    if (pauseCollector) {
      await pauseCollector.pause();
      collectors.delete(id);
    }

    meta.pausedAt = new Date().toISOString();
    meta.completedParts.push(meta.partNumber);

    // Upload pause marker segments (fire-and-forget, with logging)
    const pauseNumber = meta.partNumber;
    uploadPauseSegments(minio, id, pauseNumber).catch((err) => {
      request.log.error(err, `Failed to upload pause segments for ${id}`);
    });

    // Delete the Restreamer process (it will die anyway after 120s timeout)
    restreamer.deleteProcess(id).catch((err) => {
      request.log.warn(err, `Could not delete Restreamer process for ${id} during pause`);
    });

    oscManager.streamPaused();

    // Auto-transition broadcast state to "paused" if all streams are now paused
    const allPaused = [...streamMeta.values()].every((m) => m.stoppedAt || m.pausedAt);
    if (allPaused) {
      setBroadcastState("paused");
    }

    return reply.code(200).send({ status: "paused", pausedAt: meta.pausedAt });
  });

  // PATCH /api/streams/:id/resume — Resume a paused stream
  app.patch<{ Params: { id: string } }>("/api/streams/:id/resume", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;

    const { id } = request.params;
    const meta = streamMeta.get(id);

    if (!meta) {
      return reply.code(404).send({ error: "not_found", message: "Strömmen hittades inte" });
    }
    if (!meta.pausedAt) {
      return reply.code(409).send({ error: "not_paused", message: "Strömmen är inte pausad" });
    }
    if (meta.stoppedAt) {
      return reply.code(409).send({ error: "already_stopped", message: "Strömmen är redan stoppad" });
    }

    // Ensure Restreamer is running
    const oscState = oscManager.getState();
    const oscInfo = oscManager.getInfo();
    if (oscState !== "running" || !oscInfo) {
      return reply.code(409).send({
        error: "restreamer_not_ready",
        message: "Sändningsmotorn är inte redo. Försök igen.",
      });
    }
    restreamer.rtmpHost = oscInfo.rtmpHost;

    // Increment part number for new recording segment
    meta.partNumber++;
    meta.pausedAt = undefined;
    // Reset wasLive so status becomes "waiting" (not "stopped") during the
    // gap before HLS is live again.  It gets re-set to true once isHlsLive()
    // returns true in the streams list/detail routes.
    meta.wasLive = false;

    try {
      // Ensure old process is fully removed before creating the new one.
      // The pause handler fires deleteProcess as fire-and-forget, so it may
      // still be in flight. Without this guard the async delete can race with
      // createProcess (same process ID) and kill the *new* process.
      try {
        await restreamer.deleteProcess(id);
      } catch {
        // Already deleted — expected after a normal pause
      }

      // Restreamer recording disabled — SegmentCollector handles recording via HTTP polling
      await restreamer.createProcess(id, { recording: false, partNumber: meta.partNumber });
      oscManager.streamResumed();
      setBroadcastState("live");

      // Start collecting segments for the new part
      const resumeCollector = new SegmentCollector(id, config.RESTREAMER_URL, minio, request.log, meta.partNumber);
      resumeCollector.start();
      collectors.set(id, resumeCollector);

      return reply.code(200).send({
        status: "resumed",
        rtmpUrl: restreamer.rtmpUrl(id),
        partNumber: meta.partNumber,
      });
    } catch (err) {
      // Rollback
      meta.partNumber--;
      meta.pausedAt = new Date().toISOString();
      request.log.error(err, "Failed to create Restreamer process on resume");
      return reply.code(500).send({
        error: "resume_failed",
        message: "Kunde inte återuppta strömmen. Försök igen.",
      });
    }
  });

  // GET /api/streams — List active + recently stopped streams
  app.get("/api/streams", async (_request, reply) => {
    if (!requireViewerAuth(_request, reply)) return;

    const restreamerState = oscManager.getState();
    const restreamerAvailable = restreamerState === "running" || restreamerState === "stopping";

    // Helper: build list from metadata only (when Restreamer is unavailable)
    function metadataOnlyStreams(): StreamPublicInfo[] {
      const streams: StreamPublicInfo[] = [];
      const now = Date.now();
      for (const [streamId, meta] of streamMeta) {
        if (meta.stoppedAt) {
          if (now - new Date(meta.stoppedAt).getTime() > config.STOPPED_TTL_MS) continue;
          streams.push({
            id: streamId,
            name: meta.name,
            hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
            createdAt: meta.createdAt,
            status: "stopped",
            viewers: 0,
          });
        } else if (meta.pausedAt) {
          streams.push({
            id: streamId,
            name: meta.name,
            hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
            dvrUrl: dvrUrl(streamId),
            createdAt: meta.createdAt,
            status: "paused",
            viewers: getViewerCount(streamId),
          });
        } else {
          // Active metadata but Restreamer unreachable — show as "waiting" (not "live")
          streams.push({
            id: streamId,
            name: meta.name,
            hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
            dvrUrl: dvrUrl(streamId),
            createdAt: meta.createdAt,
            status: "waiting",
            viewers: getViewerCount(streamId),
          });
        }
      }
      return streams;
    }

    // If Restreamer is not running, return metadata-only list
    if (!restreamerAvailable) {
      return reply.send(metadataOnlyStreams());
    }

    try {
      const processes = await restreamer.listAltaProcesses();
      const activeIds = new Set<string>();

      // Active streams (from Restreamer) — check HLS manifest to determine live status
      const streams: StreamPublicInfo[] = await Promise.all(
        processes.map(async (p) => {
          const streamId = p.config.id.replace("alta-", "");
          activeIds.add(streamId);
          const meta = streamMeta.get(streamId);
          if (meta?.stoppedAt) {
            meta.stoppedAt = undefined;
          }

          // Check BOTH Restreamer process state AND HLS manifest.
          // A process in "failed" state is not producing HLS, regardless of wasLive.
          const processExec = p.state?.exec;
          const processIsHealthy = processExec === "running";
          const partNum = meta?.partNumber ?? 1;
          const hlsLive = processIsHealthy ? await restreamer.isHlsLive(streamId, partNum) : false;

          // Track whether stream was ever live
          if (hlsLive && meta) {
            meta.wasLive = true;
          }

          // If process is in a failed/finished state (no RTMP input), override
          // wasLive to prevent the optimistic "live" status for dead streams.
          // Only "running" processes can be truly live.
          const effectiveMeta = (!processIsHealthy && meta?.wasLive)
            ? { ...meta, wasLive: false }
            : meta;

          const status = determineStreamStatus(hlsLive, effectiveMeta);

          // NOTE: We intentionally do NOT auto-stop streams here.
          // The cleanup timer (every 60s) handles stopping by checking the
          // actual Restreamer process state instead.

          return {
            id: streamId,
            name: meta?.name || streamId,
            hlsUrl: restreamer.hlsUrl(streamId, partNum),
            dvrUrl: dvrUrl(streamId),
            createdAt: meta?.createdAt || "",
            status,
            viewers: getViewerCount(streamId),
          };
        })
      );

      // Stopped streams (metadata with stoppedAt, within TTL)
      const now = Date.now();
      for (const [streamId, meta] of streamMeta) {
        if (activeIds.has(streamId) || !meta.stoppedAt) continue;
        if (now - new Date(meta.stoppedAt).getTime() > config.STOPPED_TTL_MS) continue;
        streams.push({
          id: streamId,
          name: meta.name,
          hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
          createdAt: meta.createdAt,
          status: "stopped",
          viewers: 0,
        });
      }

      // Paused streams (metadata with pausedAt, no active Restreamer process)
      for (const [streamId, meta] of streamMeta) {
        if (activeIds.has(streamId) || !meta.pausedAt || meta.stoppedAt) continue;
        streams.push({
          id: streamId,
          name: meta.name,
          hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
          dvrUrl: dvrUrl(streamId),
          createdAt: meta.createdAt,
          status: "paused",
          viewers: getViewerCount(streamId),
        });
      }

      // Waiting streams (metadata exists, no Restreamer process yet, not stopped/paused)
      // This catches newly created streams where the process hasn't appeared in
      // listAltaProcesses() yet (race condition / API lag).
      for (const [streamId, meta] of streamMeta) {
        if (activeIds.has(streamId) || meta.stoppedAt || meta.pausedAt) continue;
        // Stream has metadata but no process — show as "waiting"
        streams.push({
          id: streamId,
          name: meta.name,
          hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
          dvrUrl: dvrUrl(streamId),
          createdAt: meta.createdAt,
          status: "waiting",
          viewers: getViewerCount(streamId),
        });
      }

      return reply.send(streams);
    } catch (err) {
      // Restreamer API failed (crashed/503/504) — fall back to metadata
      _request.log.error(err, "Restreamer API unavailable, falling back to cached metadata");
      return reply.send(metadataOnlyStreams());
    }
  });

  // GET /api/streams/:id — Get a specific stream
  app.get<{ Params: { id: string } }>(
    "/api/streams/:id",
    async (request, reply) => {
      if (!requireViewerAuth(request, reply)) return;

      const { id } = request.params;
      const meta = streamMeta.get(id);

      const partNum = meta?.partNumber ?? 1;

      // Check if stopped (within TTL)
      if (meta?.stoppedAt) {
        const age = Date.now() - new Date(meta.stoppedAt).getTime();
        if (age <= config.STOPPED_TTL_MS) {
          return reply.send({
            id,
            name: meta.name,
            hlsUrl: restreamer.hlsUrl(id, partNum),
            createdAt: meta.createdAt,
            status: "stopped",
            viewers: 0,
          } satisfies StreamPublicInfo);
        }
        return reply.code(404).send({ error: "Stream not found" });
      }

      // Check if paused
      if (meta?.pausedAt && !meta.stoppedAt) {
        return reply.send({
          id,
          name: meta.name,
          hlsUrl: restreamer.hlsUrl(id, partNum),
          dvrUrl: dvrUrl(id),
          createdAt: meta.createdAt,
          status: "paused",
          viewers: getViewerCount(id),
        } satisfies StreamPublicInfo);
      }

      // Try Restreamer — but fall back to metadata if Restreamer is unavailable.
      // A Restreamer API failure must NEVER cause a 500 that kills the frontend player.
      try {
        const process = await restreamer.getProcess(id);
        if (!process) {
          // Process not found in Restreamer — but if metadata exists (not stopped, not paused),
          // the stream was recently created and the process hasn't registered yet.
          // Return "waiting" instead of 404 to prevent the frontend from closing the player.
          if (meta && !meta.stoppedAt && !meta.pausedAt) {
            return reply.send({
              id,
              name: meta.name,
              hlsUrl: restreamer.hlsUrl(id, partNum),
              dvrUrl: dvrUrl(id),
              createdAt: meta.createdAt,
              status: "waiting",
              viewers: getViewerCount(id),
            } satisfies StreamPublicInfo);
          }
          return reply.code(404).send({ error: "Stream not found" });
        }

        // Check BOTH process state AND HLS manifest
        const processExec = process.state?.exec;
        const processIsHealthy = processExec === "running";
        const hlsLive = processIsHealthy ? await restreamer.isHlsLive(id, partNum) : false;

        // Track wasLive for accurate status
        if (hlsLive && meta) {
          meta.wasLive = true;
        }

        // If process is failed (no RTMP input), override wasLive to prevent
        // the optimistic "live" status for dead streams.
        const effectiveMeta = (!processIsHealthy && meta?.wasLive)
          ? { ...meta, wasLive: false }
          : meta;

        const status = determineStreamStatus(hlsLive, effectiveMeta);

        // NOTE: No auto-stop here. The cleanup timer handles marking streams
        // as stopped based on the actual Restreamer process state.

        const info: StreamPublicInfo = {
          id,
          name: meta?.name || id,
          hlsUrl: restreamer.hlsUrl(id, partNum),
          dvrUrl: dvrUrl(id),
          createdAt: meta?.createdAt || "",
          status,
          viewers: getViewerCount(id),
        };

        return reply.send(info);
      } catch (err) {
        // Restreamer API failed — fall back to metadata to keep the player alive.
        // The stream is probably still running; we just can't confirm HLS status right now.
        request.log.warn(err, `Restreamer API error for stream ${id}, falling back to metadata`);

        if (meta && !meta.stoppedAt && !meta.pausedAt) {
          // Use last known status: if wasLive, report "live" (optimistic)
          const fallbackStatus = determineStreamStatus(false, meta);
          return reply.send({
            id,
            name: meta.name,
            hlsUrl: restreamer.hlsUrl(id, partNum),
            dvrUrl: dvrUrl(id),
            createdAt: meta.createdAt,
            status: fallbackStatus,
            viewers: getViewerCount(id),
          } satisfies StreamPublicInfo);
        }

        // No metadata — truly unknown stream
        return reply.code(404).send({ error: "Stream not found" });
      }
    }
  );

  // DELETE /api/streams/:id — Stop stream (keep metadata for TTL)
  app.delete<{ Params: { id: string } }>(
    "/api/streams/:id",
    async (request, reply) => {
      if (!requireApiKey(request, reply)) return;

      const { id } = request.params;

      // Always update metadata first (even if Restreamer is unreachable)
      const meta = streamMeta.get(id);
      // If stream has multiple parts (was paused at least once), stitch the playlist
      const wasPaused = !!meta?.pausedAt;
      const stoppedAt = new Date().toISOString();
      if (meta) {
        meta.stoppedAt = stoppedAt;

        // Finalize VOD entry with stop time and duration
        const durationSeconds = Math.round(
          (new Date(stoppedAt).getTime() - new Date(meta.createdAt).getTime()) / 1000
        );
        minio.updateVodEntry(id, { stoppedAt, durationSeconds }).catch((err) => {
          request.log.error(err, "Failed to finalize VOD entry");
        });
      }
      viewers.delete(id);
      if (wasPaused) {
        oscManager.pausedStreamEnded();
      } else {
        oscManager.streamEnded();
      }

      // Stop collecting segments and build final part manifest
      const stopCollector = collectors.get(id);
      if (stopCollector) {
        await stopCollector.stop();
        collectors.delete(id);
      }

      // Delete the Restreamer process in the background (fire-and-forget).
      // Metadata is already updated, so the response returns instantly.
      // The cleanup timer will catch any stragglers.
      restreamer.deleteProcess(id).catch((err) => {
        request.log.warn(err, `Could not delete Restreamer process for ${id} (may already be stopped)`);
      });

      // Auto-transition broadcast state to "ended" if no active streams remain
      const hasActiveStreams = [...streamMeta.values()].some((m) => !m.stoppedAt);
      if (!hasActiveStreams) {
        setBroadcastState("ended");
      }

      // Stitch playlist (always needed — all recordings use p1.m3u8, not index.m3u8)
      if (meta && meta.partNumber >= 1) {
        const parts = buildPartList(meta.completedParts, meta.partNumber);
        stitchPlaylist(minio, id, parts).catch((err) => {
          request.log.error(err, `Failed to stitch playlist for ${id}`);
        });
      }

      return reply.code(204).send();
    }
  );

  // POST /api/streams/:id/view — Register viewer heartbeat (no auth)
  app.post<{ Params: { id: string } }>(
    "/api/streams/:id/view",
    async (request, reply) => {
      const { id } = request.params;
      const ip = request.ip || "unknown";
      registerViewer(id, ip);
      return reply.code(204).send();
    }
  );

  // --- Auto-cleanup of stale streams ---
  async function cleanupStaleStreams(): Promise<void> {
    // Skip cleanup if Restreamer is not running
    if (oscManager.getState() !== "running") {
      // Still clean up expired metadata
      const now = Date.now();
      for (const [streamId, meta] of streamMeta) {
        if (meta.stoppedAt && now - new Date(meta.stoppedAt).getTime() > config.STOPPED_TTL_MS) {
          streamMeta.delete(streamId);
          clipsByStream.delete(streamId);
        }
      }
      return;
    }

    try {
      const processes = await restreamer.listAltaProcesses();
      let activeCount = 0;

      for (const p of processes) {
        const state = p.state?.exec;
        const streamId = p.config.id.replace("alta-", "");
        const meta = streamMeta.get(streamId);
        // Use backend metadata age, falling back to Restreamer process created_at.
        // Without this fallback, orphaned processes (metadata lost after backend
        // redeploy) would never be cleaned up since ageMs would be 0.
        const createdAtMs = meta
          ? new Date(meta.createdAt).getTime()
          : (p.created_at ? p.created_at * 1000 : Date.now());
        const ageMs = Date.now() - createdAtMs;

        // Skip paused streams — they intentionally have no active Restreamer process
        if (meta?.pausedAt && !meta.stoppedAt) continue;

        // Delete finished/failed processes — but ONLY if older than 3 minutes.
        // Young processes in "finished" state may be in a reconnect cycle
        // (autostart + reconnect) waiting for RTMP input from the iOS app.
        // The stale_timeout_seconds (120s) on Restreamer handles truly dead
        // processes, so we only clean up after that window has fully passed.
        if ((state === "finished" || state === "failed") && ageMs > 3 * 60 * 1000) {
          app.log.info(`Cleaning up stale stream ${streamId} (state: ${state}, age: ${Math.round(ageMs / 1000)}s)`);
          await restreamer.deleteProcess(streamId);
          if (meta && !meta.stoppedAt) {
            meta.stoppedAt = new Date().toISOString();
            const dur = Math.round((new Date(meta.stoppedAt).getTime() - new Date(meta.createdAt).getTime()) / 1000);
            minio.updateVodEntry(streamId, { stoppedAt: meta.stoppedAt, durationSeconds: dur }).catch(() => {});
          }
          viewers.delete(streamId);
        }
        // Delete processes stuck in non-running state for > 10 minutes
        else if (state !== "running" && ageMs > 10 * 60 * 1000) {
          app.log.info(`Cleaning up abandoned stream ${streamId} (age: ${Math.round(ageMs / 1000)}s)`);
          await restreamer.deleteProcess(streamId);
          if (meta && !meta.stoppedAt) {
            meta.stoppedAt = new Date().toISOString();
            const dur = Math.round((new Date(meta.stoppedAt).getTime() - new Date(meta.createdAt).getTime()) / 1000);
            minio.updateVodEntry(streamId, { stoppedAt: meta.stoppedAt, durationSeconds: dur }).catch(() => {});
          }
          viewers.delete(streamId);
        } else {
          // Still active
          activeCount++;
        }
      }

      // Sync the manager's active stream count with reality
      oscManager.syncActiveCount(activeCount);

      // If no active streams remain and broadcast state is still live/paused, transition to ended
      if (activeCount === 0) {
        const bStatus = getBroadcastState().status;
        if (bStatus === "live" || bStatus === "paused") {
          setBroadcastState("ended");
        }
      }

      // Remove stopped metadata older than TTL
      const now = Date.now();
      for (const [streamId, meta] of streamMeta) {
        if (meta.stoppedAt && now - new Date(meta.stoppedAt).getTime() > config.STOPPED_TTL_MS) {
          streamMeta.delete(streamId);
          clipsByStream.delete(streamId);
        }
      }
    } catch (err) {
      app.log.error(err, "Cleanup error");
    }
  }

  setInterval(cleanupStaleStreams, 60_000);

  // --- Finalize orphaned VOD entries ---
  // Entries without stoppedAt that are older than 1 hour are likely from
  // crashed streams or backend restarts. Mark them as finished.
  async function finalizeOrphanedVods(): Promise<void> {
    try {
      const entries = await minio.readVodIndex();
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;
      let updated = false;

      for (const entry of entries) {
        if (entry.stoppedAt) continue;
        const ageMs = now - new Date(entry.createdAt).getTime();
        if (ageMs < ONE_HOUR) continue;

        // This entry is orphaned — mark as finalized so it appears in VOD list.
        // Duration is unknown, so leave durationSeconds undefined (passes the VOD filter).
        entry.stoppedAt = entry.createdAt;
        // Try to stitch multi-part recording for orphaned stream
        const orphanMeta = streamMeta.get(entry.id);
        if (orphanMeta && orphanMeta.partNumber >= 1) {
          const parts = buildPartList(orphanMeta.completedParts, orphanMeta.partNumber);
          stitchPlaylist(minio, entry.id, parts).catch((err) => {
            app.log.error(err, `Failed to stitch orphaned playlist for ${entry.id}`);
          });
        }
        updated = true;
        app.log.info(`Finalized orphaned VOD entry ${entry.id} (age: ${Math.round(ageMs / 60000)} min)`);
      }

      if (updated) {
        await minio.writeVodIndex(entries);
      }
    } catch (err) {
      app.log.error(err, "VOD orphan cleanup error");
    }
  }

  // Run orphan cleanup on startup (after 10s delay) and then every 30 minutes
  setTimeout(finalizeOrphanedVods, 10_000);
  setInterval(finalizeOrphanedVods, 30 * 60 * 1000);
}
