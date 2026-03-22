/**
 * Shared in-memory state — imported by route modules.
 */
import { RestreamerClient } from "./restreamer.js";
import { OscInstanceManager } from "./osc-manager.js";
import { MinioClient } from "./minio.js";
import type { SegmentCollector } from "./segment-collector.js";
import type { HighlightClip } from "./types.js";

export interface StreamMeta {
  name: string;
  createdAt: string;
  stoppedAt?: string;
  deviceId?: string;
  wasLive?: boolean;
  /** ISO timestamp when stream was paused (undefined = not paused) */
  pausedAt?: string;
  /** Current recording part number (starts at 1, increments on each resume) */
  partNumber: number;
  /** List of completed part numbers (for playlist stitching on stop) */
  completedParts: number[];
}

/** In-memory stream metadata */
export const streamMeta = new Map<string, StreamMeta>();

/** Active segment collectors — one per recording stream */
export const collectors = new Map<string, SegmentCollector>();

/** In-memory highlight clips per stream */
export const clipsByStream = new Map<string, HighlightClip[]>();

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
