import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handle } from '../server/app.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const out = await handle({
    method: req.method ?? 'GET',
    path: url.pathname.replace(/^\/api/, ''),
    query: Object.fromEntries(url.searchParams),
    body: req.body,
    cookies: req.cookies ?? {},
  });
  res.status(out.status);
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
  if (typeof out.body === 'string') res.send(out.body);
  else res.json(out.body);
}
