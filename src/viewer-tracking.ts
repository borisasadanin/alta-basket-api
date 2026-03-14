/**
 * Viewer counting logic — heartbeat maps with TTL-based IP deduplication.
 */

const VIEWER_TTL_MS = 60_000; // 60s without heartbeat = viewer gone

/** streamId -> Map<ip, lastSeenTimestamp> */
export const viewers = new Map<string, Map<string, number>>();

export function registerViewer(streamId: string, ip: string): void {
  if (!viewers.has(streamId)) viewers.set(streamId, new Map());
  viewers.get(streamId)!.set(ip, Date.now());
}

export function getViewerCount(streamId: string): number {
  const map = viewers.get(streamId);
  if (!map) return 0;
  const now = Date.now();
  for (const [ip, ts] of map) {
    if (now - ts > VIEWER_TTL_MS) map.delete(ip);
  }
  return map.size;
}
