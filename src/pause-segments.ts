/**
 * Uploads pre-rendered "PAUS" HLS segments to MinIO.
 * Used when a stream is paused to insert a visual pause marker
 * into the recording between periods.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { MinioClient } from "./minio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAUSE_SEGMENT_PATH = path.join(__dirname, "..", "assets", "pause_segment.ts");

/** Cached pause segment buffer (loaded once on first use) */
let pauseSegmentBuffer: Buffer | null = null;

function getPauseSegment(): Buffer {
  if (!pauseSegmentBuffer) {
    pauseSegmentBuffer = readFileSync(PAUSE_SEGMENT_PATH);
  }
  return pauseSegmentBuffer;
}

/**
 * Upload pause marker segments and playlist to MinIO.
 * Creates: {streamId}/pause{N}_seg_00000.ts + {streamId}/pause{N}.m3u8
 */
export async function uploadPauseSegments(
  minio: MinioClient,
  streamId: string,
  pauseNumber: number,
  segmentCount = 1
): Promise<void> {
  const segment = getPauseSegment();

  // Upload segment(s)
  for (let i = 0; i < segmentCount; i++) {
    const segKey = `${streamId}/pause${pauseNumber}_seg_${String(i).padStart(5, "0")}.ts`;
    await minio.uploadBuffer(segKey, segment, "video/mp2t");
  }

  // Build and upload the pause playlist
  let playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n";
  for (let i = 0; i < segmentCount; i++) {
    playlist += `#EXTINF:4.000000,\npause${pauseNumber}_seg_${String(i).padStart(5, "0")}.ts\n`;
  }
  playlist += "#EXT-X-ENDLIST\n";

  const playlistKey = `${streamId}/pause${pauseNumber}.m3u8`;
  await minio.uploadBuffer(playlistKey, playlist, "application/vnd.apple.mpegurl");
}
