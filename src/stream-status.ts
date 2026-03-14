/**
 * Shared helper to determine stream status based on HLS liveness
 * and stored metadata about whether the stream was ever live.
 */
export function determineStreamStatus(
  hlsLive: boolean,
  meta?: { wasLive?: boolean; stoppedAt?: string; pausedAt?: string }
): "live" | "waiting" | "stopped" | "paused" {
  if (meta?.pausedAt) return "paused";
  if (hlsLive) return "live";
  if (meta?.wasLive) return "stopped";
  return "waiting";
}
