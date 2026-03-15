/**
 * Segment Collector — polls Restreamer's live HLS manifest, downloads new
 * .ts segments, and uploads them to MinIO.  Builds a VOD part-manifest on
 * stop/pause so the existing playlist-stitcher can produce index.m3u8.
 */
import type { MinioClient } from "./minio.js";
import type { FastifyBaseLogger } from "fastify";

interface SegmentInfo {
  filename: string;
  duration: number;
}

/** Parse #EXTINF + segment filename pairs from an HLS media playlist. */
export function parseSegments(manifest: string): SegmentInfo[] {
  const lines = manifest.split("\n");
  const segments: SegmentInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXTINF:")) {
      const duration = parseFloat(line.slice(8)) || 2.0;
      // Next non-empty, non-comment line is the segment URI
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith("#")) {
          // Strip query params (e.g. ?session=xxx) — keep only the filename
          const filename = next.split("?")[0];
          segments.push({ filename, duration });
          i = j;
          break;
        }
      }
    }
  }
  return segments;
}

/**
 * Restreamer serves a master playlist that redirects to a media playlist
 * via #EXT-X-STREAM-INF. Detect this and return the media playlist URL.
 * Returns null if the manifest is already a media playlist.
 */
export function extractMediaPlaylistUrl(manifest: string, baseUrl: string): string | null {
  const lines = manifest.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("#EXT-X-STREAM-INF")) {
      // Next non-empty line is the variant URI
      for (let j = i + 1; j < lines.length; j++) {
        const uri = lines[j].trim();
        if (uri && !uri.startsWith("#")) {
          // URI may be relative (e.g. "dc21e849.m3u8?session=xxx")
          return `${baseUrl}/${uri}`;
        }
      }
    }
  }
  return null;
}

export class SegmentCollector {
  private streamId: string;
  private manifestUrl: string;
  private segmentBaseUrl: string;
  private minio: MinioClient;
  private logger: FastifyBaseLogger;
  private partNumber: number;

  private savedSegments = new Set<string>();
  private segmentOrder: SegmentInfo[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly pollIntervalMs = 2000;
  /** Resolved media playlist URL (discovered from master playlist on first poll) */
  private mediaPlaylistUrl: string | null = null;

  constructor(
    streamId: string,
    restreamerBaseUrl: string,
    minio: MinioClient,
    logger: FastifyBaseLogger,
    partNumber = 1,
  ) {
    this.streamId = streamId;
    this.manifestUrl = `${restreamerBaseUrl}/memfs/${streamId}.m3u8`;
    this.segmentBaseUrl = `${restreamerBaseUrl}/memfs/`;
    this.minio = minio;
    this.logger = logger;
    this.partNumber = partNumber;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info(`SegmentCollector started for ${this.streamId} part ${this.partNumber}`);
    this.pollTimer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
  }

  async stop(): Promise<string | null> {
    this.stopTimer();
    await this.pollOnce(); // final poll
    return this.buildAndUploadManifest();
  }

  async pause(): Promise<string | null> {
    this.stopTimer();
    await this.pollOnce(); // final poll
    return this.buildAndUploadManifest();
  }

  isRunning(): boolean {
    return this.running;
  }

  // --- private ---

  private stopTimer(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollOnce(): Promise<void> {
    // Step 1: Resolve media playlist URL (handles master → media redirect)
    const playlistUrl = await this.resolveMediaPlaylistUrl();
    if (!playlistUrl) return;

    // Step 2: Fetch the media playlist
    let manifestText: string;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(playlistUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        if (res.status !== 404) {
          this.logger.warn(`Media playlist fetch ${res.status} for ${this.streamId}`);
        }
        return;
      }
      manifestText = await res.text();
    } catch (err) {
      this.logger.warn(err, `Media playlist fetch failed for ${this.streamId}`);
      return;
    }

    // Step 3: Parse and download new segments
    const segments = parseSegments(manifestText);
    const newSegments = segments.filter((s) => !this.savedSegments.has(s.filename));

    for (const seg of newSegments) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${this.segmentBaseUrl}${seg.filename}`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
          this.logger.warn(`Segment download ${res.status}: ${seg.filename}`);
          continue;
        }
        const ab = await res.arrayBuffer();
        const key = `${this.streamId}/p${this.partNumber}_${seg.filename}`;
        await this.minio.uploadBuffer(key, Buffer.from(ab), "video/mp2t");

        this.savedSegments.add(seg.filename);
        this.segmentOrder.push(seg);
        this.logger.info(`Saved segment ${seg.filename} (${ab.byteLength} bytes)`);
      } catch (err) {
        this.logger.warn(err, `Failed to save segment ${seg.filename}`);
      }
    }
  }

  /**
   * Resolve the actual media playlist URL. On first call, fetches the master
   * playlist to discover the variant URL with session token. Caches the result.
   */
  private async resolveMediaPlaylistUrl(): Promise<string | null> {
    if (this.mediaPlaylistUrl) return this.mediaPlaylistUrl;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(this.manifestUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        if (res.status !== 404) {
          this.logger.warn(`Manifest fetch ${res.status} for ${this.streamId}`);
        }
        return null;
      }
      const text = await res.text();

      // Check if this is a master playlist (contains #EXT-X-STREAM-INF)
      const mediaUrl = extractMediaPlaylistUrl(text, this.segmentBaseUrl.replace(/\/$/, ""));
      if (mediaUrl) {
        this.mediaPlaylistUrl = mediaUrl;
        this.logger.info(`Resolved media playlist: ${mediaUrl}`);
        return mediaUrl;
      }

      // It's already a media playlist — use the original URL
      this.mediaPlaylistUrl = this.manifestUrl;
      return this.manifestUrl;
    } catch (err) {
      this.logger.warn(err, `Manifest resolve failed for ${this.streamId}`);
      return null;
    }
  }

  private async buildAndUploadManifest(): Promise<string | null> {
    if (this.segmentOrder.length === 0) {
      this.logger.info(`No segments collected for ${this.streamId} part ${this.partNumber}`);
      return null;
    }

    const maxDuration = Math.ceil(
      Math.max(...this.segmentOrder.map((s) => s.duration)),
    );

    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      `#EXT-X-TARGETDURATION:${maxDuration}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
    ];

    for (const seg of this.segmentOrder) {
      lines.push(`#EXTINF:${seg.duration.toFixed(6)},`);
      lines.push(`p${this.partNumber}_${seg.filename}`);
    }

    lines.push("#EXT-X-ENDLIST");

    const manifest = lines.join("\n") + "\n";
    const key = `${this.streamId}/p${this.partNumber}.m3u8`;
    await this.minio.uploadBuffer(key, manifest, "application/vnd.apple.mpegurl");
    this.logger.info(`Uploaded part manifest ${key} (${this.segmentOrder.length} segments)`);
    return key;
  }
}
