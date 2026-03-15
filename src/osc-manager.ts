import {
  Context,
  getInstance,
  createInstance,
  removeInstance,
  getPortsForInstance,
} from "@osaas/client-core";

const SERVICE_ID = "datarhei-restreamer";

type InstanceState = "stopped" | "starting" | "running" | "stopping";

export interface InstanceInfo {
  url: string;
  rtmpHost: string;
}

export interface S3StorageConfig {
  endpoint: string;       // MinIO host without https:// (e.g. "borispriv-basket.minio-minio.auto.prod.osaas.io")
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

interface OscManagerOptions {
  instanceName: string;
  gracePeriodMs?: number;
  startupTimeoutMs?: number;
  healthPollMs?: number;
  logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  s3Config?: S3StorageConfig;
}

export class OscInstanceManager {
  private state: InstanceState = "stopped";
  private ctx: Context;
  private instanceName: string;
  private gracePeriodMs: number;
  private startupTimeoutMs: number;
  private healthPollMs: number;
  private log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

  private startPromise: Promise<InstanceInfo> | null = null;
  private gracePeriodTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedInfo: InstanceInfo | null = null;
  private activeStreamCount = 0;
  private pausedStreamCount = 0;
  private s3Config?: S3StorageConfig;
  private bgPollTimer: ReturnType<typeof setInterval> | null = null;
  private bgPollRunning = false;

  constructor(opts: OscManagerOptions) {
    this.ctx = new Context();
    this.instanceName = opts.instanceName;
    this.gracePeriodMs = opts.gracePeriodMs ?? 15 * 60 * 1000;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 180_000;
    this.healthPollMs = opts.healthPollMs ?? 2000;
    this.log = opts.logger ?? { info: console.log, error: console.error };
    this.s3Config = opts.s3Config;
  }

  getState(): InstanceState {
    return this.state;
  }

  getInfo(): InstanceInfo | null {
    return this.cachedInfo;
  }

  /** Returns cached state + info instantly (no network calls). */
  getCachedState(): { state: InstanceState; info: InstanceInfo | null } {
    return { state: this.state, info: this.cachedInfo };
  }

  /** Start background health polling (every 15s). Call once at server startup. */
  startBackgroundPolling(): void {
    if (this.bgPollTimer) return;
    this.bgPollTimer = setInterval(() => {
      if (this.bgPollRunning) return; // Skip if previous poll still running
      this.bgPollRunning = true;
      this.backgroundHealthCheck()
        .catch((err) => this.log.error(err, "Background health poll error"))
        .finally(() => { this.bgPollRunning = false; });
    }, 15_000);
    // Run initial check immediately
    this.backgroundHealthCheck().catch(() => {});
  }

  stopBackgroundPolling(): void {
    if (this.bgPollTimer) {
      clearInterval(this.bgPollTimer);
      this.bgPollTimer = null;
    }
  }

  /** Quick liveness probe (3s timeout). Returns true if Restreamer API responds OK. */
  async quickHealthProbe(): Promise<boolean> {
    if (!this.cachedInfo) return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const sat = await this.ctx.getServiceAccessToken(SERVICE_ID);
      const res = await fetch(`${this.cachedInfo.url}/api/v3/process`, {
        headers: { Authorization: `Bearer ${sat}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Force-remove the existing instance and recreate it from scratch.
   * Use when the instance exists but is broken/unresponsive.
   */
  async forceRecreate(): Promise<InstanceInfo> {
    this.cancelGracePeriod();
    this.log.info("Force-recreating Restreamer instance...");

    // Remove existing instance (ignore errors — it might already be gone)
    try {
      const sat = await this.ctx.getServiceAccessToken(SERVICE_ID);
      await removeInstance(this.ctx, SERVICE_ID, this.instanceName, sat);
      this.log.info(`Removed broken instance "${this.instanceName}"`);
    } catch (err) {
      this.log.error(err, "Failed to remove instance during recreate (continuing)");
    }

    // Reset state
    this.state = "starting";
    this.cachedInfo = null;
    this.startPromise = null;

    // Create fresh
    this.startPromise = this.startInstance();
    try {
      const info = await this.startPromise;
      this.cachedInfo = info;
      this.state = "running";
      return info;
    } catch (err) {
      this.state = "stopped";
      this.startPromise = null;
      this.cachedInfo = null;
      throw err;
    }
  }

  async ensureRunning(): Promise<InstanceInfo> {
    // Already starting — await the same promise (no duplicate creation)
    if (this.state === "starting" && this.startPromise) {
      return this.startPromise;
    }

    // Stopping (grace period active) — cancel the timer and stay running
    if (this.state === "stopping" && this.cachedInfo) {
      this.cancelGracePeriod();
      this.state = "running";
    }

    // Already running — verify RTMP is still enabled (container may have restarted)
    if (this.state === "running" && this.cachedInfo) {
      try {
        await this.verifyRtmpEnabled(this.cachedInfo.url);
      } catch (err) {
        this.log.error(err, "RTMP verification failed, restarting instance");
        this.state = "stopped";
        this.cachedInfo = null;
        // Fall through to start fresh
      }
      if (this.state === "running") {
        return this.cachedInfo!;
      }
    }

    // Stopped — start fresh
    this.state = "starting";
    this.startPromise = this.startInstance();

    try {
      const info = await this.startPromise;
      this.cachedInfo = info;
      this.state = "running";
      return info;
    } catch (err) {
      this.state = "stopped";
      this.startPromise = null;
      this.cachedInfo = null;
      throw err;
    }
  }

  getActiveStreamCount(): number {
    return this.activeStreamCount;
  }

  streamStarted(): void {
    this.activeStreamCount++;
    this.cancelGracePeriod();
    // Ensure state is consistent — if we have active streams, we must be running
    if (this.cachedInfo && this.state !== "running" && this.state !== "starting") {
      this.state = "running";
    }
  }

  streamPaused(): void {
    this.activeStreamCount = Math.max(0, this.activeStreamCount - 1);
    this.pausedStreamCount++;
    // Don't start grace period — paused streams keep Restreamer alive
  }

  streamResumed(): void {
    this.pausedStreamCount = Math.max(0, this.pausedStreamCount - 1);
    this.activeStreamCount++;
    this.cancelGracePeriod();
    if (this.cachedInfo && this.state !== "running" && this.state !== "starting") {
      this.state = "running";
    }
  }

  streamEnded(): void {
    this.activeStreamCount = Math.max(0, this.activeStreamCount - 1);
    if (this.activeStreamCount === 0 && this.pausedStreamCount === 0 && this.state === "running") {
      this.startGracePeriod();
    }
  }

  /** Called when a paused stream is stopped (not resumed) */
  pausedStreamEnded(): void {
    this.pausedStreamCount = Math.max(0, this.pausedStreamCount - 1);
    if (this.activeStreamCount === 0 && this.pausedStreamCount === 0 && this.state === "running") {
      this.startGracePeriod();
    }
  }

  syncActiveCount(count: number): void {
    const prev = this.activeStreamCount;
    this.activeStreamCount = Math.max(0, count);
    if (prev > 0 && this.activeStreamCount === 0 && this.pausedStreamCount === 0 && this.state === "running") {
      this.startGracePeriod();
    }
  }

  async forceStop(): Promise<void> {
    this.cancelGracePeriod();
    if (this.state === "stopped") return;

    this.state = "stopping";
    try {
      const sat = await this.ctx.getServiceAccessToken(SERVICE_ID);
      await removeInstance(this.ctx, SERVICE_ID, this.instanceName, sat);
      this.log.info(`Restreamer instance "${this.instanceName}" removed`);
    } catch (err) {
      this.log.error(err, "Failed to remove Restreamer instance");
    }
    this.state = "stopped";
    this.cachedInfo = null;
    this.startPromise = null;
    this.activeStreamCount = 0;
    this.pausedStreamCount = 0;
  }

  // --- Internal ---

  private async startInstance(): Promise<InstanceInfo> {
    const sat = await this.ctx.getServiceAccessToken(SERVICE_ID);

    // Check if instance already exists (e.g. after backend restart)
    let instance = await getInstance(this.ctx, SERVICE_ID, this.instanceName, sat);

    if (!instance) {
      this.log.info(`Creating Restreamer instance "${this.instanceName}"...`);
      instance = await createInstance(this.ctx, SERVICE_ID, sat, {
        name: this.instanceName,
      });
    } else {
      this.log.info(`Restreamer instance "${this.instanceName}" already exists`);
    }

    const url: string = instance.url;

    // Wait for Restreamer to be healthy (verify API is actually responsive)
    await this.waitForHealth(url, true);

    // Enable RTMP server (disabled by default on fresh instances)
    await this.enableRtmp(url, sat);

    // Discover the dynamic RTMP host:port
    const rtmpHost = await this.discoverRtmpHost(sat);

    this.log.info(`Restreamer ready — URL: ${url}, RTMP: ${rtmpHost}`);
    return { url, rtmpHost };
  }

  private async verifyRtmpEnabled(url: string): Promise<void> {
    const sat = await this.ctx.getServiceAccessToken(SERVICE_ID);
    const configRes = await fetch(`${url}/api/v3/config`, {
      headers: { Authorization: `Bearer ${sat}` },
    });

    if (!configRes.ok) {
      throw new Error(`Could not read Restreamer config: ${configRes.status}`);
    }

    const data = (await configRes.json()) as { config: Record<string, unknown> };
    const rtmpConfig = data.config.rtmp as { enable?: boolean; [k: string]: unknown } | undefined;
    const storageConfig = data.config.storage as { s3?: unknown[]; [k: string]: unknown } | undefined;

    const needsRtmp = !rtmpConfig?.enable;
    const needsS3 = this.s3Config && (!storageConfig?.s3 || storageConfig.s3.length === 0);

    if (needsRtmp || needsS3) {
      this.log.info(`Re-applying config (RTMP: ${needsRtmp}, S3: ${!!needsS3})...`);
      await this.enableRtmp(url, sat);
    }
  }

  /** Number of consecutive health check failures before marking as stopped */
  private healthFailCount = 0;
  private static readonly HEALTH_FAIL_THRESHOLD = 3; // 3 consecutive failures = stopped
  private static readonly HEALTH_TIMEOUT_MS = 10_000; // 10s timeout (Restreamer can be slow under load)

  /**
   * Background liveness check — verifies Restreamer API is responsive.
   * Requires multiple consecutive failures before marking as stopped,
   * to avoid false positives when Restreamer is under load.
   * Called automatically by background polling timer.
   */
  private async backgroundHealthCheck(): Promise<InstanceState> {
    // If we think it's stopped, check if the instance actually exists in OSC
    // (handles backend restart where in-memory state is lost)
    if (this.state === "stopped" && !this.cachedInfo) {
      try {
        const sat = await this.ctx.getServiceAccessToken(SERVICE_ID);
        const instance = await getInstance(this.ctx, SERVICE_ID, this.instanceName, sat);
        if (instance?.url) {
          // Instance exists — verify it's actually reachable
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), OscInstanceManager.HEALTH_TIMEOUT_MS);
          const res = await fetch(`${instance.url}/api/v3/process`, {
            headers: { Authorization: `Bearer ${sat}` },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (res.ok) {
            // Recover state from the live instance
            const rtmpHost = await this.discoverRtmpHost(sat);
            this.cachedInfo = { url: instance.url, rtmpHost };
            this.state = "running";
            this.healthFailCount = 0;
            this.log.info(`Recovered running Restreamer instance — URL: ${instance.url}, RTMP: ${rtmpHost}`);
            return "running";
          }
        }
      } catch {
        // Instance doesn't exist or is unreachable — truly stopped
      }
      return "stopped";
    }

    if (this.state !== "running" || !this.cachedInfo) {
      return this.state;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), OscInstanceManager.HEALTH_TIMEOUT_MS);
      const res = await fetch(`${this.cachedInfo.url}/api/v3/process`, {
        headers: { Authorization: `Bearer ${await this.ctx.getServiceAccessToken(SERVICE_ID)}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        this.healthFailCount = 0;
        return "running";
      }
    } catch {
      // Instance unreachable — might be a transient issue
    }

    // Require multiple consecutive failures before marking as stopped.
    // A single slow response (Restreamer encoding + S3 write) should not
    // cause the backend to lose track of the running instance.
    this.healthFailCount++;
    if (this.healthFailCount < OscInstanceManager.HEALTH_FAIL_THRESHOLD) {
      this.log.info(`Restreamer health check failed (${this.healthFailCount}/${OscInstanceManager.HEALTH_FAIL_THRESHOLD}) — will retry`);
      return "running"; // Keep state as running, retry next poll
    }

    this.log.info(`Restreamer health check failed ${this.healthFailCount} times — marking as stopped`);
    this.state = "stopped";
    this.cachedInfo = null;
    this.startPromise = null;
    this.healthFailCount = 0;
    return "stopped";
  }

  private async waitForHealth(url: string, verifyApi = false): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { method: "GET" });
        if (res.ok) {
          if (!verifyApi) return;
          // Also verify the process API is responsive (not just the web UI)
          const sat = await this.ctx.getServiceAccessToken(SERVICE_ID);
          const apiRes = await fetch(`${url}/api/v3/process`, {
            headers: { Authorization: `Bearer ${sat}` },
          });
          if (apiRes.ok) return;
          this.log.info("Base URL healthy but API not ready yet, retrying...");
        }
      } catch {
        // Not ready yet
      }
      await this.sleep(this.healthPollMs);
    }

    throw new Error(
      `Restreamer did not become healthy within ${this.startupTimeoutMs / 1000}s`
    );
  }

  private async enableRtmp(url: string, sat: string): Promise<void> {
    // Read current config — response: { config: { rtmp: { enable, ... }, ... } }
    const configRes = await fetch(`${url}/api/v3/config`, {
      headers: { Authorization: `Bearer ${sat}` },
    });

    if (!configRes.ok) {
      this.log.info("Could not read Restreamer config, RTMP may already be enabled");
      return;
    }

    const data = (await configRes.json()) as { config: Record<string, unknown> };
    const innerConfig = data.config;
    const rtmpConfig = innerConfig.rtmp as { enable?: boolean; [k: string]: unknown } | undefined;

    const storageConfig = innerConfig.storage as { s3?: unknown[]; [k: string]: unknown } | undefined;
    const needsRtmp = !rtmpConfig?.enable;
    const needsS3 = this.s3Config && (!storageConfig?.s3 || storageConfig.s3.length === 0);

    if (!needsRtmp && !needsS3) {
      this.log.info("RTMP and S3 already configured");
      return;
    }

    // Build updated config with RTMP + S3 storage
    const updatedConfig: Record<string, unknown> = {
      ...innerConfig,
      rtmp: { ...rtmpConfig, enable: true },
    };

    if (this.s3Config) {
      updatedConfig.storage = {
        ...storageConfig,
        s3: [
          {
            name: "minio",
            mountpoint: "/s3",
            endpoint: this.s3Config.endpoint,
            access_key_id: this.s3Config.accessKeyId,
            secret_access_key: this.s3Config.secretAccessKey,
            bucket: this.s3Config.bucket,
            region: "us-east-1",
            use_ssl: true,
            auth: { enable: false, username: "", password: "" },
          },
        ],
      };
    }

    const putRes = await fetch(`${url}/api/v3/config`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${sat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updatedConfig),
    });

    if (!putRes.ok) {
      const body = await putRes.text();
      throw new Error(`Failed to enable RTMP: ${putRes.status} ${body}`);
    }

    this.log.info(`Config updated (RTMP + ${this.s3Config ? "S3" : "no S3"}), reloading...`);

    // Reload config (restarts core)
    await fetch(`${url}/api/v3/config/reload`, {
      headers: { Authorization: `Bearer ${sat}` },
    });

    // Wait for Restreamer to come back after reload (verify API is ready, not just web UI)
    await this.sleep(3000);
    await this.waitForHealth(url, true);

    // Verify S3 filesystem is accessible (may take a moment after config reload)
    if (this.s3Config) {
      await this.verifyS3Ready(url);
    }
  }

  private async verifyS3Ready(url: string): Promise<void> {
    const deadline = Date.now() + 15_000; // 15s timeout
    const sat = await this.ctx.getServiceAccessToken(SERVICE_ID);

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${url}/api/v3/fs/disk`, {
          headers: { Authorization: `Bearer ${sat}` },
        });
        if (res.ok) {
          const disks = await res.json() as { name: string; type: string }[];
          const hasS3 = disks.some((d: { name: string; type: string }) => d.name === "minio" || d.type === "s3");
          if (hasS3) {
            this.log.info("S3 filesystem verified as ready");
            return;
          }
        }
      } catch {
        // Not ready yet
      }
      await this.sleep(1000);
    }

    this.log.error("S3 filesystem not verified within 15s — recordings may fail");
  }

  private async discoverRtmpHost(sat: string): Promise<string> {
    const ports = await getPortsForInstance(
      this.ctx,
      SERVICE_ID,
      this.instanceName,
      sat
    );

    const rtmpPort = (ports as { externalIp: string; externalPort: number; internalPort: number }[])
      .find((p) => p.internalPort === 1935);

    if (!rtmpPort) {
      throw new Error("Could not discover RTMP port for Restreamer instance");
    }

    return `${rtmpPort.externalIp}:${rtmpPort.externalPort}`;
  }

  private startGracePeriod(): void {
    if (this.gracePeriodTimer) return; // Already running
    this.state = "stopping";
    this.log.info(
      `No active streams — Restreamer shutdown in ${this.gracePeriodMs / 60000} minutes`
    );

    this.gracePeriodTimer = setTimeout(async () => {
      this.gracePeriodTimer = null;
      if (this.activeStreamCount > 0 || this.pausedStreamCount > 0) {
        this.state = "running";
        return;
      }
      await this.forceStop();
    }, this.gracePeriodMs);
  }

  private cancelGracePeriod(): void {
    if (this.gracePeriodTimer) {
      clearTimeout(this.gracePeriodTimer);
      this.gracePeriodTimer = null;
      if (this.state === "stopping") {
        this.state = "running";
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
