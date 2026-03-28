/**
 * MP4 Converter — remuxes .ts segments into a single MP4 file.
 *
 * Uses ffmpeg-static (no system ffmpeg required) with codec copy
 * (no re-encoding) so conversion takes < 1 second for ~10s clips.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

// ffmpeg-static exports the path to the ffmpeg binary
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ffmpegPath: string = require("ffmpeg-static");

export interface SegmentInput {
  key: string;
  data: Buffer;
}

/**
 * Convert an ordered list of .ts segment buffers into a single MP4 buffer.
 * Uses ffmpeg concat demuxer with -c copy (remux, no re-encoding).
 */
export async function convertSegmentsToMp4(
  segments: SegmentInput[],
): Promise<Buffer> {
  if (segments.length === 0) {
    throw new Error("No segments to convert");
  }

  // Create a unique temp directory for this conversion
  const workDir = join(tmpdir(), `clip-mp4-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(workDir, { recursive: true });

  try {
    // Write segments to temp files
    const segFiles: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const segPath = join(workDir, `seg${i}.ts`);
      await writeFile(segPath, segments[i].data);
      segFiles.push(segPath);
    }

    // Create ffmpeg concat list
    const concatContent = segFiles.map((f) => `file '${f}'`).join("\n") + "\n";
    const concatPath = join(workDir, "concat.txt");
    await writeFile(concatPath, concatContent);

    // Output path
    const outputPath = join(workDir, "output.mp4");

    // Run ffmpeg: remux .ts segments into MP4
    await execFileAsync(ffmpegPath!, [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath,
    ]);

    // Read the resulting MP4
    return await readFile(outputPath);
  } finally {
    // Clean up temp directory
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
