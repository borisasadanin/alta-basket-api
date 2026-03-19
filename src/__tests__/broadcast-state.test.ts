import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getBroadcastState, setBroadcastState } from "../broadcast-state.js";

describe("broadcast-state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset to idle
    setBroadcastState("idle");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to idle", () => {
    const state = getBroadcastState();
    expect(state.status).toBe("idle");
    expect(state.updatedAt).toBeTruthy();
  });

  it("updates status and updatedAt", () => {
    const before = getBroadcastState().updatedAt;
    vi.advanceTimersByTime(100);
    const state = setBroadcastState("upcoming", "Älta vs AIK");
    expect(state.status).toBe("upcoming");
    expect(state.message).toBe("Älta vs AIK");
    expect(state.updatedAt).not.toBe(before);
  });

  it("clears message when not provided", () => {
    setBroadcastState("upcoming", "Älta vs AIK");
    const state = setBroadcastState("live");
    expect(state.message).toBeUndefined();
  });

  it('auto-expires "ended" to "idle" after 5 minutes', () => {
    setBroadcastState("ended");
    expect(getBroadcastState().status).toBe("ended");

    vi.advanceTimersByTime(4 * 60 * 1000); // 4 min
    expect(getBroadcastState().status).toBe("ended");

    vi.advanceTimersByTime(1 * 60 * 1000 + 1); // 5 min + 1ms
    expect(getBroadcastState().status).toBe("idle");
  });

  it("clears expiry timer when transitioning away from ended", () => {
    setBroadcastState("ended");
    vi.advanceTimersByTime(2 * 60 * 1000); // 2 min
    setBroadcastState("upcoming"); // should cancel timer

    vi.advanceTimersByTime(5 * 60 * 1000); // 5 more min
    expect(getBroadcastState().status).toBe("upcoming"); // NOT idle
  });

  it("resets expiry timer on repeated ended", () => {
    setBroadcastState("ended");
    vi.advanceTimersByTime(4 * 60 * 1000); // 4 min

    setBroadcastState("ended"); // reset timer
    vi.advanceTimersByTime(4 * 60 * 1000); // 4 more min (8 total from first)
    expect(getBroadcastState().status).toBe("ended"); // timer was reset

    vi.advanceTimersByTime(1 * 60 * 1000 + 1); // 5 min from second set
    expect(getBroadcastState().status).toBe("idle");
  });
});
