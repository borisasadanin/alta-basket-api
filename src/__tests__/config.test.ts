import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("config validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.API_KEY = "test-key";
    process.env.ADMIN_PIN = "1234";
    process.env.OSC_ACCESS_TOKEN = "test-pat";
    process.env.MINIO_ENDPOINT = "https://minio.example.com";
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
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("OSC_ACCESS_TOKEN"));
  });

  it("exits when required secrets are missing", async () => {
    delete process.env.API_KEY;
    delete process.env.ADMIN_PIN;
    delete process.env.MINIO_ACCESS_KEY;
    delete process.env.MINIO_SECRET_KEY;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("../config.js").then((m) => m.validateConfig())).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("API_KEY"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("ADMIN_PIN"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("MINIO_ACCESS_KEY"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("MINIO_SECRET_KEY"));
  });

  it("warns but does not exit when VIEWER_PIN is missing", async () => {
    delete process.env.VIEWER_PIN;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await import("../config.js");
    mod.validateConfig();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("VIEWER_PIN"));
  });

  it("passes validation when all required vars are set", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const mod = await import("../config.js");
    mod.validateConfig();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mod.config.API_KEY).toBe("test-key");
    expect(mod.config.ADMIN_PIN).toBe("1234");
    expect(mod.config.MINIO_ACCESS_KEY).toBe("minioaccess");
  });
});
