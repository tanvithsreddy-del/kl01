import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HOST } from './config.js';
import { WEB_DIR } from './lib/paths.js';
import { sendError, sendJson } from './routes/http.js';
import { fail } from './lib/errors.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

function safeStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.resolve(WEB_DIR, `.${decoded}`);
  if (!file.startsWith(`${WEB_DIR}${path.sep}`) && file !== path.join(WEB_DIR, 'index.html')) return null;
  return file;
}

async function serveStatic(response, pathname) {
  const file = safeStaticPath(pathname);
  if (!file) return false;
  try {
    const data = await fs.readFile(file);
    response.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(data);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function createHttpServer({ routes, port, host = HOST, onError }) {
  if (host !== HOST) throw new Error('KL01 only binds 127.0.0.1');
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${HOST}`);
      if (url.pathname.startsWith('/api/')) {
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
          const origin = request.headers.origin;
          if (origin) {
            let parsedOrigin;
            try { parsedOrigin = new URL(origin); } catch { throw fail('REQUEST_ORIGIN', 'This request did not come from the KL01 app; open KL01 and try again.', 403); }
            const hostHeader = String(request.headers.host || '');
            const originHost = parsedOrigin.host;
            const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname);
            if (!localHost || originHost !== hostHeader) throw fail('REQUEST_ORIGIN', 'This request did not come from the KL01 app; open KL01 and try again.', 403);
          }
        }
        for (const route of routes) if (await route(request, response, url)) return;
        sendJson(response, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'This action is not available; reload KL01 and try again.', referenceId: 'ZK-ROUTE' } });
        return;
      }
      if (await serveStatic(response, url.pathname)) return;
      await serveStatic(response, '/index.html');
    } catch (error) {
      await onError?.(error, request);
      if (!response.headersSent) sendError(response, error);
      else response.destroy();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}
