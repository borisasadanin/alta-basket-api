/**
 * VOD routes: list, get, update, delete recorded matches.
 */
import type { FastifyInstance } from "fastify";
import { requireApiKey, requireViewerAuth, requireAdminAuth } from "../auth.js";
import { minio } from "../state.js";
import type { VodEntry } from "../types.js";

export default async function vodRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/vod — List all VOD recordings
  app.get("/api/vod", async (request, reply) => {
    if (!requireViewerAuth(request, reply)) return;

    try {
      const entries = await minio.readVodIndex();
      // Sort by date descending (newest first), only return completed recordings
      // Filter out entries shorter than 10s (likely no actual recording data)
      const sorted = entries
        .filter((e) => e.stoppedAt && (e.durationSeconds === undefined || e.durationSeconds >= 10))
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
      // Delete actual HLS files from MinIO
      const deletedCount = await minio.deleteVodFiles(id);
      request.log.info(`Deleted ${deletedCount} files for VOD ${id}`);

      // Remove from index (mutex-protected)
      const removed = await minio.removeVodEntry(id);
      if (!removed) {
        return reply.code(404).send({ error: "Recording not found" });
      }
      return reply.code(204).send();
    } catch (err) {
      request.log.error(err, "Failed to delete VOD entry");
      return reply.code(500).send({ error: "Failed to delete recording" });
    }
  });
}
