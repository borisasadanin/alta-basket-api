import type { RestreamerProcess } from "./types.js";

const PROCESS_PREFIX = "alta-";
const SAT_TOKEN_URL = "https://token.svc.prod.osaas.io/servicetoken";
const SAT_SERVICE_ID = "datarhei-restreamer";

export class RestreamerClient {
  private baseUrl: string;
  private oscPat: string;
  private rtmpHost: string;
  private sat: string | null = null;
  private satExpiry = 0;

  constructor(baseUrl: string, oscPat: string, rtmpHost: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.oscPat = oscPat;
    this.rtmpHost = rtmpHost;
  }

  // --- OSC Service Access Token ---

  private async getServiceToken(): Promise<string> {
    if (this.sat && Date.now() / 1000 < this.satExpiry - 60) {
      return this.sat;
    }

    const res = await fetch(SAT_TOKEN_URL, {
      method: "POST",
      headers: {
        "x-pat-jwt": `Bearer ${this.oscPat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serviceId: SAT_SERVICE_ID }),
    });

    if (!res.ok) throw new Error(`OSC SAT request failed: ${res.status}`);
    const data = (await res.json()) as { token: string; expiry: number };
    this.sat = data.token;
    this.satExpiry = data.expiry;
    return this.sat;
  }

  // --- Authenticated request (SAT only, Restreamer auth disabled) ---

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const sat = await this.getServiceToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${sat}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // SAT expired — refresh and retry once
    if (res.status === 401 || res.status === 403) {
      this.sat = null;
      this.satExpiry = 0;
      const newSat = await this.getServiceToken();
      const retry = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${newSat}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!retry.ok)
        throw new Error(`Restreamer ${method} ${path}: ${retry.status}`);
      if (retry.status === 204) return {} as T;
      return (await retry.json()) as T;
    }

    if (!res.ok)
      throw new Error(`Restreamer ${method} ${path}: ${res.status}`);
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  // --- Process management ---

  async createProcess(streamId: string): Promise<RestreamerProcess> {
    const processId = `${PROCESS_PREFIX}${streamId}`;

    const processConfig = {
      id: processId,
      autostart: true,
      reconnect: true,
      reconnect_delay_seconds: 5,
      stale_timeout_seconds: 60,
      input: [
        {
          id: "input",
          address: `{rtmp,name=live/${streamId}}`,
          options: ["-f", "live_flv"],
        },
      ],
      output: [
        {
          id: "output",
          address: `{memfs}/${streamId}.m3u8`,
          options: [
            "-codec",
            "copy",
            "-f",
            "hls",
            "-hls_time",
            "4",
            "-hls_list_size",
            "6",
            "-hls_flags",
            "delete_segments",
          ],
        },
      ],
    };

    return this.request<RestreamerProcess>(
      "POST",
      "/api/v3/process",
      processConfig
    );
  }

  async deleteProcess(streamId: string): Promise<void> {
    const processId = `${PROCESS_PREFIX}${streamId}`;
    await this.request("DELETE", `/api/v3/process/${processId}`);
  }

  async listAltaProcesses(): Promise<RestreamerProcess[]> {
    const all = await this.request<RestreamerProcess[]>(
      "GET",
      `/api/v3/process?idpattern=${PROCESS_PREFIX}*`
    );
    return all;
  }

  async getProcess(streamId: string): Promise<RestreamerProcess | null> {
    const processId = `${PROCESS_PREFIX}${streamId}`;
    try {
      return await this.request<RestreamerProcess>(
        "GET",
        `/api/v3/process/${processId}`
      );
    } catch {
      return null;
    }
  }

  // --- Helpers ---

  rtmpUrl(streamId: string): string {
    return `rtmp://${this.rtmpHost}/live/${streamId}`;
  }

  hlsUrl(streamId: string): string {
    return `${this.baseUrl}/memfs/${streamId}.m3u8`;
  }

  async isHlsLive(streamId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/memfs/${streamId}.m3u8`, { method: "HEAD" });
      return res.ok;
    } catch {
      return false;
    }
  }
}
