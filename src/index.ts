import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import { config, validateConfig } from "./config.js";
import { startTokenCleanup } from "./auth.js";
import { initServices } from "./state.js";
import { RestreamerClient } from "./restreamer.js";
import { OscInstanceManager } from "./osc-manager.js";
import { MinioClient } from "./minio.js";

// Route plugins
import authRoutes from "./routes/auth-routes.js";
import streamRoutes from "./routes/streams.js";
import vodRoutes from "./routes/vod.js";
import adminRoutes from "./routes/admin.js";
import restreamerRoutes from "./routes/restreamer-routes.js";
import broadcastRoutes from "./routes/broadcast-routes.js";
import clipRoutes from "./routes/clip-routes.js";

// --- Validate required env vars (exits on failure) ---
validateConfig();

// --- Log Restreamer tenant for debugging ---
try {
  const payload = JSON.parse(Buffer.from(config.OSC_RESTREAMER_TOKEN.split(".")[1], "base64").toString());
  console.log(`Restreamer tenant: ${payload.tenantId}, URL: ${config.RESTREAMER_URL}`);
} catch { console.warn("Could not decode Restreamer token"); }

// --- Create service instances ---

const restreamer = new RestreamerClient(config.RESTREAMER_URL, config.OSC_RESTREAMER_TOKEN, "");
const minio = new MinioClient(config.MINIO_ENDPOINT, config.MINIO_ACCESS_KEY, config.MINIO_SECRET_KEY);
const oscManager = new OscInstanceManager({
  instanceName: config.OSC_INSTANCE_NAME,
  personalAccessToken: config.OSC_RESTREAMER_TOKEN,
  gracePeriodMs: config.RESTREAMER_GRACE_PERIOD_MS,
  logger: undefined as unknown as { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  s3Config: {
    endpoint: config.MINIO_ENDPOINT.replace(/^https?:\/\//, ""),
    accessKeyId: config.MINIO_ACCESS_KEY,
    secretAccessKey: config.MINIO_SECRET_KEY,
    bucket: config.MINIO_RECORDINGS_BUCKET,
  },
});

// --- Expose services to route modules ---
initServices(restreamer, minio, oscManager);

// --- Fastify setup ---

const app = Fastify({ logger: true });

// Patch logger into oscManager (needs app.log which is only available after Fastify creation)
(oscManager as unknown as { log: unknown }).log = app.log;

await app.register(cors, {
  origin: [
    "https://altacourtside.se",
    "https://borispriv-basket.minio-minio.auto.prod.osaas.io",
    /^https?:\/\/localhost(:\d+)?$/,
  ],
  methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
});
await app.register(rateLimit, { global: false });

// --- Register route plugins ---
await app.register(authRoutes);
await app.register(streamRoutes);
await app.register(vodRoutes);
await app.register(adminRoutes);
await app.register(restreamerRoutes);
await app.register(broadcastRoutes);
await app.register(clipRoutes);

// --- Health check ---
app.get("/health", async () => {
  const restreamerState = oscManager.getState();
  const minioReachable = await minio
    .readVodIndex()
    .then(() => true)
    .catch(() => false);

  return {
    status: "ok",
    components: {
      restreamer: restreamerState,
      minio: minioReachable ? "ok" : "unreachable",
    },
    activeStreams: oscManager.getActiveStreamCount(),
    uptime: process.uptime(),
  };
});

// --- Token cleanup timer ---
startTokenCleanup();

// --- Startup ---

// Ensure MinIO recordings bucket exists
try {
  await minio.ensureBucket();
  console.log("MinIO recordings bucket ready");
} catch (err) {
  console.error("Failed to initialize MinIO bucket (VOD will be unavailable):", err);
}

// Start background health polling for Restreamer
oscManager.startBackgroundPolling();

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`Alta Basket API running on port ${config.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
