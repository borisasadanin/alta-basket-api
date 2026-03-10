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
import type { VodEntry } from "./types.js";

const BUCKET = "recordings";
const VOD_INDEX_KEY = "vod-index.json";

export class MinioClient {
  private s3: S3Client;
  private endpoint: string;

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

  /** Add a new VOD entry and persist. */
  async addVodEntry(entry: VodEntry): Promise<void> {
    const entries = await this.readVodIndex();
    entries.push(entry);
    await this.writeVodIndex(entries);
  }

  /** Update an existing VOD entry (by id) and persist. */
  async updateVodEntry(
    id: string,
    update: Partial<VodEntry>
  ): Promise<void> {
    const entries = await this.readVodIndex();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx !== -1) {
      entries[idx] = { ...entries[idx], ...update };
      await this.writeVodIndex(entries);
    }
  }

  /** Public URL for an HLS recording in the recordings bucket */
  hlsUrl(streamId: string): string {
    return `${this.endpoint}/${BUCKET}/${streamId}/index.m3u8`;
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
