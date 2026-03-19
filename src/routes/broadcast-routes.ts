/**
 * Broadcast state routes: public status for website viewers,
 * manual control for iOS app operators.
 */
import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../auth.js";
import { getBroadcastState, setBroadcastState, VALID_STATUSES } from "../broadcast-state.js";
import type { BroadcastStatus } from "../broadcast-state.js";

export default async function broadcastRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/broadcast — Public (no auth), returns current broadcast state
  app.get("/api/broadcast", async (_request, reply) => {
    return reply.send(getBroadcastState());
  });

  // PATCH /api/broadcast — Set broadcast state manually (requires API key)
  app.patch<{ Body: { status: string; message?: string } }>("/api/broadcast", async (request, reply) => {
    if (!requireApiKey(request, reply)) return;

    const { status, message } = request.body || {};

    if (!status || !VALID_STATUSES.includes(status as BroadcastStatus)) {
      return reply.code(400).send({
        error: "invalid_status",
        message: `Status måste vara en av: ${VALID_STATUSES.join(", ")}`,
      });
    }

    const newState = setBroadcastState(status as BroadcastStatus, message);
    return reply.send(newState);
  });
}
