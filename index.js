import express from "express";
import axios from "axios";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json());

// ---- Config ----
const RENDER_API_BASE = "https://api.render.com/v1";
const RENDER_API_KEY = process.env.RENDER_API_KEY;

// Secret nel path (protezione semplice)
const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET;

// Funzione che crea un nuovo MCP server ogni volta
function buildMcpServer() {
  const server = new McpServer({
    name: "render-mcp",
    version: "1.0.0",
  });

  // Tool: lista servizi
  server.tool(
    "render_list_services",
    "List Render services",
    z.object({}),
    async () => {
      if (!RENDER_API_KEY) {
        return {
          content: [{ type: "text", text: "Missing RENDER_API_KEY env var." }],
        };
      }

      const r = await axios.get(`${RENDER_API_BASE}/services`, {
        headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
      });

      const simplified = r.data.map((x) => ({
        id: x.service?.id,
        name: x.service?.name,
        type: x.service?.type,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }],
      };
    }
  );

  // Tool: trigger deploy
  server.tool(
    "render_deploy_service",
    "Trigger a deploy for a Render service by serviceId",
    z.object({
      serviceId: z.string().min(1),
    }),
    async ({ serviceId }) => {
      if (!RENDER_API_KEY) {
        return {
          content: [{ type: "text", text: "Missing RENDER_API_KEY env var." }],
        };
      }

      const r = await axios.post(
        `${RENDER_API_BASE}/services/${serviceId}/deploys`,
        {},
        {
          headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
        }
      );

      return {
        content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }],
      };
    }
  );

  return server;
}

// Healthcheck (utile per Render)
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

// Endpoint MCP
app.all("/mcp/:secret?", async (req, res) => {
  try {
    if (MCP_PATH_SECRET) {
      const providedSecret = req.params.secret;
      if (providedSecret !== MCP_PATH_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport(req, res);

    await server.connect(transport);
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render MCP server listening on port ${PORT}`);
});
