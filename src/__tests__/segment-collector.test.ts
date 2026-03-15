import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseSegments, SegmentCollector } from "../segment-collector.js";

// --- Mock helpers ---

function createMockMinio() {
  return {
    uploadBuffer: vi.fn().mockResolvedValue(undefined),
  };
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

const SAMPLE_MANIFEST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:42
#EXTINF:2.000000,
abc1234542.ts
#EXTINF:1.998000,
abc1234543.ts
#EXTINF:2.002000,
abc1234544.ts
`;

// --- parseSegments tests ---

describe("parseSegments", () => {
  it("extracts filenames and durations from HLS manifest", () => {
    const segments = parseSegments(SAMPLE_MANIFEST);
    expect(segments).toEqual([
      { filename: "abc1234542.ts", duration: 2.0 },
      { filename: "abc1234543.ts", duration: 1.998 },
      { filename: "abc1234544.ts", duration: 2.002 },
    ]);
  });

  it("returns empty array for manifest with no segments", () => {
    const manifest = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n`;
    expect(parseSegments(manifest)).toEqual([]);
  });

  it("handles manifest with extra HLS tags between EXTINF and filename", () => {
    const manifest = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-03-15T12:00:00Z
seg001.ts
`;
    const segments = parseSegments(manifest);
    expect(segments).toEqual([{ filename: "seg001.ts", duration: 2.0 }]);
  });

  it("defaults duration to 2.0 if EXTINF value is malformed", () => {
    const manifest = `#EXTINF:bad,\nseg.ts\n`;
    const segments = parseSegments(manifest);
    expect(segments).toEqual([{ filename: "seg.ts", duration: 2.0 }]);
  });
});

// --- SegmentCollector tests ---

describe("SegmentCollector", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createCollector(partNumber = 1) {
    const minio = createMockMinio();
    const collector = new SegmentCollector(
      "stream1",
      "https://restreamer.example.com",
      minio as any,
      mockLogger,
      partNumber,
    );
    return { collector, minio };
  }

  function manifestResponse(body: string) {
    return new Response(body, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
  }

  function segmentResponse(size: number) {
    return new Response(new ArrayBuffer(size), { status: 200 });
  }

  it("polls manifest and saves new segments", async () => {
    const { collector, minio } = createCollector();

    fetchSpy
      .mockResolvedValueOnce(manifestResponse(SAMPLE_MANIFEST))
      .mockResolvedValueOnce(segmentResponse(1000))
      .mockResolvedValueOnce(segmentResponse(1000))
      .mockResolvedValueOnce(segmentResponse(1000));

    await collector.pollOnce();

    expect(fetchSpy).toHaveBeenCalledTimes(4); // 1 manifest + 3 segments
    expect(minio.uploadBuffer).toHaveBeenCalledTimes(3);
    expect(minio.uploadBuffer).toHaveBeenCalledWith(
      "stream1/p1_abc1234542.ts",
      expect.any(Buffer),
      "video/mp2t",
    );
  });

  it("skips already-saved segments on subsequent polls", async () => {
    const { collector, minio } = createCollector();

    // First poll: 2 segments
    const manifest2 = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000000,\nseg01.ts\n#EXTINF:2.000000,\nseg02.ts\n`;
    fetchSpy
      .mockResolvedValueOnce(manifestResponse(manifest2))
      .mockResolvedValueOnce(segmentResponse(500))
      .mockResolvedValueOnce(segmentResponse(500));

    await collector.pollOnce();
    expect(minio.uploadBuffer).toHaveBeenCalledTimes(2);

    // Second poll: same 2 segments + 1 new
    const manifest3 = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000000,\nseg01.ts\n#EXTINF:2.000000,\nseg02.ts\n#EXTINF:2.000000,\nseg03.ts\n`;
    fetchSpy
      .mockResolvedValueOnce(manifestResponse(manifest3))
      .mockResolvedValueOnce(segmentResponse(500));

    await collector.pollOnce();
    expect(minio.uploadBuffer).toHaveBeenCalledTimes(3); // only 1 new
    expect(minio.uploadBuffer).toHaveBeenLastCalledWith(
      "stream1/p1_seg03.ts",
      expect.any(Buffer),
      "video/mp2t",
    );
  });

  it("stop() builds and uploads a valid VOD part manifest", async () => {
    const { collector, minio } = createCollector();

    const manifest = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000000,\nseg01.ts\n#EXTINF:1.998000,\nseg02.ts\n`;
    fetchSpy
      .mockResolvedValueOnce(manifestResponse(manifest))
      .mockResolvedValueOnce(segmentResponse(500))
      .mockResolvedValueOnce(segmentResponse(500));

    await collector.pollOnce();

    // Final poll on stop returns no new segments
    fetchSpy.mockResolvedValueOnce(manifestResponse(manifest));

    const key = await collector.stop();
    expect(key).toBe("stream1/p1.m3u8");

    // Find the manifest upload call
    const m3u8Call = minio.uploadBuffer.mock.calls.find(
      (c: any[]) => (c[0] as string).endsWith(".m3u8"),
    );
    expect(m3u8Call).toBeDefined();

    const playlist = m3u8Call![1] as string;
    expect(playlist).toContain("#EXTM3U");
    expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(playlist).toContain("#EXT-X-TARGETDURATION:2");
    expect(playlist).toContain("#EXTINF:2.000000,");
    expect(playlist).toContain("p1_seg01.ts");
    expect(playlist).toContain("#EXTINF:1.998000,");
    expect(playlist).toContain("p1_seg02.ts");
    expect(playlist).toContain("#EXT-X-ENDLIST");
  });

  it("stop() returns null when no segments were collected", async () => {
    const { collector, minio } = createCollector();

    // Final poll returns 404
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const key = await collector.stop();
    expect(key).toBeNull();

    // No manifest uploaded
    const m3u8Calls = minio.uploadBuffer.mock.calls.filter(
      (c: any[]) => (c[0] as string).endsWith(".m3u8"),
    );
    expect(m3u8Calls).toHaveLength(0);
  });

  it("skips failed segment downloads without crashing", async () => {
    const { collector, minio } = createCollector();

    const manifest = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000000,\nseg01.ts\n#EXTINF:2.000000,\nseg02.ts\n`;

    fetchSpy
      .mockResolvedValueOnce(manifestResponse(manifest))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))  // seg01 fails
      .mockResolvedValueOnce(segmentResponse(500));                // seg02 succeeds

    await collector.pollOnce();

    // Only seg02 saved
    expect(minio.uploadBuffer).toHaveBeenCalledTimes(1);
    expect(minio.uploadBuffer).toHaveBeenCalledWith(
      "stream1/p1_seg02.ts",
      expect.any(Buffer),
      "video/mp2t",
    );
  });

  it("handles manifest fetch failure gracefully", async () => {
    const { collector, minio } = createCollector();

    fetchSpy.mockRejectedValueOnce(new Error("network timeout"));

    await collector.pollOnce();

    expect(minio.uploadBuffer).not.toHaveBeenCalled();
  });

  it("pause() builds part manifest same as stop()", async () => {
    const { collector, minio } = createCollector(2);

    const manifest = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000000,\nseg10.ts\n`;
    fetchSpy
      .mockResolvedValueOnce(manifestResponse(manifest))
      .mockResolvedValueOnce(segmentResponse(300));

    await collector.pollOnce();

    // Final poll on pause
    fetchSpy.mockResolvedValueOnce(manifestResponse(manifest));

    const key = await collector.pause();
    expect(key).toBe("stream1/p2.m3u8");

    const m3u8Call = minio.uploadBuffer.mock.calls.find(
      (c: any[]) => (c[0] as string).endsWith(".m3u8"),
    );
    const playlist = m3u8Call![1] as string;
    expect(playlist).toContain("p2_seg10.ts");
    expect(playlist).toContain("#EXT-X-ENDLIST");
  });

  it("isRunning() reflects collector state", () => {
    const { collector } = createCollector();

    expect(collector.isRunning()).toBe(false);
    collector.start();
    expect(collector.isRunning()).toBe(true);
  });

  it("handles MinIO upload failure per segment", async () => {
    const { collector, minio } = createCollector();

    const manifest = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000000,\nseg01.ts\n#EXTINF:2.000000,\nseg02.ts\n`;
    fetchSpy
      .mockResolvedValueOnce(manifestResponse(manifest))
      .mockResolvedValueOnce(segmentResponse(500))
      .mockResolvedValueOnce(segmentResponse(500));

    minio.uploadBuffer
      .mockRejectedValueOnce(new Error("S3 error"))  // seg01 upload fails
      .mockResolvedValueOnce(undefined);              // seg02 upload succeeds

    await collector.pollOnce();

    // Both segments attempted, only seg02 actually saved
    expect(minio.uploadBuffer).toHaveBeenCalledTimes(2);
  });
});
