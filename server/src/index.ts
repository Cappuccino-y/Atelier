import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { WebSocket } from "@fastify/websocket";
import "./db.js";
import { registerSocket } from "./broadcast.js";
import { config } from "./config.js";
import { ensureOpencodeAgents } from "./opencode-config.js";

const routeNames = [
  "rooms",
  "messages",
  "tasks",
  "agents",
  "events",
  "routing",
  "review",
  "mcp",
  "runtime",
  "debug",
  "memory",
] as const;

type RouteModule = {
  default?: FastifyPluginAsync;
  routes?: FastifyPluginAsync;
};

type WsMessage = {
  type?: unknown;
  payload?: unknown;
};

type WsRawData = string | Buffer | ArrayBuffer | Buffer[];

export const app = Fastify({ logger: true });

function sendSocket(ws: WebSocket, type: string, payload: unknown) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify({ type, payload, ts: Date.now() }));
  } catch {}
}

function rawMessageToString(raw: WsRawData) {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString();
  if (Array.isArray(raw)) return Buffer.concat(raw).toString();
  return raw.toString();
}

async function registerRouteModules(fastify: FastifyInstance) {
  for (const routeName of routeNames) {
    try {
      const routeModule = (await import(`./routes/${routeName}.js`)) as RouteModule;
      const routes = routeModule.default ?? routeModule.routes;
      if (typeof routes !== "function") {
        fastify.log.warn(`Skipping ${routeName} route module: no routes export`);
        continue;
      }
      fastify.register(routes);
    } catch (error) {
      fastify.log.warn({ err: error, route: routeName }, `Skipping unavailable ${routeName} route module`);
    }
  }
}

async function configureApp(fastify: FastifyInstance) {
  await fastify.register(cors, { origin: true });
  await fastify.register(websocket);

  fastify.get("/ws", { websocket: true }, (socket) => {
    registerSocket(socket);

    const heartbeat = setInterval(() => {
      sendSocket(socket, "ping", null);
    }, 25_000);

    socket.on("message", (raw: WsRawData) => {
      try {
        const message = JSON.parse(rawMessageToString(raw)) as WsMessage;
        if (!message || typeof message !== "object") return;
        if (message.type === "ping") {
          sendSocket(socket, "pong", message.payload ?? null);
        }
      } catch (error) {
        fastify.log.warn({ err: error }, "Invalid WebSocket message");
      }
    });

    const clearHeartbeat = () => clearInterval(heartbeat);
    socket.on("close", clearHeartbeat);
    socket.on("error", clearHeartbeat);
  });

  await registerRouteModules(fastify);
}

async function start() {
  try {
    // Keep the opencode CLI config in sync with Atelier's bundled agents.
    // Missing agents (e.g. writer/scout/analyst on an upgrade) get merged
    // into ~/.config/opencode/opencode.json so opencode run --agent <name>
    // finds them. provider/mcp/plugin blocks are preserved untouched.
    try {
      const sync = ensureOpencodeAgents();
      if (sync.merged.length > 0) {
        app.log.info(`[opencode-config] merged agents: ${sync.merged.join(", ")}`);
      }
      if (sync.copied.length > 0) {
        app.log.info(`[opencode-config] copied prompt files: ${sync.copied.join(", ")}`);
      }
      if (sync.skipped) {
        app.log.warn(`[opencode-config] skipped: ${sync.skipReason}`);
      }
    } catch (err) {
      app.log.warn({ err }, "[opencode-config] sync failed (non-fatal)");
    }

    await configureApp(app);
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

void start();
