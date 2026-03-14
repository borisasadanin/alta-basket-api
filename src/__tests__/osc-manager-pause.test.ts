import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @osaas/client-core so OscInstanceManager can be constructed
// without a real OSC_ACCESS_TOKEN
vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));

import { OscInstanceManager } from "../osc-manager.js";

// We test the public pause-related methods on OscInstanceManager,
// verifying the counting logic without needing real OSC infrastructure.

describe("OscInstanceManager pause tracking", () => {
  let manager: OscInstanceManager;

  beforeEach(() => {
    manager = new OscInstanceManager({
      instanceName: "test-instance",
      gracePeriodMs: 1000,
      logger: { info: () => {}, error: () => {} },
    });
  });

  it("streamPaused decrements active count", () => {
    manager.streamStarted();
    manager.streamStarted();
    expect(manager.getActiveStreamCount()).toBe(2);

    manager.streamPaused();
    expect(manager.getActiveStreamCount()).toBe(1);
  });

  it("streamResumed increments active count", () => {
    manager.streamStarted();
    manager.streamPaused();
    expect(manager.getActiveStreamCount()).toBe(0);

    manager.streamResumed();
    expect(manager.getActiveStreamCount()).toBe(1);
  });

  it("pausedStreamEnded does not affect active count", () => {
    manager.streamStarted();
    manager.streamPaused();
    expect(manager.getActiveStreamCount()).toBe(0);

    manager.pausedStreamEnded();
    expect(manager.getActiveStreamCount()).toBe(0);
  });

  it("active count never goes below 0", () => {
    manager.streamPaused();
    expect(manager.getActiveStreamCount()).toBe(0);

    manager.streamPaused();
    expect(manager.getActiveStreamCount()).toBe(0);
  });
});
