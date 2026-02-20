import express from "express";

const app = express();

// IMPORTANT: per fare da proxy MCP dobbiamo leggere il body "grezzo"
app.use(express.raw({ type: "*/*", limit: "10mb" }));

const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET; // tuo secret nell'URL
const RENDER_API_KEY = process.env.RENDER_API_KEY;   // API key Render (Bearer)

const UPSTREAM_MCP_URL = "https://mcp.render.com/mcp";

function checkSecret(req, res) {
  if (!MCP_PATH_SECRET) return true;
  const provided = req.params.secret;
  if (provided !== MCP_PATH_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// Healthcheck semplice
app.get("/", (_req, res) => res.status(200).send("ok"));

// Healthcheck per verificare secret
app.get("/mcp/:secret/health", (req, res) => {
  if (!checkSecret(req, res)) return;
  res.json({ ok: true, proxy: true });
});

// Proxy MCP (GET/POST) verso Render hosted MCP
app.all("/mcp/:secret", async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;

    if (!RENDER_API_KEY) {
      return res.status(500).json({ error: "Missing RENDER_API_KEY env var" });
    }

    // Copiamo gli header della request, ma ripuliamo quelli che creano problemi in proxy
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v) continue;
      const key = k.toLowerCase();
      if (key === "host") continue;
      if (key === "connection") continue;
      if (key === "content-length") continue;
      headers.set(k, Array.isArray(v) ? v.join(",") : v);
    }

    // Forziamo auth per l'upstream Render MCP
    headers.set("Authorization", `Bearer ${RENDER_API_KEY}`);

    // Assicuriamoci che SSE sia accettato (ChatGPT se lo aspetta)
    if (!headers.get("Accept")) {
      headers.set("Accept", "text/event-stream");
    }

    const method = req.method.toUpperCase();
    const hasBody = !(method === "GET" || method === "HEAD");

    // Node fetch: se mandi body con stream, serve duplex; con Buffer va bene comunque,
    // ma aggiungiamo duplex per robustezza.
    const upstreamResp = await fetch(UPSTREAM_MCP_URL, {
      method,
      headers,
      body: hasBody ? req.body : undefined,
      duplex: hasBody ? "half" : undefined,
    });

    // Propaghiamo status e header (incluso Content-Type: text/event-stream)
    res.status(upstreamResp.status);

    upstreamResp.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      // Evitiamo header che Express gestisce da solo o che possono essere problematici
      if (k === "transfer-encoding") return;
      res.setHeader(key, value);
    });

    // Stream della risposta (SSE incluso)
    if (upstreamResp.body) {
      const reader = upstreamResp.body.getReader();
      res.on("close", () => {
        try { reader.cancel(); } catch {}
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      res.end();
    }
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
