/**
 * Admin routes: storage info, admin token verification.
 */
import type { FastifyInstance } from "fastify";
import { requireAdminAuth } from "../auth.js";
import { config } from "../config.js";
import { minio } from "../state.js";

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
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

      const capacityBytes = config.MINIO_STORAGE_CAPACITY_GB * 1024 * 1024 * 1024;

      return reply.send({
        totalBytes: storageInfo.totalBytes,
        capacityBytes,
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
}
