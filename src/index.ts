import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { RestreamerClient } from "./restreamer.js";
import type { CreateStreamBody, StreamInfo, StreamPublicInfo } from "./types.js";

// --- Config ---

const PORT = parseInt(process.env.PORT || "8000", 10);
const API_KEY = process.env.API_KEY || "alta-basket-2026";
const RESTREAMER_URL =
  process.env.RESTREAMER_URL ||
  "https://eyevinnlab-restreamerlive.datarhei-restreamer.auto.prod.osaas.io";
const RTMP_HOST = process.env.RTMP_HOST || "172.232.131.169:10537";
const OSC_PAT = process.env.OSC_ACCESS_TOKEN || "";

if (!OSC_PAT) {
  console.error("Missing OSC_ACCESS_TOKEN");
  process.exit(1);
}

// --- In-memory stream metadata ---

const STOPPED_TTL_MS = 10 * 60 * 1000; // 10 minutes
const streamMeta = new Map<string, { name: string; createdAt: string; stoppedAt?: string; deviceId?: string }>();

// --- Viewer tracking: streamId -> Map<ip, lastSeenTimestamp> ---

const viewers = new Map<string, Map<string, number>>();
const VIEWER_TTL_MS = 60_000; // 60s without heartbeat = viewer gone

function registerViewer(streamId: string, ip: string): void {
  if (!viewers.has(streamId)) viewers.set(streamId, new Map());
  viewers.get(streamId)!.set(ip, Date.now());
}

function getViewerCount(streamId: string): number {
  const map = viewers.get(streamId);
  if (!map) return 0;
  const now = Date.now();
  for (const [ip, ts] of map) {
    if (now - ts > VIEWER_TTL_MS) map.delete(ip);
  }
  return map.size;
}

// --- Setup ---

const app = Fastify({ logger: true });
const restreamer = new RestreamerClient(RESTREAMER_URL, OSC_PAT, RTMP_HOST);

await app.register(cors, { origin: true });

// --- Auth middleware ---

function requireApiKey(
  request: { headers: Record<string, string | string[] | undefined> },
  reply: { code: (n: number) => { send: (o: unknown) => void } }
) {
  const key = request.headers["x-api-key"];
  if (!API_KEY || key !== API_KEY) {
    reply.code(401).send({ error: "Invalid or missing API key" });
    return false;
  }
  return true;
}

// --- Routes ---

// POST /api/streams — Create a new stream (or resume existing one for same device)
app.post<{ Body: CreateStreamBody }>("/api/streams", async (request, reply) => {
  if (!requireApiKey(request, reply)) return;

  const { name, deviceId } = request.body || {};
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return reply.code(400).send({ error: 'Missing "name" field' });
  }

  const displayName = `${name.trim()} kamera`;

  // If deviceId provided, look for an existing stream from this device with same name
  if (deviceId) {
    for (const [existingId, meta] of streamMeta) {
      if (meta.deviceId !== deviceId || meta.name !== displayName) continue;

      // Found a stream from this device with same name — reuse it
      if (meta.stoppedAt) {
        // Was stopped — recreate Restreamer process with same ID
        try {
          await restreamer.createProcess(existingId);
        } catch {
          // Process might still exist, ignore
        }
        meta.stoppedAt = undefined;
        meta.createdAt = new Date().toISOString();
      }

      // Return existing stream info (whether it was stopped or still active)
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
    await restreamer.createProcess(streamId);

    const info: StreamInfo = {
      id: streamId,
      name: displayName,
      rtmpUrl: restreamer.rtmpUrl(streamId),
      hlsUrl: restreamer.hlsUrl(streamId),
      createdAt: new Date().toISOString(),
    };

    streamMeta.set(streamId, { name: displayName, createdAt: info.createdAt, deviceId });

    return reply.code(201).send(info);
  } catch (err) {
    request.log.error(err, "Failed to create stream");
    return reply.code(500).send({ error: "Failed to create stream" });
  }
});

// GET /api/streams — List active + recently stopped streams
app.get("/api/streams", async (_request, reply) => {
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
        return {
          id: streamId,
          name: meta?.name || streamId,
          hlsUrl: restreamer.hlsUrl(streamId),
          createdAt: meta?.createdAt || "",
          status: hlsLive ? "live" as const : "waiting" as const,
          viewers: getViewerCount(streamId),
        };
      })
    );

    // Stopped streams (metadata with stoppedAt, within 1h)
    const now = Date.now();
    for (const [streamId, meta] of streamMeta) {
      if (activeIds.has(streamId) || !meta.stoppedAt) continue;
      if (now - new Date(meta.stoppedAt).getTime() > STOPPED_TTL_MS) continue;
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
    _request.log.error(err, "Failed to list streams");
    return reply.code(500).send({ error: "Failed to list streams" });
  }
});

// GET /api/streams/:id — Get a specific stream
app.get<{ Params: { id: string } }>(
  "/api/streams/:id",
  async (request, reply) => {
    const { id } = request.params;
    try {
      const meta = streamMeta.get(id);

      // Check if stopped (within TTL)
      if (meta?.stoppedAt) {
        const age = Date.now() - new Date(meta.stoppedAt).getTime();
        if (age <= STOPPED_TTL_MS) {
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
      const info: StreamPublicInfo = {
        id,
        name: meta?.name || id,
        hlsUrl: restreamer.hlsUrl(id),
        createdAt: meta?.createdAt || "",
        status: hlsLive ? "live" : "waiting",
        viewers: getViewerCount(id),
      };

      return reply.send(info);
    } catch (err) {
      request.log.error(err, "Failed to get stream");
      return reply.code(500).send({ error: "Failed to get stream" });
    }
  }
);

// DELETE /api/streams/:id — Stop stream (keep metadata for 1h)
app.delete<{ Params: { id: string } }>(
  "/api/streams/:id",
  async (request, reply) => {
    if (!requireApiKey(request, reply)) return;

    const { id } = request.params;
    try {
      await restreamer.deleteProcess(id);
      // Keep metadata with stoppedAt so it shows as "stopped" for 1h
      const meta = streamMeta.get(id);
      if (meta) {
        meta.stoppedAt = new Date().toISOString();
      }
      viewers.delete(id);
      return reply.code(204).send();
    } catch (err) {
      request.log.error(err, "Failed to delete stream");
      return reply.code(500).send({ error: "Failed to delete stream" });
    }
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

async function cleanupStaleStreams() {
  try {
    const processes = await restreamer.listAltaProcesses();
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
        }
        viewers.delete(streamId);
      }
      // Delete processes stuck in "waiting" for > 10 minutes (never got RTMP input)
      else if (state !== "running" && ageMs > 10 * 60 * 1000) {
        app.log.info(`Cleaning up abandoned stream ${streamId} (age: ${Math.round(ageMs / 1000)}s)`);
        await restreamer.deleteProcess(streamId);
        if (meta && !meta.stoppedAt) {
          meta.stoppedAt = new Date().toISOString();
        }
        viewers.delete(streamId);
      }
    }

    // Remove stopped metadata older than 1 hour
    const now = Date.now();
    for (const [streamId, meta] of streamMeta) {
      if (meta.stoppedAt && now - new Date(meta.stoppedAt).getTime() > STOPPED_TTL_MS) {
        streamMeta.delete(streamId);
      }
    }
  } catch (err) {
    app.log.error(err, "Cleanup error");
  }
}

setInterval(cleanupStaleStreams, 60_000);

// --- Health check ---
app.get("/health", async () => ({ status: "ok" }));

// --- Start ---

try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Alta Basket API running on port ${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
