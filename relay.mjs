// REVENGE API — GitHub Actions relay host. Powered by idam Emmanuel.
//
// Same protocol as api/relay.js and relays/relay-worker.mjs, plus a job-queue shape the dispatcher
// workflow uses. A GitHub Actions runner is a fresh VM on a fresh address for every job, on a public
// repository at no cost — which makes it the only free egress pool that actually rotates.
//
//   POST /fetch     { url, method, headers, body }      -> upstream response, verbatim (one runner)
//   POST /dispatch  { url, method, headers, body, id }  -> blocks until a runner posts /result
//   POST /result    { id, status, headers, body_b64 }   -> the upstream answer, verbatim
//   GET  /ping                                          -> liveness
//   GET  /ip                                            -> which address this process is using
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const KEY = process.env.RELAY_KEY || '';
const MAX_TIMEOUT = Number(process.env.RELAY_TIMEOUT_MS || 110000);
const QUEUE_WAIT_MS = Number(process.env.QUEUE_WAIT_MS || 60000);

const queue = new Map();      // id -> { job, deliver }
const delivered = new Map();  // id -> job waiting for a runner to pick up

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-expose-headers': 'content-type,x-relay-name,x-relay-error',
};

const auth = (req) => {
  if (!KEY) return true;
  const h = String(req.headers['x-relay-key'] || '');
  const b = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return h === KEY || b === KEY;
};

const json = (res, status, obj, extra = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', ...CORS, 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
};

const readBody = (req, limit = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const awaitResult = (id) => new Promise((resolve) => {
  const entry = queue.get(id);
  if (!entry) return resolve(null);
  const timer = setTimeout(() => { queue.delete(id); delivered.delete(id); resolve(null); }, MAX_TIMEOUT);
  timer.unref?.();
  entry.deliver = (result) => { clearTimeout(timer); queue.delete(id); resolve(result); };
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  try {
    if (url.pathname === '/ping' || url.pathname === '/') {
      return json(res, 200, { ok: true, relay: 'revenge-gh-relay', queued: queue.size, waiting: delivered.size, keyed: !!KEY });
    }
    if (!auth(req)) return json(res, 401, { ok: false, error: 'relay key required' });

    if (url.pathname === '/ip') {
      const r = await fetch('https://api.ipify.org?format=json').catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      return json(res, 200, { ok: true, address: j.ip || 'unknown' });
    }

    // A runner long-polls here for work. Idle searches make no log noise.
    if (url.pathname === '/dispatch' && req.method === 'GET') {
      const wait = Math.min(Number(url.searchParams.get('wait') || 25000), QUEUE_WAIT_MS);
      const started = Date.now();
      while (Date.now() - started < wait) {
        const next = [...delivered.values()][0];
        if (next) { delivered.delete(next.id); return json(res, 200, { ok: true, job: next }); }
        await new Promise((r) => setTimeout(r, 400));
      }
      return json(res, 200, { ok: true, job: null });
    }

    if (url.pathname === '/dispatch' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (!b.url) return json(res, 400, { ok: false, error: 'url is required' });
      const id = b.id || randomUUID();
      const job = { id, url: b.url, method: b.method || 'GET', headers: b.headers || {}, body: b.body ?? null, at: Date.now() };
      const wait = awaitResult(id);
      queue.set(id, { job, deliver: null });
      delivered.set(id, job);
      const result = await wait;
      if (!result) return json(res, 504, { ok: false, error: 'no runner answered in time', id }, { 'x-relay-error': 'runner-timeout' });
      const headers = result.headers || {};
      const buf = result.body_b64 ? Buffer.from(result.body_b64, 'base64') : Buffer.alloc(0);
      res.writeHead(result.status || 502, {
        'content-type': headers['content-type'] || 'application/octet-stream',
        'x-relay-name': 'revenge-gh-relay',
        'x-relay-error': result.error ? 'upstream-unreachable' : '',
        'content-length': buf.length,
        ...CORS,
      });
      return res.end(buf);
    }

    if (url.pathname === '/result' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString() || '{}');
      const entry = queue.get(b.id);
      if (!entry) return json(res, 404, { ok: false, error: 'unknown or expired job id' });
      entry.deliver?.(b);
      return json(res, 200, { ok: true });
    }

    // Direct fetch: the shape relays.mjs already speaks, and enough with one runner.
    if (url.pathname === '/fetch' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 32 * 1024 * 1024)).toString() || '{}');
      if (!b.url) return json(res, 400, { ok: false, error: 'url is required' });
      const r = await fetch(b.url, { method: b.method || 'GET', headers: b.headers || {}, body: b.body ?? undefined, signal: AbortSignal.timeout(MAX_TIMEOUT) });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, {
        'content-type': r.headers.get('content-type') || 'application/octet-stream',
        'x-relay-name': 'revenge-gh-relay',
        'content-length': buf.length,
        ...CORS,
      });
      return res.end(buf);
    }

    return json(res, 404, { ok: false, error: 'no such route' });
  } catch (e) {
    return json(res, 502, { ok: false, error: String(e?.message || e).slice(0, 200) }, { 'x-relay-error': 'upstream-unreachable' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`revenge-gh-relay listening on :${PORT}`));
