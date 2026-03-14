/**
 * Auth endpoints: PIN verification, token management.
 */
import type { FastifyInstance } from "fastify";
import { config, mutableConfig } from "../config.js";
import {
  requireApiKey,
  createViewerToken,
  createAdminToken,
  viewerTokens,
} from "../auth.js";

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/auth/status — Check if PIN protection is active
  app.get("/api/auth/status", async (_request, reply) => {
    return reply.send({ pinRequired: !!mutableConfig.VIEWER_PIN });
  });

  // POST /api/auth/verify — Verify viewer or admin PIN and return session token(s)
  app.post<{ Body: { pin?: string } }>("/api/auth/verify", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!mutableConfig.VIEWER_PIN) {
      // No PIN configured — return a token anyway
      return reply.send({ token: createViewerToken(), role: "viewer" });
    }

    const { pin } = request.body || {};

    // Check admin PIN first
    if (pin && pin === config.ADMIN_PIN) {
      const viewerTok = createViewerToken();
      const adminTok = createAdminToken();
      return reply.send({ token: viewerTok, role: "admin", adminToken: adminTok });
    }

    // Check viewer PIN
    if (!pin || pin !== mutableConfig.VIEWER_PIN) {
      return reply.code(401).send({ error: "Fel kod" });
    }

    const token = createViewerToken();
    return reply.send({ token, role: "viewer" });
  });

  // POST /api/auth/admin — Verify admin PIN and return an admin token
  app.post<{ Body: { pin?: string } }>("/api/auth/admin", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const { pin } = request.body || {};
    if (!pin || pin !== config.ADMIN_PIN) {
      return reply.code(401).send({ error: "Fel admin-kod" });
    }

    const token = createAdminToken();
    return reply.send({ token });
  });

  // PUT /api/auth/pin — Change the viewer PIN (admin, requires API key)
  app.put<{ Body: { pin?: string } }>("/api/auth/pin", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;

    const { pin } = request.body || {};
    if (!pin || typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) {
      return reply.code(400).send({ error: "PIN must be 4-8 digits" });
    }

    mutableConfig.VIEWER_PIN = pin;
    // Invalidate all existing viewer tokens so everyone must re-enter the new PIN
    viewerTokens.clear();

    app.log.info(`Viewer PIN updated (${pin.length} digits)`);
    return reply.send({ ok: true, pinLength: pin.length });
  });
}
