import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { handle } from './app.js';

// minimal .env loader (no dependency)
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.API_PORT ?? 8787);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) { res.statusCode = 404; res.end('not found'); return; }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body: unknown = undefined;
  if (raw) { try { body = JSON.parse(raw); } catch { body = undefined; } }
  const cookies: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k] = v.join('=');
  }
  const out = await handle({
    method: req.method ?? 'GET', path: url.pathname.slice(4), query: Object.fromEntries(url.searchParams), body, cookies,
  });
  res.statusCode = out.status;
  const headers = out.headers ?? {};
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (typeof out.body === 'string') { if (!headers['Content-Type']) res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(out.body); }
  else { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(out.body)); }
}).listen(PORT, () => console.log(`[api] http://localhost:${PORT}`));
