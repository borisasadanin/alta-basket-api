/**
 * Restreamer admin routes: status, start, stop.
 */
import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../auth.js";
import { restreamer, oscManager } from "../state.js";

export default async function restreamerRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/restreamer/status — Return cached state instantly (background polling keeps it fresh)
  app.get("/api/restreamer/status", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    const { state, info } = oscManager.getCachedState();
    return reply.send({ state, info });
  });

  // POST /api/restreamer/start — Trigger Restreamer instance start (non-blocking, with crash recovery)
  app.post("/api/restreamer/start", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    const currentState = oscManager.getState();

    if (currentState === "running") {
      // Verify it's actually alive — if not, force-recreate in background
      const alive = await oscManager.quickHealthProbe();
      if (alive) {
        return reply.send({ state: "running", message: "Restreamer körs", info: oscManager.getInfo() });
      }
      // Broken instance — force-recreate in background
      request.log.info("Restreamer reports running but is unresponsive, force-recreating...");
      oscManager.forceRecreate().then((info) => {
        restreamer.rtmpHost = info.rtmpHost;
      }).catch((err) => {
        request.log.error(err, "Background Restreamer force-recreate failed");
      });
      return reply.send({ state: "starting", message: "Restreamer svarar inte, återskapar..." });
    }

    if (currentState === "stopping") {
      // Grace period active — cancel it and stay running
      oscManager.ensureRunning().then((info) => {
        restreamer.rtmpHost = info.rtmpHost;
      }).catch((err) => {
        request.log.error(err, "Background Restreamer start failed");
      });
      return reply.send({ state: "starting", message: "Avbryter nedstängning, startar om..." });
    }

    if (currentState !== "starting") {
      // Fire and forget — client polls /status to track progress
      oscManager.ensureRunning().then((info) => {
        restreamer.rtmpHost = info.rtmpHost;
      }).catch((err) => {
        request.log.error(err, "Background Restreamer start failed");
      });
    }
    return reply.send({ state: "starting", message: "Restreamer startar..." });
  });

  // DELETE /api/restreamer/stop — Force-stop Restreamer instance
  app.delete("/api/restreamer/stop", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;
    try {
      await oscManager.forceStop();
      return reply.code(204).send();
    } catch (err) {
      request.log.error(err, "Failed to stop Restreamer");
      return reply.code(500).send({ error: "Failed to stop Restreamer" });
    }
  });
}
