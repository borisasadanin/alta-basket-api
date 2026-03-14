/**
 * Stitches multi-part HLS recordings into a single master playlist.
 * Each recording part (p1.m3u8, p2.m3u8, ...) and pause marker
 * (pause1.m3u8, ...) is combined with #EXT-X-DISCONTINUITY between them.
 */
import type { MinioClient } from "./minio.js";

export interface PartInfo {
  type: "recording" | "pause";
  number: number;
}

/**
 * Build the ordered list of parts for a stream.
 * Example: completedParts=[1,2], partNumber=3
 *   → [p1, pause1, p2, pause2, p3]
 */
export function buildPartList(completedParts: number[], currentPartNumber: number): PartInfo[] {
  const allParts = [...completedParts];
  if (!allParts.includes(currentPartNumber)) {
    allParts.push(currentPartNumber);
  }
  allParts.sort((a, b) => a - b);

  const parts: PartInfo[] = [];
  for (let i = 0; i < allParts.length; i++) {
    parts.push({ type: "recording", number: allParts[i] });
    if (i < allParts.length - 1) {
      parts.push({ type: "pause", number: allParts[i] });
    }
  }
  return parts;
}

/**
 * Read all part playlists from MinIO and combine into one master playlist.
 * Writes the result as {streamId}/index.m3u8.
 */
export async function stitchPlaylist(
  minio: MinioClient,
  streamId: string,
  parts: PartInfo[]
): Promise<void> {
  let maxTargetDuration = 4;
  const segmentBlocks: string[] = [];

  for (const part of parts) {
    const prefix = part.type === "recording" ? "p" : "pause";
    const playlistKey = `${streamId}/${prefix}${part.number}.m3u8`;

    const content = await minio.readFile(playlistKey);
    if (!content) continue; // Part missing — skip (might be a very short part)

    // Parse target duration
    const tdMatch = content.match(/#EXT-X-TARGETDURATION:(\d+)/);
    if (tdMatch) {
      maxTargetDuration = Math.max(maxTargetDuration, parseInt(tdMatch[1]));
    }

    // Extract segment entries (EXTINF + filename + optional program-date-time)
    const lines = content.split("\n");
    const block: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("#EXTINF:")) {
        block.push(line);
        // Next line is the segment filename
        if (i + 1 < lines.length) {
          block.push(lines[i + 1].trim());
          i++;
        }
      } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
        block.push(line);
      }
    }

    if (block.length > 0) {
      segmentBlocks.push(block.join("\n"));
    }
  }

  if (segmentBlocks.length === 0) return; // Nothing to stitch

  // Combine with discontinuity markers between parts
  const body = segmentBlocks.join("\n#EXT-X-DISCONTINUITY\n");

  const master =
    `#EXTM3U\n` +
    `#EXT-X-VERSION:3\n` +
    `#EXT-X-PLAYLIST-TYPE:VOD\n` +
    `#EXT-X-TARGETDURATION:${maxTargetDuration}\n` +
    `#EXT-X-MEDIA-SEQUENCE:0\n` +
    `${body}\n` +
    `#EXT-X-ENDLIST\n`;

  await minio.uploadBuffer(
    `${streamId}/index.m3u8`,
    master,
    "application/vnd.apple.mpegurl"
  );
}
