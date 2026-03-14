import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("config validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.API_KEY = "test-key";
    process.env.ADMIN_PIN = "1234";
    process.env.OSC_ACCESS_TOKEN = "test-pat";
    process.env.MINIO_ACCESS_KEY = "minioaccess";
    process.env.MINIO_SECRET_KEY = "miniosecret";
    process.env.VIEWER_PIN = "5678";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("exits when OSC_ACCESS_TOKEN is missing", async () => {
    delete process.env.OSC_ACCESS_TOKEN;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("../config.js").then((m) => m.validateConfig())).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith("Missing OSC_ACCESS_TOKEN");
  });

  it("uses defaults when API_KEY, ADMIN_PIN, MINIO keys are missing", async () => {
    delete process.env.API_KEY;
    delete process.env.ADMIN_PIN;
    delete process.env.MINIO_ACCESS_KEY;
    delete process.env.MINIO_SECRET_KEY;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const mod = await import("../config.js");
    mod.validateConfig();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mod.config.API_KEY).toBe("alta-basket-2026");
    expect(mod.config.ADMIN_PIN).toBe("804480");
    expect(mod.config.MINIO_ACCESS_KEY).toBe("root");
  });

  it("uses default VIEWER_PIN when env var is missing", async () => {
    delete process.env.VIEWER_PIN;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const mod = await import("../config.js");
    mod.validateConfig();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mod.config.VIEWER_PIN).toBe("123456");
  });
});
