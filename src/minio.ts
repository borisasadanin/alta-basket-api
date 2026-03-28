import {
  S3Client,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { VodEntry, HighlightClip } from "./types.js";

const BUCKET = "recordings";
const VOD_INDEX_KEY = "vod-index.json";
const CLIPS_INDEX_KEY = "clips-index.json";

export class MinioClient {
  private s3: S3Client;
  private endpoint: string;

  /** Async mutex to prevent concurrent read-modify-write on vod-index.json */
  private writeLock: Promise<void> = Promise.resolve();

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const acquired = new Promise<void>((r) => { release = r; });
    const prev = this.writeLock;
    this.writeLock = acquired;
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  constructor(endpoint: string, accessKey: string, secretKey: string) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.s3 = new S3Client({
      endpoint: this.endpoint,
      region: "us-east-1",
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle: true, // Required for MinIO
    });
  }

  /** Ensure the "recordings" bucket exists with public-read policy */
  async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    }

    // Set public-read policy so HLS segments are accessible from browsers
    const policy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "PublicRead",
          Effect: "Allow",
          Principal: "*",
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${BUCKET}/*`],
        },
      ],
    };

    await this.s3.send(
      new PutBucketPolicyCommand({
        Bucket: BUCKET,
        Policy: JSON.stringify(policy),
      })
    );
  }

  /** Read the VOD index from MinIO. Returns [] if not found. */
  async readVodIndex(): Promise<VodEntry[]> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: VOD_INDEX_KEY })
      );
      const body = await res.Body?.transformToString();
      return body ? JSON.parse(body) : [];
    } catch {
      return [];
    }
  }

  /** Write the VOD index to MinIO. */
  async writeVodIndex(entries: VodEntry[]): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: VOD_INDEX_KEY,
        Body: JSON.stringify(entries, null, 2),
        ContentType: "application/json",
      })
    );
  }

  /** Add a new VOD entry and persist (mutex-protected). */
  async addVodEntry(entry: VodEntry): Promise<void> {
    return this.withLock(async () => {
      const entries = await this.readVodIndex();
      entries.push(entry);
      await this.writeVodIndex(entries);
    });
  }

  /** Update an existing VOD entry (by id) and persist (mutex-protected). */
  async updateVodEntry(
    id: string,
    update: Partial<VodEntry>
  ): Promise<void> {
    return this.withLock(async () => {
      const entries = await this.readVodIndex();
      const idx = entries.findIndex((e) => e.id === id);
      if (idx !== -1) {
        entries[idx] = { ...entries[idx], ...update };
        await this.writeVodIndex(entries);
      }
    });
  }

  /** Remove a VOD entry by id and persist (mutex-protected). */
  async removeVodEntry(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const entries = await this.readVodIndex();
      const filtered = entries.filter((e) => e.id !== id);
      if (filtered.length === entries.length) return false;
      await this.writeVodIndex(filtered);
      return true;
    });
  }

  // ============================
  // Clips index (persistent, like VOD index)
  // ============================

  /** Read the clips index from MinIO. Returns [] if not found. */
  async readClipsIndex(): Promise<HighlightClip[]> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: CLIPS_INDEX_KEY })
      );
      const body = await res.Body?.transformToString();
      return body ? JSON.parse(body) : [];
    } catch {
      return [];
    }
  }

  /** Write the clips index to MinIO. */
  async writeClipsIndex(entries: HighlightClip[]): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: CLIPS_INDEX_KEY,
        Body: JSON.stringify(entries, null, 2),
        ContentType: "application/json",
      })
    );
  }

  /** Add a new clip entry and persist (mutex-protected). */
  async addClipEntry(entry: HighlightClip): Promise<void> {
    return this.withLock(async () => {
      const entries = await this.readClipsIndex();
      entries.push(entry);
      await this.writeClipsIndex(entries);
    });
  }

  /** Public URL for an HLS recording in the recordings bucket */
  hlsUrl(streamId: string): string {
    return `${this.endpoint}/${BUCKET}/${streamId}/index.m3u8`;
  }

  /** Public URL for a highlight clip manifest */
  clipHlsUrl(streamId: string, clipId: string): string {
    return `${this.endpoint}/${BUCKET}/clips/${streamId}/${clipId}.m3u8`;
  }

  /** Public URL for a highlight clip MP4 */
  clipMp4Url(streamId: string, clipId: string): string {
    return `${this.endpoint}/${BUCKET}/clips/${streamId}/${clipId}.mp4`;
  }

  /** Public URL for a segment in the recordings bucket */
  segmentUrl(key: string): string {
    return `${this.endpoint}/${BUCKET}/${key}`;
  }

  /** Get total size of all objects under a prefix (streamId/) in bytes */
  async getVodSize(streamId: string): Promise<number> {
    let totalSize = 0;
    let continuationToken: string | undefined;

    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: `${streamId}/`,
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of res.Contents || []) {
        totalSize += obj.Size || 0;
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);

    return totalSize;
  }

  /** Get storage info: total used bytes and per-VOD sizes */
  async getStorageInfo(
    vodEntries: VodEntry[]
  ): Promise<{ totalBytes: number; vods: { id: string; sizeBytes: number }[] }> {
    const vods: { id: string; sizeBytes: number }[] = [];
    let totalBytes = 0;

    await Promise.all(
      vodEntries.map(async (entry) => {
        const size = await this.getVodSize(entry.id);
        vods.push({ id: entry.id, sizeBytes: size });
        totalBytes += size;
      })
    );

    return { totalBytes, vods };
  }

  /** Upload a raw buffer to a key in the recordings bucket */
  async uploadBuffer(key: string, body: Buffer | string, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
  }

  /** Download a file from the recordings bucket as a Buffer */
  async downloadBuffer(key: string): Promise<Buffer> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key })
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty response for key: ${key}`);
    return Buffer.from(bytes);
  }

  /** Read a text file from the recordings bucket. Returns null if not found. */
  async readFile(key: string): Promise<string | null> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key })
      );
      return (await res.Body?.transformToString()) ?? null;
    } catch {
      return null;
    }
  }

  /** Delete all objects under a prefix (streamId/) */
  async deleteVodFiles(streamId: string): Promise<number> {
    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      const listRes = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: `${streamId}/`,
          ContinuationToken: continuationToken,
        })
      );

      const objects = listRes.Contents || [];
      if (objects.length === 0) break;

      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: {
            Objects: objects.map((o) => ({ Key: o.Key })),
            Quiet: true,
          },
        })
      );

      deleted += objects.length;
      continuationToken = listRes.NextContinuationToken;
    } while (continuationToken);

    return deleted;
  }
}
