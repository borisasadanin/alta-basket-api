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

interface OscManagerOptions {
  instanceName: string;
  gracePeriodMs?: number;
  startupTimeoutMs?: number;
  healthPollMs?: number;
  logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
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

  constructor(opts: OscManagerOptions) {
    this.ctx = new Context();
    this.instanceName = opts.instanceName;
    this.gracePeriodMs = opts.gracePeriodMs ?? 15 * 60 * 1000;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 180_000;
    this.healthPollMs = opts.healthPollMs ?? 2000;
    this.log = opts.logger ?? { info: console.log, error: console.error };
  }

  getState(): InstanceState {
    return this.state;
  }

  getInfo(): InstanceInfo | null {
    return this.cachedInfo;
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

  streamStarted(): void {
    this.activeStreamCount++;
    this.cancelGracePeriod();
  }

  streamEnded(): void {
    this.activeStreamCount = Math.max(0, this.activeStreamCount - 1);
    if (this.activeStreamCount === 0 && this.state === "running") {
      this.startGracePeriod();
    }
  }

  syncActiveCount(count: number): void {
    const prev = this.activeStreamCount;
    this.activeStreamCount = Math.max(0, count);
    if (prev > 0 && this.activeStreamCount === 0 && this.state === "running") {
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

    // Wait for Restreamer to be healthy
    await this.waitForHealth(url);

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

    if (!rtmpConfig?.enable) {
      this.log.info("RTMP found disabled, re-enabling...");
      await this.enableRtmp(url, sat);
    }
  }

  private async waitForHealth(url: string): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { method: "GET" });
        if (res.ok) return;
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

    if (rtmpConfig?.enable) {
      this.log.info("RTMP already enabled");
      return;
    }

    // Enable RTMP in the inner config object
    const updatedConfig = {
      ...innerConfig,
      rtmp: { ...rtmpConfig, enable: true },
    };

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

    this.log.info("RTMP enabled, reloading config...");

    // Reload config (restarts core)
    await fetch(`${url}/api/v3/config/reload`, {
      headers: { Authorization: `Bearer ${sat}` },
    });

    // Wait for Restreamer to come back after reload
    await this.sleep(3000);
    await this.waitForHealth(url);
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
      if (this.activeStreamCount > 0) {
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
