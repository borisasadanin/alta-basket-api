/**
 * DVR playlist route — serves a growing HLS EVENT playlist from segments
 * already collected by SegmentCollector and stored in MinIO.
 *
 * Viewers use this instead of the memfs live playlist, gaining a catch-up
 * window that covers the entire stream duration (up to ~2 hours).
 */
import type { FastifyInstance } from "fastify";
import { requireViewerAuth } from "../auth.js";
import { streamMeta, collectors, minio } from "../state.js";

export default async function dvrRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/api/streams/:id/dvr.m3u8",
    async (request, reply) => {
      if (!requireViewerAuth(request, reply)) return;

      const { id } = request.params;
      const meta = streamMeta.get(id);

      if (!meta) {
        return reply.code(404).send({ error: "Stream not found" });
      }

      const collector = collectors.get(id);
      const segments = collector?.getSegmentTimeline() ?? [];

      if (segments.length === 0) {
        // No segments yet — return a minimal playlist so HLS.js retries
        return reply
          .type("application/vnd.apple.mpegurl")
          .header("Cache-Control", "no-cache, no-store")
          .send("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n");
      }

      const maxDuration = Math.ceil(
        Math.max(...segments.map((s) => s.duration))
      );

      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-PLAYLIST-TYPE:EVENT",
        `#EXT-X-TARGETDURATION:${maxDuration}`,
        "#EXT-X-MEDIA-SEQUENCE:0",
      ];

      for (const seg of segments) {
        // Add program date time for accurate timeline
        const dt = new Date(seg.savedAt).toISOString();
        lines.push(`#EXT-X-PROGRAM-DATE-TIME:${dt}`);
        lines.push(`#EXTINF:${seg.duration.toFixed(6)},`);
        lines.push(minio.segmentUrl(seg.key));
      }

      // If stream is stopped, close the playlist so HLS.js knows it's finite
      if (meta.stoppedAt) {
        lines.push("#EXT-X-ENDLIST");
      }

      const playlist = lines.join("\n") + "\n";

      return reply
        .type("application/vnd.apple.mpegurl")
        .header("Cache-Control", "no-cache, no-store")
        .send(playlist);
    }
  );
}
