# MCP Proxy per ChatGPT

Proxy robusto per inoltrare richieste MCP da ChatGPT a Render MCP Server con streaming SSE e logging dettagliato.

## Cos'è stato migliorato

### 1. **Pass-through Streaming Robusto**
- Eliminato buffering manuale dei response body
- Usa `pipe()` nativo di Node.js per flusso diretto upstream → client
- Gestione automatic backpressure e flow control
- Riduce latenza e overhead memory

### 2. **Logging Dettagliato con Timestamp**
Ogni operazione viene loggata con timestamp ISO:
- **Incoming request**: metodo, URL, headers
- **Request body size**: quanti byte ricevuti
- **Forwarding to upstream**: URL target, metodo
- **Upstream responded**: status HTTP + headers ricevute
- **Response headers set**: headers propagate al client
- **Starting pipe**: inizio streaming
- **Chunk from upstream**: ogni chunk ricevuto (dimensione + preview testo)
- **Client closed connection**: quando il client chiude

### 3. **Timeout e Abort Control**
- AbortController con timeout configurabile (default 120 sec)
- Interruzione automatica di fetch che rimangono appesi
- Configurabile via `UPSTREAM_TIMEOUT_MS` env var

### 4. **Gestione Errori Globale**
- `process.on("uncaughtException")` — cattura errori non gestiti
- `process.on("unhandledRejection")` — promise rejections
- Stream error handling con destroy automatico
- Logging dello stack completo degli errori

### 5. **Secret Fallback**
- Prova `MCP_PATH_SECRET` first
- Fallback a `MCP_SHARED_SECRET` da `.env`
- Utile per ambienti con nomi diversi

## Setup

### 1. Installa dipendenze
```bash
npm install
```

### 2. Configura variabili d'ambiente (crea `.env`)
```env
RENDER_API_KEY=rnd_tuoTokenQui
MCP_SHARED_SECRET=36bf3a65-1518-414e-9218-741d24a01cd7
UPSTREAM_MCP_URL=https://mcp.render.com/mcp
UPSTREAM_TIMEOUT_MS=120000
PORT=10000
```

### 3. Avvia il server
```bash
npm start
```

Aspettati output:
```
2026-02-21T12:18:03.762Z Starting server with config: {
  PORT: 10000,
  UPSTREAM_MCP_URL: 'https://mcp.render.com/mcp',
  RENDER_API_KEY: 'rnd_…CoUb',
  MCP_PATH_SECRET: '36bf…XXXX',
  UPSTREAM_TIMEOUT_MS: 120000
}
Listening on 10000
```

## Uso

### Health Check Endpoint
Verifica che proxy e secret siano corretti:
```bash
curl -i http://localhost:10000/mcp/<MCP_SHARED_SECRET>/health
```

Risposta attesa:
```json
{"ok":true,"proxy":true}
```

### Proxy SSE/MCP Endpoint
ChatGPT chiama:
```bash
curl -i -N -H "Accept: text/event-stream" \
  http://localhost:10000/mcp/<MCP_SHARED_SECRET>
```

Il server loggerà:
1. `Incoming request GET /mcp/...` — richiesta ricevuta
2. `Forwarding to upstream https://mcp.render.com/mcp method GET` — invia a Render
3. `Upstream responded 202 Accepted` — Render risponde
4. `Response headers set on client connection` — headers SSE propagate
5. `Starting pipe from upstream stream to client response` — streaming inizia
6. (In tempo reale) `Chunk from upstream XXX bytes` — ogni chunk ricevuto
7. `Client closed connection - destroying upstream stream` — quando client chiude

### Salva Log su File
```bash
export $(sed -E 's/\s*=\s*/=/g' .env | grep -v '^\s*#' | xargs)
node index.js > server.log 2>&1 &
```

Segui in tempo reale:
```bash
tail -f server.log
```

## Risoluzione Problemi

### "Request body size: unknown"
Normale per GET requests — il body non è bufferizzato.

### "Chunk from upstream" non appare mai
SSE funziona così: il server upstream rimane aperto (keep-alive) e invia dati quando ha messaggi. Se non vedi chunks:
1. Verify che `RENDER_API_KEY` sia valido: `curl -i -H "Authorization: Bearer $RENDER_API_KEY" https://mcp.render.com/mcp`
2. Verifica che MCP richieda un `/initialize` o POST con body prima di streammare
3. Controlla timeout: se `UPSTREAM_TIMEOUT_MS` è troppo basso, fetch viene abortito

### "Upstream stream error"
Controlla:
- `UPSTREAM_MCP_URL` è corretta?
- `RENDER_API_KEY` è ancora valido?
- Firewall/proxy bloccano HTTPS verso mcp.render.com?

### Client rimane bloccato
Il proxy torà ora non blocca — usa streaming passthrough. Se il cliente rimane bloccato:
1. Controlla timeout client (curl ha `-N` per no-buffer)
2. Verifica che `Transfer-Encoding: chunked` sia presente in response headers (nel log)
3. Ca che Render stia inviando dati periodici (heartbeat SSE)

## Architettura

```
ChatGPT Client
    ↓ HTTP SSE Request
    ↓ (Accept: text/event-stream)
Proxy Server (index.js)
    ↓ fetch(UPSTREAM_MCP_URL)
    ↓ pipe() streaming robusto
Render MCP Server (https://mcp.render.com/mcp)
    ↓ Response 202 Accepted
    ↓ text/event-stream
Proxy Server (piping)
    ↓ pipe() transparente
ChatGPT Client (riceve SSE events)
```

## Logging Esempio Completo

```
2026-02-21T12:18:03.762Z Starting server with config: {...}
Listening on 10000
2026-02-21T12:18:04.383Z Incoming request GET /mcp/36bf3a65-1518-414e-9218-741d24a01cd7
2026-02-21T12:18:04.383Z Request headers { host: 'localhost:10000', 'user-agent': 'curl/8.5.0', accept: 'text/event-stream' }
2026-02-21T12:18:04.383Z Request body size 2
2026-02-21T12:18:04.384Z Forwarding to upstream https://mcp.render.com/mcp method GET
2026-02-21T12:18:04.627Z Upstream responded 202 Accepted
2026-02-21T12:18:04.628Z Upstream response headers:
2026-02-21T12:18:04.628Z    content-type : text/event-stream
2026-02-21T12:18:04.629Z    transfer-encoding : chunked
2026-02-21T12:18:04.629Z Response headers set on client connection
2026-02-21T12:18:04.630Z Starting pipe from upstream stream to client response
2026-02-21T12:18:05.100Z Chunk from upstream 156 bytes
2026-02-21T12:18:05.100Z Chunk text: ":ping\n\ndata: {\"type\": \"init\", \"version\": \"1.0\"}\nevent: initialize\n\n"
2026-02-21T12:18:16.377Z Client closed connection - destroying upstream stream
2026-02-21T12:18:16.378Z Upstream stream ended - total: 156 bytes, 1 chunks, pipeStarted: true
```

## Deployment

Considera di deployare su Render, Heroku, o altro platform:
1. Imposta environment variables via Dashboard: `RENDER_API_KEY`, `MCP_SHARED_SECRET`, `UPSTREAM_MCP_URL`
2. Deploy da GitHub (auto-build da `index.js` e `package.json`)
3. Monitora logs via dashboard platform
4. Set PORT dynamicamente: server legge `process.env.PORT` (default 10000)

## Performance

- **No buffering**: streaming pass-through riduce memory usage
- **Backpressure handled**: `pipe()` pausa lettura se client è lento
- **Timeout protection**: non rimane appeso indefinitely
- **Per-request logging**: zero overhead (console.log asincrono)

## Licenza

MIT
