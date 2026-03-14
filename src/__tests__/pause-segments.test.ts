import { describe, it, expect, vi } from "vitest";
import { uploadPauseSegments } from "../pause-segments.js";

// Create a minimal mock MinIO client
function createMockMinio() {
  return {
    uploadBuffer: vi.fn().mockResolvedValue(undefined),
  };
}

describe("uploadPauseSegments", () => {
  it("uploads segment and playlist to correct keys", async () => {
    const minio = createMockMinio();
    await uploadPauseSegments(minio as any, "abc123", 1);

    // Should upload 1 segment + 1 playlist = 2 calls
    expect(minio.uploadBuffer).toHaveBeenCalledTimes(2);

    // Segment upload
    expect(minio.uploadBuffer).toHaveBeenCalledWith(
      "abc123/pause1_seg_00000.ts",
      expect.any(Buffer),
      "video/mp2t"
    );

    // Playlist upload
    expect(minio.uploadBuffer).toHaveBeenCalledWith(
      "abc123/pause1.m3u8",
      expect.stringContaining("#EXTM3U"),
      "application/vnd.apple.mpegurl"
    );
  });

  it("uploads correct number of segments when segmentCount > 1", async () => {
    const minio = createMockMinio();
    await uploadPauseSegments(minio as any, "test-stream", 2, 3);

    // Should upload 3 segments + 1 playlist = 4 calls
    expect(minio.uploadBuffer).toHaveBeenCalledTimes(4);

    // Check segment keys
    expect(minio.uploadBuffer).toHaveBeenCalledWith(
      "test-stream/pause2_seg_00000.ts",
      expect.any(Buffer),
      "video/mp2t"
    );
    expect(minio.uploadBuffer).toHaveBeenCalledWith(
      "test-stream/pause2_seg_00001.ts",
      expect.any(Buffer),
      "video/mp2t"
    );
    expect(minio.uploadBuffer).toHaveBeenCalledWith(
      "test-stream/pause2_seg_00002.ts",
      expect.any(Buffer),
      "video/mp2t"
    );
  });

  it("generates a valid HLS playlist", async () => {
    const minio = createMockMinio();
    await uploadPauseSegments(minio as any, "abc", 1);

    // Get the playlist content from the last call
    const playlistCall = minio.uploadBuffer.mock.calls.find(
      (c: any[]) => (c[0] as string).endsWith(".m3u8")
    );
    expect(playlistCall).toBeDefined();

    const playlist = playlistCall![1] as string;
    expect(playlist).toContain("#EXTM3U");
    expect(playlist).toContain("#EXT-X-TARGETDURATION:4");
    expect(playlist).toContain("#EXTINF:4.000000,");
    expect(playlist).toContain("pause1_seg_00000.ts");
    expect(playlist).toContain("#EXT-X-ENDLIST");
  });
});
