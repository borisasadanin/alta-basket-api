/**
 * Stream CRUD routes: create, list, get, delete streams.
 * Also includes viewer heartbeat and auto-cleanup.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { requireApiKey, requireViewerAuth } from "../auth.js";
import { streamMeta, restreamer, minio, oscManager } from "../state.js";
import { getViewerCount, registerViewer, viewers } from "../viewer-tracking.js";
import { determineStreamStatus } from "../stream-status.js";
import type { CreateStreamBody, StreamInfo, StreamPublicInfo, VodEntry } from "../types.js";

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
      await restreamer.createProcess(streamId, { recording: true });

      oscManager.streamStarted();

      const info: StreamInfo = {
        id: streamId,
        name: displayName,
        rtmpUrl: restreamer.rtmpUrl(streamId),
        hlsUrl: restreamer.hlsUrl(streamId),
        createdAt: new Date().toISOString(),
      };

      streamMeta.set(streamId, { name: displayName, createdAt: info.createdAt, deviceId });

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
            hlsUrl: restreamer.hlsUrl(streamId),
            createdAt: meta.createdAt,
            status: "stopped",
            viewers: 0,
          });
        } else {
          // Active metadata but Restreamer unreachable — show as "waiting" (not "live")
          streams.push({
            id: streamId,
            name: meta.name,
            hlsUrl: restreamer.hlsUrl(streamId),
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
          const hlsLive = await restreamer.isHlsLive(streamId);

          // Track whether stream was ever live
          if (hlsLive && meta) {
            meta.wasLive = true;
          }

          const status = determineStreamStatus(hlsLive, meta);

          // If stream ended, auto-mark as stopped in metadata
          if (status === "stopped" && meta && !meta.stoppedAt) {
            meta.stoppedAt = new Date().toISOString();
            const dur = Math.round((new Date(meta.stoppedAt).getTime() - new Date(meta.createdAt).getTime()) / 1000);
            minio.updateVodEntry(streamId, { stoppedAt: meta.stoppedAt, durationSeconds: dur }).catch(() => {});
          }

          return {
            id: streamId,
            name: meta?.name || streamId,
            hlsUrl: restreamer.hlsUrl(streamId),
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
          hlsUrl: restreamer.hlsUrl(streamId),
          createdAt: meta.createdAt,
          status: "stopped",
          viewers: 0,
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
      try {
        const meta = streamMeta.get(id);

        // Check if stopped (within TTL)
        if (meta?.stoppedAt) {
          const age = Date.now() - new Date(meta.stoppedAt).getTime();
          if (age <= config.STOPPED_TTL_MS) {
            return reply.send({
              id,
              name: meta.name,
              hlsUrl: restreamer.hlsUrl(id),
              createdAt: meta.createdAt,
              status: "stopped",
              viewers: 0,
            } satisfies StreamPublicInfo);
          }
          return reply.code(404).send({ error: "Stream not found" });
        }

        const process = await restreamer.getProcess(id);
        if (!process) {
          return reply.code(404).send({ error: "Stream not found" });
        }

        const hlsLive = await restreamer.isHlsLive(id);

        // Track wasLive for accurate status
        if (hlsLive && meta) {
          meta.wasLive = true;
        }

        const status = determineStreamStatus(hlsLive, meta);

        // Auto-mark as stopped
        if (status === "stopped" && meta && !meta.stoppedAt) {
          meta.stoppedAt = new Date().toISOString();
          const dur = Math.round((new Date(meta.stoppedAt).getTime() - new Date(meta.createdAt).getTime()) / 1000);
          minio.updateVodEntry(id, { stoppedAt: meta.stoppedAt, durationSeconds: dur }).catch(() => {});
        }

        const info: StreamPublicInfo = {
          id,
          name: meta?.name || id,
          hlsUrl: restreamer.hlsUrl(id),
          createdAt: meta?.createdAt || "",
          status,
          viewers: getViewerCount(id),
        };

        return reply.send(info);
      } catch (err) {
        request.log.error(err, "Failed to get stream");
        return reply.code(500).send({ error: "Failed to get stream" });
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
      oscManager.streamEnded();

      // Delete the Restreamer process in the background (fire-and-forget).
      // Metadata is already updated, so the response returns instantly.
      // The cleanup timer will catch any stragglers.
      restreamer.deleteProcess(id).catch((err) => {
        request.log.warn(err, `Could not delete Restreamer process for ${id} (may already be stopped)`);
      });

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
        const ageMs = meta ? Date.now() - new Date(meta.createdAt).getTime() : 0;

        // Delete finished/failed processes (RTMP timed out or errored)
        if (state === "finished" || state === "failed") {
          app.log.info(`Cleaning up stale stream ${streamId} (state: ${state})`);
          await restreamer.deleteProcess(streamId);
          if (meta && !meta.stoppedAt) {
            meta.stoppedAt = new Date().toISOString();
            const dur = Math.round((new Date(meta.stoppedAt).getTime() - new Date(meta.createdAt).getTime()) / 1000);
            minio.updateVodEntry(streamId, { stoppedAt: meta.stoppedAt, durationSeconds: dur }).catch(() => {});
          }
          viewers.delete(streamId);
        }
        // Delete processes stuck in "waiting" for > 10 minutes (never got RTMP input)
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

      // Remove stopped metadata older than TTL
      const now = Date.now();
      for (const [streamId, meta] of streamMeta) {
        if (meta.stoppedAt && now - new Date(meta.stoppedAt).getTime() > config.STOPPED_TTL_MS) {
          streamMeta.delete(streamId);
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
