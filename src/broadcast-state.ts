/**
 * Broadcast state — controls what viewers see on the website
 * when no active streams exist (upcoming match, post-match thank you, etc.)
 */

export type BroadcastStatus = "idle" | "upcoming" | "live" | "paused" | "ended";

export interface BroadcastState {
  status: BroadcastStatus;
  message?: string;
  updatedAt: string;
}

const ENDED_TTL_MS = 5 * 60 * 1000; // 5 minutes before "ended" expires to "idle"

let currentState: BroadcastState = {
  status: "idle",
  updatedAt: new Date().toISOString(),
};

let endedTimer: ReturnType<typeof setTimeout> | null = null;

export function getBroadcastState(): BroadcastState {
  return currentState;
}

export function setBroadcastState(status: BroadcastStatus, message?: string): BroadcastState {
  // Clear any existing ended timer
  if (endedTimer) {
    clearTimeout(endedTimer);
    endedTimer = null;
  }

  currentState = {
    status,
    message,
    updatedAt: new Date().toISOString(),
  };

  // Auto-expire "ended" back to "idle" after 5 minutes
  if (status === "ended") {
    endedTimer = setTimeout(() => {
      currentState = { status: "idle", updatedAt: new Date().toISOString() };
      endedTimer = null;
    }, ENDED_TTL_MS);
  }

  return currentState;
}

/** Valid broadcast statuses for input validation */
export const VALID_STATUSES: BroadcastStatus[] = ["idle", "upcoming", "live", "paused", "ended"];
