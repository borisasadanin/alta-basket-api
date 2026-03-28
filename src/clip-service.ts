/**
 * Clip Service — extracts highlight clips from live HLS segments.
 *
 * Creates a mini HLS VOD playlist referencing existing .ts segments
 * already stored in MinIO by the SegmentCollector. No transcoding needed.
 */
import crypto from "node:crypto";
import type { SegmentCollector } from "./segment-collector.js";
import type { MinioClient } from "./minio.js";
import type { HighlightClip } from "./types.js";
import type { FastifyBaseLogger } from "fastify";
import { convertSegmentsToMp4 } from "./mp4-converter.js";

/** How many seconds of video to include in a clip.
 * With ~2s segments this gives us 4 segments = ~8s (≈5s before + 2s after the action).
 */
const CLIP_DURATION_SECONDS = 8;

/** Max time to wait for pipeline to deliver segments (ms) */
const MAX_WAIT_MS = 15_000;

/** Poll interval while waiting for segments (ms) */
const WAIT_POLL_MS = 2_000;

/** If the newest segment is older than this, wait for pipeline to catch up (ms) */
const FRESHNESS_THRESHOLD_MS = 5_000;

export async function createClip(
  collector: SegmentCollector,
  buttonPressTimestamp: number,
  minio: MinioClient,
  logger: FastifyBaseLogger,
  label?: string,
): Promise<HighlightClip> {
  const streamId = collector.getStreamId();

  // Wait for pipeline to deliver segments close to the button press time
  let timeline = collector.getSegmentTimeline();
  const waitStart = Date.now();

  while (Date.now() - waitStart < MAX_WAIT_MS) {
    timeline = collector.getSegmentTimeline();
    if (timeline.length === 0) {
      await sleep(WAIT_POLL_MS);
      continue;
    }

    const newest = timeline[timeline.length - 1];
    // Wait until we have a segment saved AFTER the button press,
    // so the clip includes ~1 segment of "aftermath" (the goal celebration etc.)
    if (newest.savedAt >= buttonPressTimestamp + 2_000) {
      break;
    }

    logger.info(
      `Waiting for pipeline: newest segment at ${newest.savedAt}, button press at ${buttonPressTimestamp}`,
    );
    await sleep(WAIT_POLL_MS);
  }

  // Re-fetch timeline after waiting
  timeline = collector.getSegmentTimeline();

  if (timeline.length === 0) {
    throw new Error("No segments available for clipping");
  }

  // Take the last N seconds of available segments.
  // After the pipeline wait above, the newest segments correspond to
  // roughly the moment the button was pressed (accounting for pipeline latency).
  // We simply walk backwards from the end of the timeline.
  const cutIndex = timeline.length - 1;
  let totalDuration = 0;
  let startIndex = cutIndex;
  for (let i = cutIndex; i >= 0; i--) {
    totalDuration += timeline[i].duration;
    startIndex = i;
    if (totalDuration >= CLIP_DURATION_SECONDS) break;
  }

  const clipSegments = timeline.slice(startIndex, cutIndex + 1);

  if (clipSegments.length === 0) {
    throw new Error("No segments found for the requested time range");
  }

  // Build mini HLS VOD manifest with absolute URLs
  const clipId = crypto.randomUUID().slice(0, 8);
  const maxDuration = Math.ceil(Math.max(...clipSegments.map((s) => s.duration)));
  const actualDuration = clipSegments.reduce((sum, s) => sum + s.duration, 0);

  const manifestLines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${maxDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];

  for (const seg of clipSegments) {
    manifestLines.push(`#EXTINF:${seg.duration.toFixed(6)},`);
    manifestLines.push(minio.segmentUrl(seg.key));
  }

  manifestLines.push("#EXT-X-ENDLIST");

  const manifest = manifestLines.join("\n") + "\n";
  const manifestKey = `clips/${streamId}/${clipId}.m3u8`;
  await minio.uploadBuffer(manifestKey, manifest, "application/vnd.apple.mpegurl");

  const hlsUrl = minio.clipHlsUrl(streamId, clipId);
  logger.info(
    `Created clip ${clipId} for ${streamId}: ${clipSegments.length} segments, ${actualDuration.toFixed(1)}s`,
  );

  // Generate MP4 (best-effort — clip works without it via HLS)
  let mp4Url: string | undefined;
  try {
    const segmentBuffers = await Promise.all(
      clipSegments.map(async (seg) => ({
        key: seg.key,
        data: await minio.downloadBuffer(seg.key),
      })),
    );
    const mp4Buffer = await convertSegmentsToMp4(segmentBuffers);
    const mp4Key = `clips/${streamId}/${clipId}.mp4`;
    await minio.uploadBuffer(mp4Key, mp4Buffer, "video/mp4");
    mp4Url = minio.clipMp4Url(streamId, clipId);
    logger.info(`Created MP4 for clip ${clipId} (${mp4Buffer.length} bytes)`);
  } catch (err) {
    logger.warn(err, `Failed to create MP4 for clip ${clipId} — HLS-only`);
  }

  return {
    id: clipId,
    streamId,
    hlsUrl,
    mp4Url,
    durationSeconds: Math.round(actualDuration * 10) / 10,
    createdAt: new Date().toISOString(),
    label,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
