import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { RestreamerClient } from "./restreamer.js";
import type { CreateStreamBody, StreamInfo } from "./types.js";

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

// --- In-memory stream metadata (name + createdAt) ---

const streamMeta = new Map<string, { name: string; createdAt: string }>();

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

// POST /api/streams — Create a new stream
app.post<{ Body: CreateStreamBody }>("/api/streams", async (request, reply) => {
  if (!requireApiKey(request, reply)) return;

  const { name } = request.body || {};
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return reply.code(400).send({ error: 'Missing "name" field' });
  }

  const streamId = crypto.randomUUID().slice(0, 8);
  const displayName = `${name.trim()} kamera`;

  try {
    await restreamer.createProcess(streamId);

    const info: StreamInfo = {
      id: streamId,
      name: displayName,
      rtmpUrl: restreamer.rtmpUrl(streamId),
      hlsUrl: restreamer.hlsUrl(streamId),
      createdAt: new Date().toISOString(),
    };

    streamMeta.set(streamId, { name: displayName, createdAt: info.createdAt });

    return reply.code(201).send(info);
  } catch (err) {
    request.log.error(err, "Failed to create stream");
    return reply.code(500).send({ error: "Failed to create stream" });
  }
});

// GET /api/streams — List active streams
app.get("/api/streams", async (_request, reply) => {
  try {
    const processes = await restreamer.listAltaProcesses();

    const streams: Omit<StreamInfo, "rtmpUrl">[] = processes.map((p) => {
      const streamId = p.config.id.replace("alta-", "");
      const meta = streamMeta.get(streamId);
      return {
        id: streamId,
        name: meta?.name || streamId,
        hlsUrl: restreamer.hlsUrl(streamId),
        createdAt: meta?.createdAt || "",
      };
    });

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
      const process = await restreamer.getProcess(id);
      if (!process) {
        return reply.code(404).send({ error: "Stream not found" });
      }

      const meta = streamMeta.get(id);
      const info: Omit<StreamInfo, "rtmpUrl"> = {
        id,
        name: meta?.name || id,
        hlsUrl: restreamer.hlsUrl(id),
        createdAt: meta?.createdAt || "",
      };

      return reply.send(info);
    } catch (err) {
      request.log.error(err, "Failed to get stream");
      return reply.code(500).send({ error: "Failed to get stream" });
    }
  }
);

// DELETE /api/streams/:id — Stop and remove a stream
app.delete<{ Params: { id: string } }>(
  "/api/streams/:id",
  async (request, reply) => {
    if (!requireApiKey(request, reply)) return;

    const { id } = request.params;
    try {
      await restreamer.deleteProcess(id);
      streamMeta.delete(id);
      return reply.code(204).send();
    } catch (err) {
      request.log.error(err, "Failed to delete stream");
      return reply.code(500).send({ error: "Failed to delete stream" });
    }
  }
);

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
