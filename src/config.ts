/**
 * Centralized configuration — all env vars, constants, and validation.
 * Exits the process if required variables are missing.
 */

const PORT = parseInt(process.env.PORT || "8000", 10);
const API_KEY = process.env.API_KEY || "alta-basket-2026";
const ADMIN_PIN = process.env.ADMIN_PIN || "804480";
const VIEWER_PIN = process.env.VIEWER_PIN || "123456";
const OSC_PAT = process.env.OSC_ACCESS_TOKEN || "";
const OSC_INSTANCE_NAME = process.env.OSC_INSTANCE_NAME || "restreamerlive";
const RESTREAMER_URL =
  process.env.RESTREAMER_URL ||
  `https://borispriv-${OSC_INSTANCE_NAME}.datarhei-restreamer.auto.prod.osaas.io`;
const RESTREAMER_GRACE_PERIOD_MS = parseInt(
  process.env.RESTREAMER_GRACE_PERIOD_MS || String(15 * 60 * 1000),
  10
);

const MINIO_ENDPOINT =
  process.env.MINIO_ENDPOINT ||
  "https://borispriv-basket.minio-minio.auto.prod.osaas.io";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "root";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "37be8999e5d3d04615705921defbaea9";
const MINIO_RECORDINGS_BUCKET = "recordings";

const VIEWER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STOPPED_TTL_MS = 10 * 60 * 1000; // 10 minutes

// --- Validation (fatal on missing required vars) ---

export function validateConfig(): void {
  if (!OSC_PAT) {
    console.error("Missing OSC_ACCESS_TOKEN");
    process.exit(1);
  }
  if (!VIEWER_PIN) {
    console.warn("VIEWER_PIN not set — viewer access is unprotected");
  }
}

export const config = {
  PORT,
  API_KEY,
  ADMIN_PIN,
  VIEWER_PIN,
  OSC_PAT,
  OSC_INSTANCE_NAME,
  RESTREAMER_URL,
  RESTREAMER_GRACE_PERIOD_MS,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_RECORDINGS_BUCKET,
  VIEWER_TOKEN_TTL_MS,
  ADMIN_TOKEN_TTL_MS,
  STOPPED_TTL_MS,
} as const;

/**
 * Mutable reference for VIEWER_PIN — needed because PUT /api/auth/pin can
 * change it at runtime.
 */
export const mutableConfig = {
  VIEWER_PIN,
};
