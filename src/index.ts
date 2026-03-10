import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { RestreamerClient } from "./restreamer.js";
import { OscInstanceManager } from "./osc-manager.js";
import { MinioClient } from "./minio.js";
import type { CreateStreamBody, StreamInfo, StreamPublicInfo, VodEntry } from "./types.js";

// --- Config ---

const PORT = parseInt(process.env.PORT || "8000", 10);
const API_KEY = process.env.API_KEY || "alta-basket-2026";
let VIEWER_PIN = process.env.VIEWER_PIN || "123456";
const ADMIN_PIN = process.env.ADMIN_PIN || "804480";
const VIEWER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OSC_INSTANCE_NAME = process.env.OSC_INSTANCE_NAME || "restreamerlive";
const RESTREAMER_URL =
  process.env.RESTREAMER_URL ||
  `https://borispriv-${OSC_INSTANCE_NAME}.datarhei-restreamer.auto.prod.osaas.io`;
const OSC_PAT = process.env.OSC_ACCESS_TOKEN || "";
const RESTREAMER_GRACE_PERIOD_MS = parseInt(
  process.env.RESTREAMER_GRACE_PERIOD_MS || String(15 * 60 * 1000),
  10
);

// MinIO config
const MINIO_ENDPOINT =
  process.env.MINIO_ENDPOINT ||
  "https://borispriv-basket.minio-minio.auto.prod.osaas.io";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "root";
const MINIO_SECRET_KEY =
  process.env.MINIO_SECRET_KEY || "37be8999e5d3d04615705921defbaea9";
const MINIO_RECORDINGS_BUCKET = "recordings";

if (!OSC_PAT) {
  console.error("Missing OSC_ACCESS_TOKEN");
  process.exit(1);
}

if (!VIEWER_PIN) {
  console.warn("VIEWER_PIN not set — viewer access is unprotected");
}

// --- Viewer token store ---

const viewerTokens = new Map<string, number>(); // token -> expiresAt timestamp

function createViewerToken(): string {
  const token = crypto.randomUUID();
  viewerTokens.set(token, Date.now() + VIEWER_TOKEN_TTL_MS);
  return token;
}

function isValidViewerToken(token: string): boolean {
  const exp = viewerTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    viewerTokens.delete(token);
    return false;
  }
  return true;
}

// --- Admin token store ---

const adminTokens = new Map<string, number>(); // token -> expiresAt timestamp

function createAdminToken(): string {
  const token = crypto.randomUUID();
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
  return token;
}

function isValidAdminToken(token: string): boolean {
  const exp = adminTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}

// Clean up expired tokens every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of viewerTokens) {
    if (now > exp) viewerTokens.delete(token);
  }
  for (const [token, exp] of adminTokens) {
    if (now > exp) adminTokens.delete(token);
  }
}, 60 * 60 * 1000);

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
const restreamer = new RestreamerClient(RESTREAMER_URL, OSC_PAT, "");
const minio = new MinioClient(MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY);
const oscManager = new OscInstanceManager({
  instanceName: OSC_INSTANCE_NAME,
  gracePeriodMs: RESTREAMER_GRACE_PERIOD_MS,
  logger: app.log,
  s3Config: {
    endpoint: MINIO_ENDPOINT.replace(/^https?:\/\//, ""),
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
    bucket: MINIO_RECORDINGS_BUCKET,
  },
});

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

/** Check API key OR valid viewer token. Returns true if authorized. */
function requireViewerAuth(
  request: { headers: Record<string, string | string[] | undefined> },
  reply: { code: (n: number) => { send: (o: unknown) => void } }
): boolean {
  // No PIN configured → open access
  if (!VIEWER_PIN) return true;

  // API key always works (for the iOS app)
  const key = request.headers["x-api-key"];
  if (API_KEY && key === API_KEY) return true;

  // Check viewer token from Authorization header
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (isValidViewerToken(token)) return true;
  }

  reply.code(401).send({ error: "Åtkomst nekad. Ange kod för att titta." });
  return false;
}

/** Check admin token from X-Admin-Token header. Returns true if authorized. */
function requireAdminAuth(
  request: { headers: Record<string, string | string[] | undefined> },
  reply: { code: (n: number) => { send: (o: unknown) => void } }
): boolean {
  const token = request.headers["x-admin-token"];
  if (typeof token === "string" && isValidAdminToken(token)) return true;

  // API key also works as admin
  const key = request.headers["x-api-key"];
  if (API_KEY && key === API_KEY) return true;

  reply.code(401).send({ error: "Admin-åtkomst krävs" });
  return false;
}

// --- Routes ---

// GET /api/auth/status — Check if PIN protection is active
app.get("/api/auth/status", async (_request, reply) => {
  return reply.send({ pinRequired: !!VIEWER_PIN });
});

// POST /api/auth/verify — Verify viewer or admin PIN and return session token(s)
app.post<{ Body: { pin?: string } }>("/api/auth/verify", async (request, reply) => {
  if (!VIEWER_PIN) {
    // No PIN configured — return a token anyway
    return reply.send({ token: createViewerToken(), role: "viewer" });
  }

  const { pin } = request.body || {};

  // Check admin PIN first
  if (pin && pin === ADMIN_PIN) {
    const viewerTok = createViewerToken();
    const adminTok = createAdminToken();
    return reply.send({ token: viewerTok, role: "admin", adminToken: adminTok });
  }

  // Check viewer PIN
  if (!pin || pin !== VIEWER_PIN) {
    return reply.code(401).send({ error: "Fel kod" });
  }

  const token = createViewerToken();
  return reply.send({ token, role: "viewer" });
});

// POST /api/auth/admin — Verify admin PIN and return an admin token
app.post<{ Body: { pin?: string } }>("/api/auth/admin", async (request, reply) => {
  const { pin } = request.body || {};
  if (!pin || pin !== ADMIN_PIN) {
    return reply.code(401).send({ error: "Fel admin-kod" });
  }

  const token = createAdminToken();
  return reply.send({ token });
});

// PUT /api/auth/pin — Change the viewer PIN (admin, requires API key)
app.put<{ Body: { pin?: string } }>("/api/auth/pin", async (request, reply) => {
  if (!requireApiKey(request, reply)) return;

  const { pin } = request.body || {};
  if (!pin || typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) {
    return reply.code(400).send({ error: "PIN must be 4-8 digits" });
  }

  VIEWER_PIN = pin;
  // Invalidate all existing viewer tokens so everyone must re-enter the new PIN
  viewerTokens.clear();

  app.log.info(`Viewer PIN updated (${pin.length} digits)`);
  return reply.send({ ok: true, pinLength: pin.length });
});

// POST /api/streams — Create a new stream (or resume existing one for same device)
app.post<{ Body: CreateStreamBody }>("/api/streams", async (request, reply) => {
  if (!requireApiKey(request, reply)) return;

  const { name, deviceId } = request.body || {};
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return reply.code(400).send({ error: 'Missing "name" field' });
  }

  // Ensure Restreamer instance is running (starts it if needed)
  try {
    const instanceInfo = await oscManager.ensureRunning();
    restreamer.rtmpHost = instanceInfo.rtmpHost;
  } catch (err) {
    request.log.error(err, "Failed to start Restreamer instance");
    return reply.code(503).send({
      error: "Streaming service is starting up. Please try again in a moment.",
    });
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
          await restreamer.createProcess(existingId, { recording: true });
        } catch {
          // Process might still exist, ignore
        }
        meta.stoppedAt = undefined;
        meta.createdAt = new Date().toISOString();
      }

      oscManager.streamStarted();

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

    // Create VOD entry with dummy match metadata
    const vodEntry: VodEntry = {
      id: streamId,
      matchTitle: "Basketmatch",
      location: "Ältahallen",
      homeTeam: "Älta IF",
      awayTeam: "Motståndare",
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
    return reply.code(500).send({ error: "Failed to create stream" });
  }
});

// GET /api/streams — List active + recently stopped streams
app.get("/api/streams", async (_request, reply) => {
  if (!requireViewerAuth(_request, reply)) return;

  // If Restreamer is not running, only return stopped metadata
  if (oscManager.getState() === "stopped") {
    const streams: StreamPublicInfo[] = [];
    const now = Date.now();
    for (const [streamId, meta] of streamMeta) {
      if (!meta.stoppedAt) continue;
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
    if (!requireViewerAuth(request, reply)) return;

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
      // Keep metadata with stoppedAt so it shows as "stopped" for TTL
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
  // Skip cleanup if Restreamer is not running
  if (oscManager.getState() !== "running") {
    // Still clean up expired metadata
    const now = Date.now();
    for (const [streamId, meta] of streamMeta) {
      if (meta.stoppedAt && now - new Date(meta.stoppedAt).getTime() > STOPPED_TTL_MS) {
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
      if (meta.stoppedAt && now - new Date(meta.stoppedAt).getTime() > STOPPED_TTL_MS) {
        streamMeta.delete(streamId);
      }
    }
  } catch (err) {
    app.log.error(err, "Cleanup error");
  }
}

setInterval(cleanupStaleStreams, 60_000);

// --- Restreamer admin routes ---

// GET /api/restreamer/status — Check Restreamer instance state (with liveness verification)
app.get("/api/restreamer/status", async (request, reply) => {
  if (!requireApiKey(request, reply)) return;
  // When state is "running", do a quick liveness check to catch crashed/unreachable instances
  const state = await oscManager.quickCheck();
  return reply.send({
    state,
    info: oscManager.getInfo(),
  });
});

// POST /api/restreamer/start — Trigger Restreamer instance start (non-blocking)
app.post("/api/restreamer/start", async (request, reply) => {
  if (!requireApiKey(request, reply)) return;
  const currentState = oscManager.getState();
  if (currentState === "running") {
    return reply.send({ state: "running", info: oscManager.getInfo() });
  }
  if (currentState !== "starting") {
    // Fire and forget — client polls /status to track progress
    oscManager.ensureRunning().then((info) => {
      restreamer.rtmpHost = info.rtmpHost;
    }).catch((err) => {
      request.log.error(err, "Background Restreamer start failed");
    });
  }
  return reply.send({ state: "starting" });
});

// DELETE /api/restreamer/stop — Force-stop Restreamer instance
app.delete("/api/restreamer/stop", async (request, reply) => {
  if (!requireApiKey(request, reply)) return;
  try {
    await oscManager.forceStop();
    return reply.code(204).send();
  } catch (err) {
    request.log.error(err, "Failed to stop Restreamer");
    return reply.code(500).send({ error: "Failed to stop Restreamer" });
  }
});

// --- VOD routes ---

// GET /api/vod — List all VOD recordings
app.get("/api/vod", async (request, reply) => {
  if (!requireViewerAuth(request, reply)) return;

  try {
    const entries = await minio.readVodIndex();
    // Sort by date descending (newest first), only return completed recordings
    const sorted = entries
      .filter((e) => e.stoppedAt)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return reply.send(sorted);
  } catch (err) {
    request.log.error(err, "Failed to read VOD index");
    return reply.code(500).send({ error: "Failed to load recordings" });
  }
});

// GET /api/vod/:id — Get a specific VOD entry
app.get<{ Params: { id: string } }>("/api/vod/:id", async (request, reply) => {
  if (!requireViewerAuth(request, reply)) return;

  const { id } = request.params;
  try {
    const entries = await minio.readVodIndex();
    const entry = entries.find((e) => e.id === id);
    if (!entry) {
      return reply.code(404).send({ error: "Recording not found" });
    }
    return reply.send(entry);
  } catch (err) {
    request.log.error(err, "Failed to read VOD entry");
    return reply.code(500).send({ error: "Failed to load recording" });
  }
});

// PUT /api/vod/:id — Update VOD metadata (admin, requires API key)
app.put<{ Params: { id: string }; Body: Partial<VodEntry> }>(
  "/api/vod/:id",
  async (request, reply) => {
    if (!requireApiKey(request, reply)) return;

    const { id } = request.params;
    const allowedFields = [
      "matchTitle", "location", "homeTeam", "awayTeam", "matchDate",
    ] as const;

    const update: Partial<VodEntry> = {};
    for (const field of allowedFields) {
      if (request.body[field] !== undefined) {
        (update as Record<string, unknown>)[field] = request.body[field];
      }
    }

    try {
      await minio.updateVodEntry(id, update);
      return reply.send({ ok: true });
    } catch (err) {
      request.log.error(err, "Failed to update VOD entry");
      return reply.code(500).send({ error: "Failed to update recording" });
    }
  }
);

// DELETE /api/vod/:id — Delete a VOD entry and its files (admin)
app.delete<{ Params: { id: string } }>("/api/vod/:id", async (request, reply) => {
  if (!requireAdminAuth(request, reply)) return;

  const { id } = request.params;
  try {
    const entries = await minio.readVodIndex();
    const filtered = entries.filter((e) => e.id !== id);
    if (filtered.length === entries.length) {
      return reply.code(404).send({ error: "Recording not found" });
    }

    // Delete actual HLS files from MinIO
    const deletedCount = await minio.deleteVodFiles(id);
    request.log.info(`Deleted ${deletedCount} files for VOD ${id}`);

    // Remove from index
    await minio.writeVodIndex(filtered);
    return reply.code(204).send();
  } catch (err) {
    request.log.error(err, "Failed to delete VOD entry");
    return reply.code(500).send({ error: "Failed to delete recording" });
  }
});

// --- Admin routes ---

// GET /api/admin/storage — Get storage usage info (admin)
app.get("/api/admin/storage", async (request, reply) => {
  if (!requireAdminAuth(request, reply)) return;

  try {
    const entries = await minio.readVodIndex();
    const stoppedEntries = entries.filter((e) => e.stoppedAt);
    const storageInfo = await minio.getStorageInfo(stoppedEntries);

    // Merge VOD metadata with size info
    const vods = stoppedEntries
      .map((entry) => {
        const sizeInfo = storageInfo.vods.find((v) => v.id === entry.id);
        return {
          ...entry,
          sizeBytes: sizeInfo?.sizeBytes || 0,
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return reply.send({
      totalBytes: storageInfo.totalBytes,
      vodCount: vods.length,
      vods,
    });
  } catch (err) {
    request.log.error(err, "Failed to get storage info");
    return reply.code(500).send({ error: "Failed to get storage info" });
  }
});

// GET /api/admin/verify — Check if admin token is still valid
app.get("/api/admin/verify", async (request, reply) => {
  if (!requireAdminAuth(request, reply)) return;
  return reply.send({ ok: true });
});

// --- Health check ---
app.get("/health", async () => ({ status: "ok" }));

// --- Start ---

// Ensure MinIO recordings bucket exists
try {
  await minio.ensureBucket();
  console.log("MinIO recordings bucket ready");
} catch (err) {
  console.error("Failed to initialize MinIO bucket (VOD will be unavailable):", err);
}

try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Alta Basket API running on port ${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
