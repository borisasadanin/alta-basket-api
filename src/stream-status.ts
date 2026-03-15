/**
 * Shared helper to determine stream status based on HLS liveness
 * and stored metadata about whether the stream was ever live.
 */
export function determineStreamStatus(
  hlsLive: boolean,
  meta?: { wasLive?: boolean; stoppedAt?: string; pausedAt?: string }
): "live" | "waiting" | "stopped" | "paused" {
  // Explicit stop (set by DELETE route or cleanup timer) — always trust
  if (meta?.stoppedAt) return "stopped";
  if (meta?.pausedAt) return "paused";
  if (hlsLive) return "live";
  // Stream was recently live but HLS check failed (transient network hiccup).
  // Return "live" (optimistic) — only the cleanup timer should mark as "stopped"
  // after confirming the Restreamer process is truly dead for 3+ minutes.
  if (meta?.wasLive) return "live";
  return "waiting";
}
