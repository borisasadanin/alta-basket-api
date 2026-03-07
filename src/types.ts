export interface StreamInfo {
  id: string;
  name: string;
  rtmpUrl: string;
  hlsUrl: string;
  createdAt: string;
}

export interface StreamPublicInfo {
  id: string;
  name: string;
  hlsUrl: string;
  createdAt: string;
  status: "live" | "waiting";
  viewers: number;
}

export interface CreateStreamBody {
  name: string;
}

export interface RestreamerProcess {
  id: string;
  reference: string;
  config: {
    id: string;
    input: { id: string; address: string; options: string[] }[];
    output: { id: string; address: string; options: string[] }[];
    autostart: boolean;
    reconnect: boolean;
    reconnect_delay_seconds: number;
    stale_timeout_seconds: number;
  };
  state?: {
    exec: string; // "running" | "finished" | "failed"
    runtime_seconds: number;
  };
  metadata?: Record<string, unknown>;
}
