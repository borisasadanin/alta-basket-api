/**
 * Shared in-memory state — imported by route modules.
 */
import { RestreamerClient } from "./restreamer.js";
import { OscInstanceManager } from "./osc-manager.js";
import { MinioClient } from "./minio.js";

export interface StreamMeta {
  name: string;
  createdAt: string;
  stoppedAt?: string;
  deviceId?: string;
  wasLive?: boolean;
}

/** In-memory stream metadata */
export const streamMeta = new Map<string, StreamMeta>();

/**
 * Service singletons — set once at startup by index.ts.
 * Route modules import these references.
 */
export let restreamer: RestreamerClient;
export let minio: MinioClient;
export let oscManager: OscInstanceManager;

export function initServices(r: RestreamerClient, m: MinioClient, o: OscInstanceManager): void {
  restreamer = r;
  minio = m;
  oscManager = o;
}
