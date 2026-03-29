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

/** Cached logo buffer (fetched once from altacourtside.se) */
let cachedLogo: Buffer | null = null;

async function fetchLogo(): Promise<Buffer | null> {
  if (cachedLogo) return cachedLogo;
  try {
    const res = await fetch("https://altacourtside.se/assets/icon.png");
    if (!res.ok) return null;
    cachedLogo = Buffer.from(await res.arrayBuffer());
    return cachedLogo;
  } catch {
    return null;
  }
}

/**
 * Extract a single JPEG thumbnail frame from an MP4 buffer,
 * with an optional logo overlay in the bottom-right corner.
 * @param mp4 - The MP4 file as a Buffer
 * @param offsetFromEnd - Seconds before the end to grab the frame (default: 2)
 * @returns JPEG image buffer
 */
export async function extractThumbnail(
  mp4: Buffer,
  offsetFromEnd = 2,
): Promise<Buffer> {
  const workDir = join(tmpdir(), `clip-thumb-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(workDir, { recursive: true });

  try {
    const inputPath = join(workDir, "input.mp4");
    const outputPath = join(workDir, "thumb.jpg");
    await writeFile(inputPath, mp4);

    // Probe duration via ffmpeg stderr
    const durationResult = await execFileAsync(ffmpegPath!, [
      "-i", inputPath,
      "-hide_banner",
    ], { timeout: 10_000 }).catch((err) => {
      const stderr = (err as { stderr?: string }).stderr || "";
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (match) {
        const h = parseFloat(match[1]);
        const m = parseFloat(match[2]);
        const s = parseFloat(match[3]);
        return { duration: h * 3600 + m * 60 + s };
      }
      return { duration: 0 };
    });

    const duration = "duration" in durationResult ? durationResult.duration : 8;
    const seekTo = Math.max(0, (duration as number) - offsetFromEnd);

    // Try to fetch logo for overlay
    const logo = await fetchLogo();
    const logoPath = join(workDir, "logo.png");
    if (logo) {
      await writeFile(logoPath, logo);
    }

    let usedOverlay = false;
    if (logo) {
      try {
        // Extract frame + overlay logo (100px wide, bottom-right with padding)
        await execFileAsync(ffmpegPath!, [
          "-y",
          "-ss", seekTo.toFixed(2),
          "-i", inputPath,
          "-i", logoPath,
          "-frames:v", "1",
          "-filter_complex",
          "[1:v]scale=100:-1[logo];[0:v][logo]overlay=W-w-20:H-h-16",
          "-q:v", "3",
          outputPath,
        ], { timeout: 15_000 });
        usedOverlay = true;
      } catch (overlayErr) {
        // Log and fall through to plain extraction
        console.warn("FFmpeg overlay failed, falling back to plain thumbnail:",
          (overlayErr as { stderr?: string }).stderr || String(overlayErr));
      }
    }

    if (!usedOverlay) {
      // Fallback: plain frame without logo
      await execFileAsync(ffmpegPath!, [
        "-y",
        "-ss", seekTo.toFixed(2),
        "-i", inputPath,
        "-frames:v", "1",
        "-q:v", "3",
        outputPath,
      ], { timeout: 10_000 });
    }

    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
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
