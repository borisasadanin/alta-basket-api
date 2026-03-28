/**
 * Highlight clip routes: create and list clips from live streams.
 */
import type { FastifyInstance } from "fastify";
import { requireApiKey, requireViewerAuth } from "../auth.js";
import { streamMeta, collectors, clipsByStream, minio } from "../state.js";
import { createClip } from "../clip-service.js";

/** Track last clip time per stream to prevent spam */
const lastClipTime = new Map<string, number>();
const MIN_CLIP_INTERVAL_MS = 5_000; // 5 seconds between clips per stream

export default async function clipRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/streams/:id/clip — Create a highlight clip (admin only)
  app.post<{ Params: { id: string }; Body: { timestamp?: string; label?: string } }>(
    "/api/streams/:id/clip",
    async (request, reply) => {
      if (!requireApiKey(request, reply)) return;

      const { id } = request.params;

      // Rate limit: max 1 clip per 5 seconds per stream
      const lastTime = lastClipTime.get(id) || 0;
      if (Date.now() - lastTime < MIN_CLIP_INTERVAL_MS) {
        return reply.code(429).send({ error: "too_fast", message: "Vänta några sekunder mellan klipp" });
      }

      const meta = streamMeta.get(id);
      if (!meta) {
        return reply.code(404).send({ error: "stream_not_found", message: "Strömmen hittades inte" });
      }
      if (meta.stoppedAt) {
        return reply.code(400).send({ error: "stream_stopped", message: "Strömmen är redan stoppad" });
      }

      const collector = collectors.get(id);
      if (!collector) {
        return reply
          .code(400)
          .send({ error: "no_collector", message: "Ingen segmentinsamling aktiv för denna ström" });
      }

      // Use provided timestamp or fall back to now
      const body = request.body || {};
      const buttonPressTimestamp = body.timestamp ? new Date(body.timestamp).getTime() : Date.now();

      if (isNaN(buttonPressTimestamp)) {
        return reply.code(400).send({ error: "invalid_timestamp", message: "Ogiltig tidsstämpel" });
      }

      try {
        lastClipTime.set(id, Date.now());

        const clip = await createClip(
          collector,
          buttonPressTimestamp,
          minio,
          request.log,
          body.label,
        );

        // Store in-memory + persist to MinIO
        if (!clipsByStream.has(id)) {
          clipsByStream.set(id, []);
        }
        clipsByStream.get(id)!.push(clip);
        await minio.addClipEntry(clip);

        return reply.code(201).send(clip);
      } catch (err) {
        request.log.error(err, "Failed to create clip");
        return reply.code(500).send({
          error: "clip_failed",
          message: err instanceof Error ? err.message : "Kunde inte skapa klipp",
        });
      }
    },
  );

  // GET /api/streams/:id/clips — List highlight clips for a stream (live in-memory)
  app.get<{ Params: { id: string } }>(
    "/api/streams/:id/clips",
    async (request, reply) => {
      if (!requireViewerAuth(request, reply)) return;

      const { id } = request.params;
      const clips = clipsByStream.get(id) || [];

      // Return newest first
      return reply.send([...clips].reverse());
    },
  );

  // GET /api/clips/:id — Get a specific highlight clip by ID
  app.get<{ Params: { id: string } }>(
    "/api/clips/:id",
    async (request, reply) => {
      if (!requireViewerAuth(request, reply)) return;

      const { id } = request.params;
      try {
        const clips = await minio.readClipsIndex();
        const clip = clips.find((c) => c.id === id);
        if (!clip) {
          return reply.code(404).send({ error: "clip_not_found", message: "Klippet hittades inte" });
        }
        return reply.send(clip);
      } catch (err) {
        request.log.error(err, "Failed to read clip");
        return reply.code(500).send({ error: "read_failed", message: "Kunde inte läsa klipp" });
      }
    },
  );

  // GET /api/clips — List ALL highlight clips (persistent, from MinIO index)
  app.get(
    "/api/clips",
    async (request, reply) => {
      if (!requireViewerAuth(request, reply)) return;

      const clips = await minio.readClipsIndex();

      // Return newest first
      return reply.send([...clips].reverse());
    },
  );
}
