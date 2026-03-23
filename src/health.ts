/**
 * Health Endpoint
 *
 * Minimal HTTP server for Container App liveness + readiness probes.
 * GET /health → 200 { status, uptime, activeFleets, ... }
 * GET /ready  → 200 when ready to accept work, 503 during shutdown
 */
import { createServer, Server } from 'http';
import { logger } from './logger.js';

const PORT = parseInt(process.env.HEALTH_PORT || '8080', 10);

let ready = true;
let startTime = Date.now();

/** External state suppliers — set by the host at startup */
let getActiveFleets: () => number = () => 0;
let getQueuedMessages: () => number = () => 0;

export function setHealthState(opts: {
  getActiveFleets?: () => number;
  getQueuedMessages?: () => number;
}): void {
  if (opts.getActiveFleets) getActiveFleets = opts.getActiveFleets;
  if (opts.getQueuedMessages) getQueuedMessages = opts.getQueuedMessages;
}

/** Mark as not ready (during shutdown) */
export function setNotReady(): void {
  ready = false;
}

export function startHealthServer(): Server {
  startTime = Date.now();

  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    if (req.url === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        uptimeSeconds: Math.round((Date.now() - startTime) / 1000),
        activeFleets: getActiveFleets(),
        ready,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.url === '/ready') {
      if (ready) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ready"}');
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end('{"status":"shutting_down"}');
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, () => {
    logger.info({ port: PORT }, 'Health server started');
  });

  return server;
}
