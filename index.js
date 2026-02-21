import express from "express";
import { Readable } from "stream";
import { once } from "events";
import { createBrotliDecompress } from "zlib";

const app = express();

// IMPORTANT: per fare da proxy MCP dobbiamo poter inoltrare request/response.
// Per la maggior parte dei casi manteniamo `express.raw` per semplicità,
// ma non lo usiamo per streaming pass-through. Qui lo lasciamo come limite.
app.use(express.raw({ type: "*/*", limit: "10mb" }));

const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET || process.env.MCP_SHARED_SECRET; // tuo secret nell'URL
const RENDER_API_KEY = process.env.RENDER_API_KEY; // API key Render (Bearer)

const UPSTREAM_MCP_URL = process.env.UPSTREAM_MCP_URL || "https://mcp.render.com/mcp";

// semplice logger con timestamp
function now() {
  return new Date().toISOString();
}
function log(...args) {
  console.log(now(), ...args);
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

    log("Incoming request", req.method, req.originalUrl);
    log("Request headers", req.headers);
    // If body was parsed (small requests), log size
    if (req.body) {
      try {
        const len = Buffer.isBuffer(req.body) ? req.body.length : JSON.stringify(req.body).length;
        log("Request body size", len);
      } catch (e) {
        log("Request body size: unknown");
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
      log("Aborting upstream fetch due to timeout", timeoutMs);
      try { controller.abort(); } catch (e) {}
    }, timeoutMs);

    // Per ora inoltriamo solo body bufferizzati (express.raw). Evitiamo conversioni complesse.
    const bodyToSend = hasBody && req.body && Buffer.isBuffer(req.body) ? req.body : undefined;

    log("Forwarding to upstream", UPSTREAM_MCP_URL, "method", method);
    const upstreamResp = await fetch(UPSTREAM_MCP_URL, {
      method,
      headers,
      body: hasBody ? bodyToSend : undefined,
      duplex: hasBody ? "half" : undefined,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    log("Upstream responded", upstreamResp.status, upstreamResp.statusText);

    // Propaghiamo status e header (incluso Content-Type: text/event-stream)
    res.status(upstreamResp.status);

    // Ensure SSE clients get headers flushed early
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Log all response headers from upstream before setting them
    log("Upstream response headers:");
    upstreamResp.headers.forEach((value, key) => {
      log("  ", key, ":", value);
    });

    upstreamResp.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      // Evitiamo header che Express gestisce da solo o che possono essere problematici
      if (k === "transfer-encoding") return;
      // Rimuoviamo content-encoding perché potrebbe essere compresso da Render
      // e causerebbe problemi di decompressione al client
      if (k === "content-encoding") return;
      res.setHeader(key, value);
    });

    log("Response headers set on client connection");

    // Stream della risposta (SSE incluso) — usiamo pass-through pipe per evitare buffering
    // MA: se non è SSE, leggiamo tutto come buffer per evitare blocchi
    const contentType = upstreamResp.headers.get("content-type") || "";
    const isSSE = contentType.includes("text/event-stream");
    const contentLength = upstreamResp.headers.get("content-length");
    const isBinary = contentType.includes("application/octet-stream") || contentType.includes("text/plain");
    
    log("Response info - ContentType:", contentType, "IsSSE:", isSSE, "ContentLength:", contentLength);

    if (upstreamResp.body) {
      // Caso 1: SSE stream → usa pipe per non bloccare
      if (isSSE && !contentLength) {
        log(">> Using STREAM mode (SSE)");
        const nodeStream = Readable.fromWeb(upstreamResp.body);
        res.flushHeaders && res.flushHeaders();

        let chunkCount = 0;
        let totalBytes = 0;
        let pipeStarted = false;

        nodeStream.on("readable", () => {
          if (!pipeStarted) {
            log("Upstream stream became readable - starting to read data");
            pipeStarted = true;
          }
        });

        nodeStream.on("data", (chunk) => {
          chunkCount++;
          totalBytes += chunk.length;
          log("Chunk from upstream", chunk.length, "bytes (total:", totalBytes, "bytes,", chunkCount, "chunks)");
          if (chunk.length < 256) {
            try { 
              const text = chunk.toString("utf8").slice(0, 200);
              log("Chunk text:", JSON.stringify(text)); 
            } catch {}
          }
        });

        nodeStream.on("error", (err) => {
          log("Upstream stream error", err?.message ?? err);
          if (!res.headersSent) {
            res.status(502).json({ error: "Upstream stream failed: " + (err?.message ?? String(err)) });
          } else {
            res.end();
          }
        });

        res.on("close", () => {
          log("Client closed connection - destroying upstream stream");
          try { nodeStream.destroy(); } catch (e) { log("nodeStream.destroy error", e?.message ?? e); }
        });

        res.on("error", (err) => {
          log("Response stream error", err?.message ?? err);
          try { nodeStream.destroy(); } catch {}
        });

        log("Starting pipe from upstream stream to client response");
        nodeStream.pipe(res);

        nodeStream.on("end", () => {
          log("Upstream stream ended - total:", totalBytes, "bytes,", chunkCount, "chunks, pipeStarted:", pipeStarted);
        });
      } 
      // Caso 2: Response non-streaming (JSON, form data, etc.) → buffer tutto e rispondi subito
      else {
        log(">> Using BUFFER mode (non-SSE, content-length present)");
        try {
          let buffer = await upstreamResp.arrayBuffer();
          
          // Se la response è compresso da Render (content-encoding: br), decomprimiamo
          const contentEncoding = upstreamResp.headers.get("content-encoding") || "";
          if (contentEncoding.includes("br")) {
            log("Decompressing brotli-compressed body");
            const decompressed = await new Promise((resolve, reject) => {
              const decompress = createBrotliDecompress();
              let chunks = [];
              decompress.on("data", (chunk) => chunks.push(chunk));
              decompress.on("end", () => resolve(Buffer.concat(chunks)));
              decompress.on("error", reject);
              decompress.write(Buffer.from(buffer));
              decompress.end();
            });
            buffer = decompressed.buffer;
            log("Decompressed size:", buffer.byteLength, "bytes");
          }
          
          const nodeBuffer = Buffer.from(buffer);
          log("Response buffered:", nodeBuffer.length, "bytes");
          res.write(nodeBuffer);
          res.end();
          log("Response sent to client");
        } catch (err) {
          log("Error buffering upstream response", err?.message ?? err);
          if (!res.headersSent) {
            res.status(502).json({ error: "Failed to read upstream response: " + (err?.message ?? String(err)) });
          } else {
            res.end();
          }
        }
      }
    } else {
      log("Upstream had no body; ending response");
      res.end();
    }
  } catch (err) {
    log("Request handler error", err && err.stack ? err.stack : err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
