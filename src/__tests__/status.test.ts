import { describe, it, expect } from "vitest";
import { determineStreamStatus } from "../stream-status.js";

describe("determineStreamStatus", () => {
  it('returns "live" when HLS is live, regardless of metadata', () => {
    expect(determineStreamStatus(true)).toBe("live");
    expect(determineStreamStatus(true, undefined)).toBe("live");
    expect(determineStreamStatus(true, { wasLive: false })).toBe("live");
    expect(determineStreamStatus(true, { wasLive: true })).toBe("live");
  });

  it('"stopped" requires explicit stoppedAt — never inferred from wasLive alone', () => {
    // stoppedAt is set → always stopped (regardless of hlsLive)
    expect(determineStreamStatus(false, { stoppedAt: "2024-01-01T00:00:00Z" })).toBe("stopped");
    expect(determineStreamStatus(false, { wasLive: true, stoppedAt: "2024-01-01T00:00:00Z" })).toBe("stopped");
    // stoppedAt takes priority over hlsLive — the stream was explicitly stopped
    expect(determineStreamStatus(true, { stoppedAt: "2024-01-01T00:00:00Z" })).toBe("stopped");
    expect(determineStreamStatus(true, { wasLive: true, stoppedAt: "2024-01-01T00:00:00Z" })).toBe("stopped");
  });

  it('returns "live" (optimistic) when wasLive but not explicitly stopped', () => {
    // CRITICAL: A transient isHlsLive failure must NOT report "stopped" when the
    // stream hasn't been explicitly stopped. The frontend uses "stopped" to close
    // the player, so false positives kill live streams.
    expect(determineStreamStatus(false, { wasLive: true })).toBe("live");
  });

  it('returns "waiting" when HLS is down and stream was never live', () => {
    expect(determineStreamStatus(false)).toBe("waiting");
    expect(determineStreamStatus(false, undefined)).toBe("waiting");
    expect(determineStreamStatus(false, { wasLive: false })).toBe("waiting");
    expect(determineStreamStatus(false, {})).toBe("waiting");
  });

  it('returns "paused" when pausedAt is set, regardless of hlsLive', () => {
    expect(determineStreamStatus(false, { pausedAt: "2024-01-01T00:00:00Z" })).toBe("paused");
    expect(determineStreamStatus(true, { pausedAt: "2024-01-01T00:00:00Z" })).toBe("paused");
    expect(determineStreamStatus(false, { pausedAt: "2024-01-01T00:00:00Z", wasLive: true })).toBe("paused");
  });

  it('"stopped" takes priority over "paused" (edge case: stopped while paused)', () => {
    // stoppedAt is checked first in the new logic
    expect(determineStreamStatus(false, { stoppedAt: "2024-01-01T01:00:00Z", pausedAt: "2024-01-01T00:00:00Z" })).toBe("stopped");
  });

  it('"paused" takes priority over "live"', () => {
    expect(determineStreamStatus(true, { pausedAt: "2024-01-01T00:00:00Z", wasLive: true })).toBe("paused");
  });

  // Regression: after resume, wasLive must be reset to false so status is
  // "waiting" (not "stopped") during the 3-10s gap before HLS goes live.
  it('returns "waiting" after resume when wasLive has been reset', () => {
    // Simulates post-resume state: pausedAt cleared, wasLive reset, HLS not yet live
    expect(determineStreamStatus(false, { wasLive: false })).toBe("waiting");
    // Once HLS goes live, it correctly returns "live"
    expect(determineStreamStatus(true, { wasLive: false })).toBe("live");
  });
});
