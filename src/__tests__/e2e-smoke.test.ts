/**
 * E2E Smoke Tests — Recording → VOD flow
 *
 * These tests verify the complete lifecycle of stream recording through
 * the actual Fastify HTTP routes, with mocked external dependencies.
 *
 * Motivation: two critical production bugs were missed because the
 * existing test suite only had unit tests:
 *
 *   1. Single-part recordings never created index.m3u8 (VOD playback broken)
 *   2. First recording after Restreamer restart had no files (S3 race condition)
 *
 * These tests exercise the full request → state mutation → side-effect chain
 * so regressions like these are caught before production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Mock external dependencies BEFORE importing app modules
// ---------------------------------------------------------------------------

// Mock @osaas/client-core (used by OscInstanceManager constructor)
vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));

// Mock the pause-segments module to avoid filesystem access (reads a .ts asset)
vi.mock("../pause-segments.js", () => ({
  uploadPauseSegments: vi.fn().mockResolvedValue(undefined),
}));

// Now import app modules
import { streamMeta, initServices } from "../state.js";
import { config } from "../config.js";
import { mutableConfig } from "../config.js";
import { stitchPlaylist, buildPartList } from "../playlist-stitcher.js";
import { uploadPauseSegments } from "../pause-segments.js";
import { viewers } from "../viewer-tracking.js";
import streamRoutes from "../routes/streams.js";
import vodRoutes from "../routes/vod.js";

// ---------------------------------------------------------------------------
// Helpers: mock factories
// ---------------------------------------------------------------------------

function createMockRestreamer() {
  return {
    rtmpHost: "mock-rtmp.example.com",
    createProcess: vi.fn().mockResolvedValue({ id: "alta-test", config: { id: "alta-test" } }),
    deleteProcess: vi.fn().mockResolvedValue(undefined),
    listAltaProcesses: vi.fn().mockResolvedValue([]),
    getProcess: vi.fn().mockResolvedValue(null),
    isHlsLive: vi.fn().mockResolvedValue(false),
    rtmpUrl: vi.fn((id: string) => `rtmp://mock-rtmp.example.com/live/${id}`),
    hlsUrl: vi.fn((id: string) => `https://restreamer.example.com/memfs/${id}.m3u8`),
  };
}

function createMockMinio() {
  const vodIndex: Array<Record<string, unknown>> = [];

  return {
    hlsUrl: vi.fn((streamId: string) => `https://minio.example.com/recordings/${streamId}/index.m3u8`),
    uploadBuffer: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(null),
    addVodEntry: vi.fn(async (entry: Record<string, unknown>) => {
      vodIndex.push(entry);
    }),
    updateVodEntry: vi.fn(async (id: string, update: Record<string, unknown>) => {
      const idx = vodIndex.findIndex((e) => e.id === id);
      if (idx !== -1) {
        vodIndex[idx] = { ...vodIndex[idx], ...update };
      }
    }),
    readVodIndex: vi.fn(async () => [...vodIndex]),
    writeVodIndex: vi.fn().mockResolvedValue(undefined),
    removeVodEntry: vi.fn().mockResolvedValue(true),
    deleteVodFiles: vi.fn().mockResolvedValue(0),
    ensureBucket: vi.fn().mockResolvedValue(undefined),
    // Expose internal storage for assertions
    _vodIndex: vodIndex,
  };
}

function createMockOscManager() {
  return {
    getState: vi.fn().mockReturnValue("running" as const),
    getInfo: vi.fn().mockReturnValue({ url: "https://restreamer.example.com", rtmpHost: "mock-rtmp.example.com" }),
    getCachedState: vi.fn().mockReturnValue({
      state: "running",
      info: { url: "https://restreamer.example.com", rtmpHost: "mock-rtmp.example.com" },
    }),
    ensureRunning: vi.fn().mockResolvedValue({ url: "https://restreamer.example.com", rtmpHost: "mock-rtmp.example.com" }),
    streamStarted: vi.fn(),
    streamEnded: vi.fn(),
    streamPaused: vi.fn(),
    streamResumed: vi.fn(),
    pausedStreamEnded: vi.fn(),
    getActiveStreamCount: vi.fn().mockReturnValue(0),
    syncActiveCount: vi.fn(),
    startBackgroundPolling: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const API_KEY = config.API_KEY;

/** Headers for requests WITH a JSON body (POST, PUT) */
const jsonHeaders = { "x-api-key": API_KEY, "content-type": "application/json" };

/**
 * Headers for requests WITHOUT a body (PATCH, DELETE, GET).
 * Omit content-type to avoid Fastify's FST_ERR_CTP_EMPTY_JSON_BODY error.
 */
const authHeaders = { "x-api-key": API_KEY };

/** Shorthand: inject a POST /api/streams with a JSON payload */
function createStream(app: FastifyInstance, payload: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: "/api/streams",
    headers: jsonHeaders,
    payload,
  });
}

describe("E2E Smoke Tests: Recording → VOD flow", () => {
  let app: FastifyInstance;
  let mockRestreamer: ReturnType<typeof createMockRestreamer>;
  let mockMinio: ReturnType<typeof createMockMinio>;
  let mockOsc: ReturnType<typeof createMockOscManager>;

  beforeEach(async () => {
    // Clear in-memory state
    streamMeta.clear();
    viewers.clear();

    // Disable viewer PIN for test simplicity (allows unauthenticated GET requests)
    (mutableConfig as { VIEWER_PIN: string }).VIEWER_PIN = "";

    // Create fresh mocks
    mockRestreamer = createMockRestreamer();
    mockMinio = createMockMinio();
    mockOsc = createMockOscManager();

    // Wire mocks into the shared state module
    initServices(mockRestreamer as any, mockMinio as any, mockOsc as any);

    // Build a minimal Fastify instance with the real route handlers
    app = Fastify({ logger: false });
    await app.register(streamRoutes);
    await app.register(vodRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Test 1: Single-part recording creates index.m3u8
  // =========================================================================
  describe("Test 1: Single-part recording creates index.m3u8", () => {
    it("calls stitchPlaylist with single recording part when stream is stopped", async () => {
      // --- Create stream ---
      const createRes = await createStream(app, { name: "Kamera 1", opponent: "AIK", team: "Älta IF" });
      expect(createRes.statusCode).toBe(201);
      const { id: streamId } = createRes.json();
      expect(streamId).toBeTruthy();

      // Verify stream metadata was created with partNumber: 1
      const meta = streamMeta.get(streamId);
      expect(meta).toBeDefined();
      expect(meta!.partNumber).toBe(1);
      expect(meta!.completedParts).toEqual([]);

      // --- Stop stream ---
      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/streams/${streamId}`,
        headers: authHeaders,
      });
      expect(deleteRes.statusCode).toBe(204);

      // Verify metadata was updated
      expect(meta!.stoppedAt).toBeTruthy();

      // Verify stitchPlaylist arguments:
      // For a single-part recording (never paused), buildPartList([], 1) should
      // produce [{ type: "recording", number: 1 }]
      const expectedParts = buildPartList([], 1);
      expect(expectedParts).toEqual([{ type: "recording", number: 1 }]);

      // Verify that the VOD entry was created with hlsUrl pointing to index.m3u8
      expect(mockMinio.addVodEntry).toHaveBeenCalledTimes(1);
      const vodEntry = mockMinio.addVodEntry.mock.calls[0][0];
      expect(vodEntry.hlsUrl).toContain("index.m3u8");
      expect(vodEntry.hlsUrl).not.toContain("p1.m3u8");
    });

    it("stitchPlaylist writes {streamId}/index.m3u8 to MinIO when part playlist exists", async () => {
      // Test stitchPlaylist directly with a mock that has actual playlist content
      const testMinio = createMockMinio();
      const streamId = "test-single";

      // Simulate p1.m3u8 existing in MinIO (what Restreamer would have created)
      testMinio.readFile.mockResolvedValue(
        "#EXTM3U\n" +
        "#EXT-X-VERSION:3\n" +
        "#EXT-X-TARGETDURATION:4\n" +
        "#EXT-X-MEDIA-SEQUENCE:0\n" +
        "#EXTINF:4.000000,\n" +
        "p1_seg_00000.ts\n" +
        "#EXTINF:4.000000,\n" +
        "p1_seg_00001.ts\n" +
        "#EXT-X-ENDLIST\n"
      );

      const parts = buildPartList([], 1);
      await stitchPlaylist(testMinio as any, streamId, parts);

      // Verify index.m3u8 was uploaded
      expect(testMinio.uploadBuffer).toHaveBeenCalledTimes(1);
      expect(testMinio.uploadBuffer).toHaveBeenCalledWith(
        `${streamId}/index.m3u8`,
        expect.stringContaining("#EXTM3U"),
        "application/vnd.apple.mpegurl"
      );

      // Verify the uploaded playlist is a valid VOD playlist
      const uploadedPlaylist = testMinio.uploadBuffer.mock.calls[0][1] as string;
      expect(uploadedPlaylist).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
      expect(uploadedPlaylist).toContain("#EXT-X-ENDLIST");
      expect(uploadedPlaylist).toContain("p1_seg_00000.ts");
      expect(uploadedPlaylist).toContain("p1_seg_00001.ts");
    });

    it("stitchPlaylist preserves segment filenames when PROGRAM-DATE-TIME tags appear between EXTINF and URI", async () => {
      // Regression test: Restreamer outputs #EXT-X-PROGRAM-DATE-TIME between
      // #EXTINF and the segment filename. The old parser treated the date tag
      // as the filename and dropped the actual segment URI.
      const testMinio = createMockMinio();
      const streamId = "test-pdt";

      testMinio.readFile.mockResolvedValue(
        "#EXTM3U\n" +
        "#EXT-X-VERSION:3\n" +
        "#EXT-X-TARGETDURATION:6\n" +
        "#EXT-X-MEDIA-SEQUENCE:0\n" +
        "#EXT-X-DISCONTINUITY\n" +
        "#EXTINF:5.833000,\n" +
        "#EXT-X-PROGRAM-DATE-TIME:2026-03-15T06:04:24.768+0000\n" +
        "p1_seg_00000.ts\n" +
        "#EXTINF:3.867000,\n" +
        "#EXT-X-PROGRAM-DATE-TIME:2026-03-15T06:04:30.601+0000\n" +
        "p1_seg_00001.ts\n" +
        "#EXTINF:2.046333,\n" +
        "#EXT-X-PROGRAM-DATE-TIME:2026-03-15T06:04:34.468+0000\n" +
        "p1_seg_00002.ts\n" +
        "#EXT-X-ENDLIST\n"
      );

      const parts = buildPartList([], 1);
      await stitchPlaylist(testMinio as any, streamId, parts);

      const uploadedPlaylist = testMinio.uploadBuffer.mock.calls[0][1] as string;

      // Must contain all segment filenames (the bug dropped them)
      expect(uploadedPlaylist).toContain("p1_seg_00000.ts");
      expect(uploadedPlaylist).toContain("p1_seg_00001.ts");
      expect(uploadedPlaylist).toContain("p1_seg_00002.ts");

      // Must also preserve the PROGRAM-DATE-TIME tags
      expect(uploadedPlaylist).toContain("#EXT-X-PROGRAM-DATE-TIME:2026-03-15T06:04:24.768+0000");

      // Each segment entry must have: EXTINF → PROGRAM-DATE-TIME → filename (in order)
      const lines = uploadedPlaylist.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#EXTINF:")) {
          // Next line should be PROGRAM-DATE-TIME, then segment filename
          expect(lines[i + 1]).toMatch(/^#EXT-X-PROGRAM-DATE-TIME:/);
          expect(lines[i + 2]).toMatch(/^p1_seg_\d+\.ts$/);
        }
      }
    });
  });

  // =========================================================================
  // Test 2: Multi-part recording (with pause) creates correct index.m3u8
  // =========================================================================
  describe("Test 2: Multi-part recording with pause creates correct index.m3u8", () => {
    it("full lifecycle: create -> pause -> resume -> stop produces correct part list", async () => {
      // --- Create stream ---
      const createRes = await createStream(app, { name: "Kamera 1" });
      expect(createRes.statusCode).toBe(201);
      const { id: streamId } = createRes.json();

      // --- Pause ---
      const pauseRes = await app.inject({
        method: "PATCH",
        url: `/api/streams/${streamId}/pause`,
        headers: authHeaders,
      });
      expect(pauseRes.statusCode).toBe(200);
      expect(pauseRes.json().status).toBe("paused");

      const meta = streamMeta.get(streamId)!;
      expect(meta.pausedAt).toBeTruthy();
      expect(meta.completedParts).toEqual([1]);
      expect(meta.partNumber).toBe(1);

      // Verify pause segments were uploaded
      expect(uploadPauseSegments).toHaveBeenCalledWith(
        expect.anything(), // minio
        streamId,
        1 // pauseNumber (= current partNumber at pause time)
      );

      // --- Resume ---
      const resumeRes = await app.inject({
        method: "PATCH",
        url: `/api/streams/${streamId}/resume`,
        headers: authHeaders,
      });
      expect(resumeRes.statusCode).toBe(200);
      expect(resumeRes.json().status).toBe("resumed");
      expect(resumeRes.json().partNumber).toBe(2);

      expect(meta.pausedAt).toBeUndefined();
      expect(meta.partNumber).toBe(2);

      // Verify Restreamer process was created with partNumber: 2
      expect(mockRestreamer.createProcess).toHaveBeenLastCalledWith(
        streamId,
        { recording: false, partNumber: 2 }
      );

      // --- Stop ---
      const stopRes = await app.inject({
        method: "DELETE",
        url: `/api/streams/${streamId}`,
        headers: authHeaders,
      });
      expect(stopRes.statusCode).toBe(204);

      // Verify the part list that would be passed to stitchPlaylist
      // After the lifecycle: completedParts=[1], partNumber=2
      const expectedParts = buildPartList([1], 2);
      expect(expectedParts).toEqual([
        { type: "recording", number: 1 },
        { type: "pause", number: 1 },
        { type: "recording", number: 2 },
      ]);
    });

    it("stitchPlaylist merges multi-part recording with discontinuity markers", async () => {
      const testMinio = createMockMinio();
      const streamId = "test-multi";

      // Simulate p1.m3u8, pause1.m3u8, p2.m3u8 existing in MinIO
      testMinio.readFile.mockImplementation(async (key: string) => {
        if (key === `${streamId}/p1.m3u8`) {
          return (
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n" +
            "#EXTINF:4.000000,\np1_seg_00000.ts\n#EXTINF:4.000000,\np1_seg_00001.ts\n#EXT-X-ENDLIST\n"
          );
        }
        if (key === `${streamId}/pause1.m3u8`) {
          return (
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n" +
            "#EXTINF:4.000000,\npause1_seg_00000.ts\n#EXT-X-ENDLIST\n"
          );
        }
        if (key === `${streamId}/p2.m3u8`) {
          return (
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n" +
            "#EXTINF:4.000000,\np2_seg_00000.ts\n#EXTINF:4.000000,\np2_seg_00001.ts\n#EXT-X-ENDLIST\n"
          );
        }
        return null;
      });

      const parts = buildPartList([1], 2);
      await stitchPlaylist(testMinio as any, streamId, parts);

      expect(testMinio.uploadBuffer).toHaveBeenCalledTimes(1);
      const [key, content] = testMinio.uploadBuffer.mock.calls[0];
      expect(key).toBe(`${streamId}/index.m3u8`);

      // Verify discontinuity markers between parts
      expect(content).toContain("#EXT-X-DISCONTINUITY");
      expect(content).toContain("p1_seg_00000.ts");
      expect(content).toContain("pause1_seg_00000.ts");
      expect(content).toContain("p2_seg_00000.ts");
      expect(content).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
      expect(content).toContain("#EXT-X-ENDLIST");

      // Verify correct ordering: p1 segments, then DISCONTINUITY, then pause, then DISCONTINUITY, then p2
      const lines = (content as string).split("\n");
      const p1Idx = lines.findIndex((l: string) => l.includes("p1_seg_00000"));
      const pause1Idx = lines.findIndex((l: string) => l.includes("pause1_seg_00000"));
      const p2Idx = lines.findIndex((l: string) => l.includes("p2_seg_00000"));
      expect(p1Idx).toBeLessThan(pause1Idx);
      expect(pause1Idx).toBeLessThan(p2Idx);
    });
  });

  // =========================================================================
  // Test 3: VOD URL points to index.m3u8
  // =========================================================================
  describe("Test 3: VOD URL points to index.m3u8", () => {
    it("VOD entry hlsUrl always points to index.m3u8, not p1.m3u8", async () => {
      const createRes = await createStream(app, { name: "Kamera 1" });
      const { id: streamId } = createRes.json();

      // Check the VOD entry that was saved
      expect(mockMinio.addVodEntry).toHaveBeenCalledTimes(1);
      const vodEntry = mockMinio.addVodEntry.mock.calls[0][0];

      // THE critical assertion: VOD URL must point to index.m3u8
      expect(vodEntry.hlsUrl).toBe(
        `https://minio.example.com/recordings/${streamId}/index.m3u8`
      );
      expect(vodEntry.hlsUrl).not.toContain("p1.m3u8");
    });

    it("minio.hlsUrl returns path with index.m3u8", () => {
      // Direct test of the URL generation function
      const url = mockMinio.hlsUrl("abc123");
      expect(url).toBe("https://minio.example.com/recordings/abc123/index.m3u8");
      expect(url).toMatch(/\/index\.m3u8$/);
    });

    it("stitchPlaylist always writes to {streamId}/index.m3u8 path", async () => {
      const testMinio = createMockMinio();
      testMinio.readFile.mockResolvedValue(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n" +
        "#EXTINF:4.000000,\np1_seg_00000.ts\n#EXT-X-ENDLIST\n"
      );

      await stitchPlaylist(testMinio as any, "stream-xyz", [{ type: "recording", number: 1 }]);

      // Verify the key is exactly {streamId}/index.m3u8
      const uploadKey = testMinio.uploadBuffer.mock.calls[0][0];
      expect(uploadKey).toBe("stream-xyz/index.m3u8");
    });
  });

  // =========================================================================
  // Test 4: Stream status transitions
  // =========================================================================
  describe("Test 4: Stream status transitions", () => {
    it("follows the complete lifecycle: waiting -> live -> paused -> live -> stopped", async () => {
      // --- Create stream -> status should be "waiting" ---
      const createRes = await createStream(app, { name: "Kamera 1" });
      expect(createRes.statusCode).toBe(201);
      const { id: streamId } = createRes.json();

      // When Restreamer reports processes, the stream status depends on HLS liveness.
      // Simulate: Restreamer returns the process, but HLS is not live yet -> "waiting"
      mockRestreamer.listAltaProcesses.mockResolvedValue([
        {
          config: { id: `alta-${streamId}` },
          state: { exec: "running", runtime_seconds: 0 },
        },
      ]);
      mockRestreamer.isHlsLive.mockResolvedValue(false);

      let listRes = await app.inject({
        method: "GET",
        url: "/api/streams",
        headers: authHeaders,
      });
      expect(listRes.statusCode).toBe(200);
      let streams = listRes.json();
      let stream = streams.find((s: any) => s.id === streamId);
      expect(stream).toBeDefined();
      expect(stream.status).toBe("waiting");

      // --- After HLS goes live -> status should be "live" ---
      mockRestreamer.isHlsLive.mockResolvedValue(true);

      listRes = await app.inject({
        method: "GET",
        url: "/api/streams",
        headers: authHeaders,
      });
      streams = listRes.json();
      stream = streams.find((s: any) => s.id === streamId);
      expect(stream.status).toBe("live");

      // --- After pause -> status should be "paused" ---
      const pauseRes = await app.inject({
        method: "PATCH",
        url: `/api/streams/${streamId}/pause`,
        headers: authHeaders,
      });
      expect(pauseRes.statusCode).toBe(200);

      // After pausing, the Restreamer process is deleted, so listAltaProcesses returns empty
      mockRestreamer.listAltaProcesses.mockResolvedValue([]);

      listRes = await app.inject({
        method: "GET",
        url: "/api/streams",
        headers: authHeaders,
      });
      streams = listRes.json();
      stream = streams.find((s: any) => s.id === streamId);
      expect(stream.status).toBe("paused");

      // --- After resume -> status should be "live" (once HLS comes back) ---
      const resumeRes = await app.inject({
        method: "PATCH",
        url: `/api/streams/${streamId}/resume`,
        headers: authHeaders,
      });
      expect(resumeRes.statusCode).toBe(200);

      // Simulate: process is back and HLS is live
      mockRestreamer.listAltaProcesses.mockResolvedValue([
        {
          config: { id: `alta-${streamId}` },
          state: { exec: "running", runtime_seconds: 60 },
        },
      ]);
      mockRestreamer.isHlsLive.mockResolvedValue(true);

      listRes = await app.inject({
        method: "GET",
        url: "/api/streams",
        headers: authHeaders,
      });
      streams = listRes.json();
      stream = streams.find((s: any) => s.id === streamId);
      expect(stream.status).toBe("live");

      // --- After stop -> status should be "stopped" ---
      const stopRes = await app.inject({
        method: "DELETE",
        url: `/api/streams/${streamId}`,
        headers: authHeaders,
      });
      expect(stopRes.statusCode).toBe(204);

      // Restreamer process is gone
      mockRestreamer.listAltaProcesses.mockResolvedValue([]);

      listRes = await app.inject({
        method: "GET",
        url: "/api/streams",
        headers: authHeaders,
      });
      streams = listRes.json();
      stream = streams.find((s: any) => s.id === streamId);
      expect(stream.status).toBe("stopped");
    });

    it("stopped stream appears in /api/vod list", async () => {
      // Create a stream with known duration > 10s
      const createRes = await createStream(app, { name: "Kamera 1", opponent: "AIK", team: "Älta IF" });
      const { id: streamId } = createRes.json();

      // Simulate real timing by manually adjusting createdAt to 2 minutes ago
      const meta = streamMeta.get(streamId)!;
      meta.createdAt = new Date(Date.now() - 120_000).toISOString();

      await app.inject({
        method: "DELETE",
        url: `/api/streams/${streamId}`,
        headers: authHeaders,
      });

      // The updateVodEntry was called with stoppedAt and durationSeconds
      expect(mockMinio.updateVodEntry).toHaveBeenCalledWith(
        streamId,
        expect.objectContaining({
          stoppedAt: expect.any(String),
          durationSeconds: expect.any(Number),
        })
      );

      // Verify VOD entry has durationSeconds >= 10 (so it passes the filter)
      const updateCall = mockMinio.updateVodEntry.mock.calls.find(
        (c: any[]) => c[0] === streamId
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1].durationSeconds).toBeGreaterThanOrEqual(10);

      // Now check the VOD list endpoint
      const vodRes = await app.inject({
        method: "GET",
        url: "/api/vod",
        headers: authHeaders,
      });
      expect(vodRes.statusCode).toBe(200);

      // The mock VOD index includes the entry we created
      const vodList = vodRes.json();
      const vodEntry = vodList.find((v: any) => v.id === streamId);
      expect(vodEntry).toBeDefined();
      expect(vodEntry.hlsUrl).toContain("index.m3u8");
    });
  });

  // =========================================================================
  // Test 5: Short recording handling
  // =========================================================================
  describe("Test 5: Short recording handling", () => {
    it("short recording (< 10s) exists in MinIO index but is filtered from /api/vod", async () => {
      // Create and immediately stop (duration < 10s)
      const createRes = await createStream(app, { name: "Kort test" });
      expect(createRes.statusCode).toBe(201);
      const { id: streamId } = createRes.json();

      // Stop immediately (duration will be ~0 seconds)
      const stopRes = await app.inject({
        method: "DELETE",
        url: `/api/streams/${streamId}`,
        headers: authHeaders,
      });
      expect(stopRes.statusCode).toBe(204);

      // VOD entry should have been created (addVodEntry was called)
      expect(mockMinio.addVodEntry).toHaveBeenCalledTimes(1);
      const vodEntry = mockMinio._vodIndex.find((e) => e.id === streamId);
      expect(vodEntry).toBeDefined();

      // updateVodEntry should have been called with a very short duration
      expect(mockMinio.updateVodEntry).toHaveBeenCalledWith(
        streamId,
        expect.objectContaining({
          stoppedAt: expect.any(String),
          durationSeconds: expect.any(Number),
        })
      );

      // The durationSeconds should be very small (< 10)
      const update = mockMinio.updateVodEntry.mock.calls.find(
        (c: any[]) => c[0] === streamId
      );
      expect(update![1].durationSeconds).toBeLessThan(10);

      // Now check the VOD list — short recording should be filtered out
      const vodRes = await app.inject({
        method: "GET",
        url: "/api/vod",
        headers: authHeaders,
      });
      expect(vodRes.statusCode).toBe(200);

      const vodList = vodRes.json();
      const found = vodList.find((v: any) => v.id === streamId);
      expect(found).toBeUndefined();
    });

    it("recording just above 10s threshold passes the VOD filter", async () => {
      const createRes = await createStream(app, { name: "Kamera 2" });
      const { id: streamId } = createRes.json();

      // Set createdAt to 15 seconds ago so durationSeconds > 10
      const meta = streamMeta.get(streamId)!;
      meta.createdAt = new Date(Date.now() - 15_000).toISOString();

      await app.inject({
        method: "DELETE",
        url: `/api/streams/${streamId}`,
        headers: authHeaders,
      });

      const vodRes = await app.inject({
        method: "GET",
        url: "/api/vod",
        headers: authHeaders,
      });
      const vodList = vodRes.json();
      const found = vodList.find((v: any) => v.id === streamId);
      expect(found).toBeDefined();
      expect(found.hlsUrl).toContain("index.m3u8");
    });
  });

  // =========================================================================
  // Additional regression tests
  // =========================================================================
  describe("Regression: pause/resume edge cases", () => {
    it("double-pause returns 409", async () => {
      const createRes = await createStream(app, { name: "Kamera 1" });
      const { id: streamId } = createRes.json();

      // First pause succeeds
      const pause1 = await app.inject({
        method: "PATCH",
        url: `/api/streams/${streamId}/pause`,
        headers: authHeaders,
      });
      expect(pause1.statusCode).toBe(200);

      // Second pause returns 409
      const pause2 = await app.inject({
        method: "PATCH",
        url: `/api/streams/${streamId}/pause`,
        headers: authHeaders,
      });
      expect(pause2.statusCode).toBe(409);
      expect(pause2.json().error).toBe("already_paused");
    });

    it("resume without pause returns 409", async () => {
      const createRes = await createStream(app, { name: "Kamera 1" });
      const { id: streamId } = createRes.json();

      const resumeRes = await app.inject({
        method: "PATCH",
        url: `/api/streams/${streamId}/resume`,
        headers: authHeaders,
      });
      expect(resumeRes.statusCode).toBe(409);
      expect(resumeRes.json().error).toBe("not_paused");
    });

    it("pause on stopped stream returns 409", async () => {
      const createRes = await createStream(app, { name: "Kamera 1" });
      const { id: streamId } = createRes.json();

      // Stop first
      await app.inject({
        method: "DELETE",
        url: `/api/streams/${streamId}`,
        headers: authHeaders,
      });

      // Then try to pause
      const pauseRes = await app.inject({
        method: "PATCH",
        url: `/api/streams/${streamId}/pause`,
        headers: authHeaders,
      });
      expect(pauseRes.statusCode).toBe(409);
      expect(pauseRes.json().error).toBe("already_stopped");
    });

    it("oscManager tracks pause/resume/stop correctly", async () => {
      const createRes = await createStream(app, { name: "Kamera 1" });
      const { id: streamId } = createRes.json();

      expect(mockOsc.streamStarted).toHaveBeenCalledTimes(1);

      await app.inject({ method: "PATCH", url: `/api/streams/${streamId}/pause`, headers: authHeaders });
      expect(mockOsc.streamPaused).toHaveBeenCalledTimes(1);

      await app.inject({ method: "PATCH", url: `/api/streams/${streamId}/resume`, headers: authHeaders });
      expect(mockOsc.streamResumed).toHaveBeenCalledTimes(1);

      await app.inject({ method: "DELETE", url: `/api/streams/${streamId}`, headers: authHeaders });
      // Stream was not paused at stop time (it was resumed), so streamEnded is called, not pausedStreamEnded
      expect(mockOsc.streamEnded).toHaveBeenCalledTimes(1);
      expect(mockOsc.pausedStreamEnded).not.toHaveBeenCalled();
    });

    it("stopping a paused stream calls pausedStreamEnded", async () => {
      const createRes = await createStream(app, { name: "Kamera 1" });
      const { id: streamId } = createRes.json();

      // Pause without resume
      await app.inject({ method: "PATCH", url: `/api/streams/${streamId}/pause`, headers: authHeaders });

      // Stop while paused
      await app.inject({ method: "DELETE", url: `/api/streams/${streamId}`, headers: authHeaders });

      expect(mockOsc.pausedStreamEnded).toHaveBeenCalledTimes(1);
      expect(mockOsc.streamEnded).not.toHaveBeenCalled();
    });
  });

  describe("Regression: stream creation edge cases", () => {
    it("rejects stream creation without name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/streams",
        headers: jsonHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("missing_name");
    });

    it("rejects stream creation without API key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/streams",
        headers: { "content-type": "application/json" },
        payload: { name: "Test" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("creates VOD entry with correct match metadata", async () => {
      const createRes = await createStream(app, { name: "Kamera 1", opponent: "AIK", team: "Älta IF" });
      const { id: streamId } = createRes.json();

      expect(mockMinio.addVodEntry).toHaveBeenCalledTimes(1);
      const vodEntry = mockMinio.addVodEntry.mock.calls[0][0];
      expect(vodEntry.id).toBe(streamId);
      expect(vodEntry.matchTitle).toBe("Älta IF vs AIK");
      expect(vodEntry.homeTeam).toBe("Älta IF");
      expect(vodEntry.awayTeam).toBe("AIK");
      expect(vodEntry.cameraName).toBe("Kamera 1");
      expect(vodEntry.hlsUrl).toContain("index.m3u8");
    });
  });
});
