import { describe, it, expect } from "vitest";
import { determineStreamStatus } from "../stream-status.js";

describe("determineStreamStatus", () => {
  it('returns "live" when HLS is live, regardless of metadata', () => {
    expect(determineStreamStatus(true)).toBe("live");
    expect(determineStreamStatus(true, undefined)).toBe("live");
    expect(determineStreamStatus(true, { wasLive: false })).toBe("live");
    expect(determineStreamStatus(true, { wasLive: true })).toBe("live");
    expect(determineStreamStatus(true, { wasLive: true, stoppedAt: "2024-01-01T00:00:00Z" })).toBe("live");
  });

  it('returns "stopped" when HLS is down and stream was previously live', () => {
    expect(determineStreamStatus(false, { wasLive: true })).toBe("stopped");
    expect(determineStreamStatus(false, { wasLive: true, stoppedAt: "2024-01-01T00:00:00Z" })).toBe("stopped");
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

  it('"paused" takes priority over "live" and "stopped"', () => {
    expect(determineStreamStatus(true, { pausedAt: "2024-01-01T00:00:00Z", wasLive: true })).toBe("paused");
    expect(determineStreamStatus(false, { pausedAt: "2024-01-01T00:00:00Z", stoppedAt: "2024-01-01T01:00:00Z" })).toBe("paused");
  });
});
