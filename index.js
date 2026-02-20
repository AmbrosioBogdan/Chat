import express from "express";
import axios from "axios";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();

app.use(express.json({ limit: "1mb" }));

// CORS + preflight
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ================= CONFIG =================

const RENDER_API_BASE = "https://api.render.com/v1";
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET;

// ================= UTIL =================

function checkSecret(req, res) {
  if (!MCP_PATH_SECRET) return true;

  const provided = req.params.secret;
  if (provided !== MCP_PATH_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  return true;
}

// ================= MCP SERVER FACTORY =================

function createMcpServer() {
  const server = new McpServer({
    name: "render-mcp",
    version: "1.0.0",
  });

  // Tool 1: List services
  server.tool(
    "render_list_services",
    "List Render services",
    z.object({}),
    async () => {
      if (!RENDER_API_KEY) {
        return {
          content: [
            { type: "text", text: "Missing RENDER_API_KEY environment variable." },
          ],
        };
      }

      const response = await axios.get(`${RENDER_API_BASE}/services`, {
        headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
      });

      const simplified = response.data.map((x) => ({
        id: x.service?.id,
        name: x.service?.name,
        type: x.service?.type,
      }));

      return {
        content: [
          { type: "text", text: JSON.stringify(simplified, null, 2) },
        ],
      };
    }
  );

  // Tool 2: Trigger deploy
  server.tool(
    "render_deploy_service",
    "Trigger a deploy for a Render service",
    z.object({
      serviceId: z.string().min(1),
    }),
    async ({ serviceId }) => {
      if (!RENDER_API_KEY) {
        return {
          content: [
            { type: "text", text: "Missing RENDER_API_KEY environment variable." },
          ],
        };
      }

      const response = await axios.post(
        `${RENDER_API_BASE}/services/${serviceId}/deploys`,
        {},
        {
          headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
        }
      );

      return {
        content: [
          { type: "text", text: JSON.stringify(response.data, null, 2) },
        ],
      };
    }
  );

  return server;
}

// ================= ROUTES =================

// General health check
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

// MCP health check
app.get("/mcp/:secret/health", (req, res) => {
  if (!checkSecret(req, res)) return;
  res.json({ ok: true, mcp: true });
});

// IMPORTANT: GET handler for connector validation
app.get("/mcp/:secret", (req, res) => {
  if (!checkSecret(req, res)) return;
  res.json({ ok: true, message: "MCP endpoint ready. Use POST for transport." });
});

// MCP transport (POST only)
app.post("/mcp/:secret", async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport(req, res);

    await server.connect(transport);
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ================= START =================

const PORT = Number(process.env.PORT || 10000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render MCP server running on port ${PORT}`);
});
