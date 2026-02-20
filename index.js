import express from "express";
import axios from "axios";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();

// Body parser (serve per POST MCP)
app.use(express.json({ limit: "1mb" }));

// CORS + preflight (alcuni client fanno OPTIONS)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- Config ----
const RENDER_API_BASE = "https://api.render.com/v1";
const RENDER_API_KEY = process.env.RENDER_API_KEY;

// Secret nel path (protezione semplice)
const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET;

function assertSecret(req, res) {
  if (!MCP_PATH_SECRET) return true; // se non settato, non bloccare
  const got = req.params.secret;
  if (got !== MCP_PATH_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// Crea un nuovo MCP server per ogni connessione
function buildMcpServer() {
  const server = new McpServer({ name: "render-mcp", version: "1.0.0" });

  server.tool(
    "render_list_services",
    "List Render services",
    z.object({}),
    async () => {
      if (!RENDER_API_KEY) {
        return { content: [{ type: "text", text: "Missing RENDER_API_KEY env var." }] };
      }

      const r = await axios.get(`${RENDER_API_BASE}/services`, {
        headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
      });

      const simplified = r.data.map((x) => ({
        id: x.service?.id,
        name: x.service?.name,
        type: x.service?.type,
      }));

      return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
    }
  );

  server.tool(
    "render_deploy_service",
    "Trigger a deploy for a Render service by serviceId",
    z.object({ serviceId: z.string().min(1) }),
    async ({ serviceId }) => {
      if (!RENDER_API_KEY) {
        return { content: [{ type: "text", text: "Missing RENDER_API_KEY env var." }] };
      }

      const r = await axios.post(
        `${RENDER_API_BASE}/services/${serviceId}/deploys`,
        {},
        { headers: { Authorization: `Bearer ${RENDER_API_KEY}` } }
      );

      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }] };
    }
  );

  return server;
}

// Healthcheck generale
app.get("/", (_req, res) => res.status(200).send("ok"));

// Healthcheck MCP (IMPORTANTISSIMO per capire se stai prendendo HTML da Render o il tuo JSON)
app.get("/mcp/:secret/health", (req, res) => {
  if (!assertSecret(req, res)) return;
  res.json({ ok: true, mcp: true });
});

// MCP: SOLO POST
app.post("/mcp/:secret", async (req, res) => {
  try {
    if (!assertSecret(req, res)) return;

    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport(req, res);
    await server.connect(transport);
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
