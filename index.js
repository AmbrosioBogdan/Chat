import express from "express";
import { Readable } from "stream";
import fs from "fs";
import path from "path";

const app = express();

// Log file configuration
const logDir = process.env.LOG_DIR || "/tmp";
const logFilePath = path.join(logDir, "mcp-proxy.log");
const maxLogLines = 1000;
let logBuffer = [];

// IMPORTANT: per fare da proxy MCP dobbiamo poter inoltrare request/response.
// Per la maggior parte dei casi manteniamo `express.raw` per semplicità,
// ma non lo usiamo per streaming pass-through. Qui lo lasciamo come limite.
app.use(express.raw({ type: "*/*", limit: "10mb" }));

const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET || process.env.MCP_SHARED_SECRET; // tuo secret nell'URL
const RENDER_API_KEY = process.env.RENDER_API_KEY; // API key Render (Bearer)

const UPSTREAM_MCP_URL = process.env.UPSTREAM_MCP_URL || "https://mcp.render.com/mcp";

// semplice logger con timestamp e salvataggio su file
function now() {
  return new Date().toISOString();
}

function log(...args) {
  const timestamp = now();
  const msg = `${timestamp} [MCP-PROXY] ${args.map(a => 
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  ).join(" ")}`;
  
  console.log(msg);
  
  // Salva nel buffer in memoria
  logBuffer.push(msg);
  if (logBuffer.length > maxLogLines) {
    logBuffer.shift();
  }
  
  // Salva su file in modo sincrono per garantire persistenza
  try {
    fs.appendFileSync(logFilePath, msg + "\n");
  } catch (err) {
    console.error("Log file write error:", err?.message ?? err);
  }
}

process.on("uncaughtException", (err) => {
  console.error(now(), "uncaughtException", err && err.stack ? err.stack : err);
  // non exiting to allow debugging — in produzione si potrebbe process.exit(1)
});
process.on("unhandledRejection", (reason) => {
  console.error(now(), "unhandledRejection", reason);
});

// Log configuration at startup (mask sensitive values)
function mask(s) {
  if (!s) return "(missing)";
  if (s.length <= 8) return "(masked)";
  return s.slice(0, 4) + "…" + s.slice(-4);
}

log("Starting server with config:", {
  PORT: process.env.PORT || 10000,
  UPSTREAM_MCP_URL,
  RENDER_API_KEY: mask(RENDER_API_KEY),
  MCP_PATH_SECRET: mask(MCP_PATH_SECRET || process.env.MCP_SHARED_SECRET),
  UPSTREAM_TIMEOUT_MS: process.env.UPSTREAM_TIMEOUT_MS || 120000,
});
log("Log file:", logFilePath);
log("Log buffer size:", maxLogLines, "lines");
log("═".repeat(60));

function checkSecret(req, res) {
  if (!MCP_PATH_SECRET) return true;
  const provided = req.params.secret;
  if (provided !== MCP_PATH_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// Generate request ID per tracciare richieste end-to-end
function generateRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Healthcheck semplice
app.get("/", (_req, res) => res.status(200).send("ok"));

// Endpoint per visualizzare i log (ultimi 100 linee)
app.get("/logs", (req, res) => {
  const lines = req.query.lines ? parseInt(req.query.lines) : 100;
  const recent = logBuffer.slice(Math.max(0, logBuffer.length - lines));
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send(recent.join("\n"));
});

// Endpoint per visualizzare i log come JSON (per parsing automatico)
app.get("/logs/json", (req, res) => {
  const lines = req.query.lines ? parseInt(req.query.lines) : 100;
  const recent = logBuffer.slice(Math.max(0, logBuffer.length - lines));
  res.json({ 
    count: recent.length, 
    lines: recent,
    timestamp: new Date().toISOString()
  });
});

// Endpoint per visualizzare i log con autenticazione secret
app.get("/mcp/:secret/logs", (req, res) => {
  if (!checkSecret(req, res)) return;
  const lines = req.query.lines ? parseInt(req.query.lines) : 200;
  const recent = logBuffer.slice(Math.max(0, logBuffer.length - lines));
  res.json({ 
    count: recent.length,
    logFile: logFilePath,
    lines: recent,
    timestamp: new Date().toISOString()
  });
});

// Healthcheck per verificare secret
app.get("/mcp/:secret/health", (req, res) => {
  if (!checkSecret(req, res)) return;
  res.json({ ok: true, proxy: true, timestamp: new Date().toISOString() });
});

// Proxy MCP (GET/POST) verso Render hosted MCP
app.all("/mcp/:secret", async (req, res) => {
  const requestId = generateRequestId();
  const reqLog = (msg) => log(`[${requestId}]`, msg);
  
  try {
    if (!checkSecret(req, res)) return;

    if (!RENDER_API_KEY) {
      return res.status(500).json({ error: "Missing RENDER_API_KEY env var" });
    }

    reqLog(`→ INCOMING ${req.method} ${req.originalUrl}`);
    
    // Extract and log workspace/method info from body for debugging
    let bodyInfo = "";
    if (req.body) {
      try {
        let b = req.body;
        if (Buffer.isBuffer(b)) {
          b = JSON.parse(b.toString("utf8"));
        }
        if (b.params?.workspace_id) {
          bodyInfo = ` | workspace=${b.params.workspace_id}`;
        }
        if (b.method) {
          bodyInfo += ` | method=${b.method}`;
        }
        reqLog(`Body info${bodyInfo} | size=${Buffer.isBuffer(req.body) ? req.body.length : JSON.stringify(req.body).length} bytes`);
      } catch (e) {
        reqLog(`Body parse error: ${e?.message}`);
      }
    }
    
    // Copiamo gli header della request come semplice oggetto, escludendo quelli problematici
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v) continue;
      const key = k.toLowerCase();
      if (key === "host" || key === "connection" || key === "content-length") continue;
      headers[k] = Array.isArray(v) ? v.join(",") : v;
    }

    // Forziamo auth per l'upstream Render MCP
    headers["Authorization"] = `Bearer ${RENDER_API_KEY}`;

    // Assicuriamoci che SSE sia accettato (ChatGPT se lo aspetta)
    if (!headers["Accept"] && !headers["accept"]) {
      headers["Accept"] = "text/event-stream";
    }

    const method = req.method.toUpperCase();
    const hasBody = !(method === "GET" || method === "HEAD");

    // timeout/abort in caso di upstream che resta appeso
    const controller = new AbortController();
    const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
    const timeoutId = setTimeout(() => {
      reqLog("✗ Upstream timeout after " + timeoutMs + "ms");
      try { controller.abort(); } catch (e) {}
    }, timeoutMs);

    // Per ora inoltriamo solo body bufferizzati (express.raw). Evitiamo conversioni complesse.
    const bodyToSend = hasBody && req.body && Buffer.isBuffer(req.body) ? req.body : undefined;

    reqLog(`↗ UPSTREAM ${method} → ${UPSTREAM_MCP_URL}`);
    const upstreamResp = await fetch(UPSTREAM_MCP_URL, {
      method,
      headers,
      body: hasBody ? bodyToSend : undefined,
      duplex: hasBody ? "half" : undefined,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    reqLog(`← RESPONSE ${upstreamResp.status} ${upstreamResp.statusText}`);

    // Propaghiamo status e header (incluso Content-Type: text/event-stream)
    res.status(upstreamResp.status);

    // Ensure SSE clients get headers flushed early
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Log all response headers from upstream before setting them
    upstreamResp.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      // Evitiamo header che Express gestisce da solo o che possono essere problematici
      if (k === "transfer-encoding") return;
      // CRITICO: rimuovere content-encoding E content-length
      // Node.js fetch() decomprime AUTOMATICAMENTE il body, quindi:
      // - Se era compresso (br/gzip), il decompresso è PIÙ GRANDE
      // - Se propaghiamo content-length originale, client vede mismatch e chiude
      // - Se propaghiamo content-encoding, client cercapotrebbe decomprimere dati già decompressti
      if (k === "content-encoding") {
        reqLog("Stripping content-encoding (auto-decompressed by fetch)");
        return;
      }
      if (k === "content-length") {
        reqLog("Stripping content-length (size mismatch after decompression)");
        return;
      }
      res.setHeader(key, value);
    });

    // Forziamo chunked transfer encoding perché non sappiamo la size dopo decompressione
    res.setHeader("Transfer-Encoding", "chunked");

    // Stream della risposta — SEMPRE streaming passthrough (no buffering, no manual decompression)
    // Node.js fetch() decomprime automaticamente. Usiamo pipe per trasparenza e 0-copy
    if (upstreamResp.body) {
      reqLog("Starting streaming response passthrough");
      Readable.fromWeb(upstreamResp.body);

      res.flushHeaders && res.flushHeaders();

      let chunkCount = 0;
      let totalBytes = 0;

      nodeStream.on("data", (chunk) => {
        chunkCount++;
        totalBytes += chunk.length;
        reqLog(`Chunk #${chunkCount}: ${chunk.length}B (total: ${totalBytes}B)`);
      });

      nodeStream.on("error", (err) => {
        reqLog(`✗ Stream error: ${err?.message ?? err}`);
        if (!res.headersSent) {
          res.status(502).json({ error: "Upstream stream failed: " + (err?.message ?? String(err)) });
        } else {
          res.end();
        }
      });

      res.on("close", () => {
        reqLog("Client closed connection");
        try { nodeStream.destroy(); } catch (e) { reqLog(`destroy error: ${e?.message}`); }
      });

      res.on("error", (err) => {
        reqLog(`✗ Response error: ${err?.message ?? err}`);
        try { nodeStream.destroy(); } catch {}
      });

      nodeStream.pipe(res);

      nodeStream.on("end", () => {
        reqLog(`✓ Complete: ${totalBytes}B in ${chunkCount} chunks`);
      });
    } else {
      reqLog("(no body)");
      res.end();
    }
  } catch (err) {
    reqLog(`✗ ERROR: ${err?.message ?? err}`);
    if (err?.stack) reqLog(err.stack);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
