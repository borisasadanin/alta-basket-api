/**
 * Highlight clip routes: create and list clips from live streams.
 */
import type { FastifyInstance } from "fastify";
import { requireApiKey, requireViewerAuth } from "../auth.js";
import { streamMeta, collectors, clipsByStream, minio } from "../state.js";
import { createClip } from "../clip-service.js";
import { convertSegmentsToMp4 } from "../mp4-converter.js";

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

  // GET /api/clips/:id/public — Get a specific clip without auth (for clip.html sharing)
  app.get<{ Params: { id: string } }>(
    "/api/clips/:id/public",
    async (request, reply) => {
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

  // GET /api/clips/:id/og — Open Graph HTML for WhatsApp/social media link previews
  app.get<{ Params: { id: string } }>(
    "/api/clips/:id/og",
    async (request, reply) => {
      const { id } = request.params;
      try {
        const clips = await minio.readClipsIndex();
        const clip = clips.find((c) => c.id === id);
        if (!clip) {
          return reply.code(404).type("text/html").send("<h1>Klippet hittades inte</h1>");
        }

        const label = clip.label || "Höjdpunkt";
        const title = `${label} — Älta Courtside`;
        const clipPageUrl = `https://altacourtside.se/clip.html#${encodeURIComponent(clip.id)}`;
        const videoUrl = clip.mp4Url || "";

        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta property="og:type" content="video.other">
<meta property="og:title" content="${title}">
<meta property="og:description" content="Se höjdpunkten från matchen.">
<meta property="og:image" content="https://altacourtside.se/icon.png">
${videoUrl ? `<meta property="og:video" content="${videoUrl}">
<meta property="og:video:secure_url" content="${videoUrl}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="1280">
<meta property="og:video:height" content="720">` : ""}
<meta property="og:url" content="${clipPageUrl}">
<meta http-equiv="refresh" content="0;url=${clipPageUrl}">
<title>${title}</title>
</head>
<body><p>Omdirigerar...</p></body>
</html>`;

        return reply.type("text/html").send(html);
      } catch (err) {
        request.log.error(err, "Failed to serve OG page for clip");
        return reply.code(500).type("text/html").send("<h1>Serverfel</h1>");
      }
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

  // POST /api/clips/backfill-mp4 — Generate MP4 for existing clips that lack it (admin only)
  app.post(
    "/api/clips/backfill-mp4",
    async (request, reply) => {
      if (!requireApiKey(request, reply)) return;

      const clips = await minio.readClipsIndex();
      const missing = clips.filter((c) => !c.mp4Url);

      if (missing.length === 0) {
        return reply.send({ message: "All clips already have MP4", converted: 0 });
      }

      let converted = 0;
      const errors: string[] = [];

      for (const clip of missing) {
        try {
          // Read the HLS manifest to find segment URLs
          const manifestKey = `clips/${clip.streamId}/${clip.id}.m3u8`;
          const manifest = await minio.readFile(manifestKey);
          if (!manifest) {
            errors.push(`${clip.id}: manifest not found`);
            continue;
          }

          // Parse segment URLs from manifest
          const segmentUrls = manifest
            .split("\n")
            .filter((line) => line.startsWith("http") && line.endsWith(".ts"));

          if (segmentUrls.length === 0) {
            errors.push(`${clip.id}: no segments in manifest`);
            continue;
          }

          // Download segments (extract MinIO key from full URL)
          const segmentBuffers = await Promise.all(
            segmentUrls.map(async (url) => {
              // URL: https://.../recordings/streamId/filename.ts → key: streamId/filename.ts
              const key = url.split("/recordings/")[1];
              if (!key) throw new Error(`Cannot parse key from URL: ${url}`);
              return { key, data: await minio.downloadBuffer(key) };
            }),
          );

          // Convert to MP4
          const mp4Buffer = await convertSegmentsToMp4(segmentBuffers);
          const mp4Key = `clips/${clip.streamId}/${clip.id}.mp4`;
          await minio.uploadBuffer(mp4Key, mp4Buffer, "video/mp4");

          clip.mp4Url = minio.clipMp4Url(clip.streamId, clip.id);
          converted++;
          request.log.info(`Backfilled MP4 for clip ${clip.id} (${mp4Buffer.length} bytes)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${clip.id}: ${msg}`);
          request.log.warn(err, `Failed to backfill MP4 for clip ${clip.id}`);
        }
      }

      // Save updated index with mp4Urls
      if (converted > 0) {
        await minio.writeClipsIndex(clips);
      }

      return reply.send({ converted, errors: errors.length > 0 ? errors : undefined });
    },
  );
}
