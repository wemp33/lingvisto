// Lingvisto server: serves the PWA and the handful of endpoints that need a
// secret. Plain node:http with a tiny router — the only dependency in the whole
// project is `pg`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { migrate, bumpUsage } from './db.js';
import * as auth from './auth.js';
import * as sync from './sync.js';
import * as ai from './ai.js';
import * as keys from './keys.js';
import { tutorInstructions, TUTOR_TOOLS, LANG_PROMPTS } from './langdata.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const PORT = process.env.PORT || 3000;

/* ═══ helpers ═══ */

const send = (res, status, body, headers = {}) => {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
};

const fail = (res, status, code, extra = {}) => send(res, status, { error: code, ...extra });

async function readJson(req, limit = 4_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

// Railway terminates TLS upstream, so the caller's address is in the header.
const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};

/* ═══ static files ═══ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

const etagCache = new Map();

function etagFor(file, stat) {
  const k = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (!etagCache.has(k)) {
    etagCache.set(k, `"${createHash('sha1').update(k).digest('base64url').slice(0, 20)}"`);
  }
  return etagCache.get(k);
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const full = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC)) return fail(res, 403, 'forbidden');

  let stat;
  try { stat = fs.statSync(full); } catch { stat = null; }

  // Unknown paths fall through to the shell so client routing works on reload.
  if (!stat || stat.isDirectory()) {
    if (path.extname(rel)) return fail(res, 404, 'not_found');
    return serveStatic(req, res, '/index.html');
  }

  const ext = path.extname(full).toLowerCase();
  const etag = etagFor(full, stat);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    return res.end();
  }

  // The service worker and the shell must never be served stale, or an update
  // can never reach an installed app. Fingerprinted assets could be cached
  // hard, but nothing here is fingerprinted, so revalidation it is.
  const isShell = rel === '/index.html' || rel === '/sw.js' || rel.endsWith('.webmanifest');
  const cache = isShell
    ? 'no-cache'
    : ext === '.png' || ext === '.svg'
      ? 'public, max-age=86400, must-revalidate'
      : 'no-cache';

  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cache,
    etag,
    // The app loads nothing from anywhere else; the realtime connection is
    // WebRTC to OpenAI, which is not subject to connect-src for media.
    ...(ext === '.html' ? {
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        + "img-src 'self' data: blob:; media-src 'self' blob:; "
        + "connect-src 'self' https://api.openai.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    } : {}),
  });
  fs.createReadStream(full).pipe(res);
}

/* ═══ routes ═══ */

async function requireUser(req, res) {
  const user = await auth.userForToken(bearer(req));
  if (!user) { fail(res, 401, 'unauthorized'); return null; }
  return user;
}

const ROUTES = {
  'GET /api/health': async (req, res) => send(res, 200, {
    ok: true,
    ai: { anthropic: ai.hasAnthropic(), openai: ai.hasOpenAI() },
    languages: Object.keys(LANG_PROMPTS),
  }),

  'POST /api/auth/register': async (req, res) => {
    const ip = clientIp(req);
    if (auth.ipThrottled(ip)) return fail(res, 429, 'too_many_attempts', { retryAfter: 900 });
    auth.noteIpAttempt(ip);
    const { nickname, code, device } = await readJson(req);
    const out = await auth.register({ nickname, code, device });
    if (out.error) return fail(res, 400, out.error);
    send(res, 200, out);
  },

  'POST /api/auth/login': async (req, res) => {
    const { nickname, code, device } = await readJson(req);
    const out = await auth.login({ nickname, code, device, ip: clientIp(req) });
    if (out.error) {
      const status = out.error === 'locked' || out.error === 'too_many_attempts' ? 429 : 401;
      return fail(res, status, out.error, out.retryAfter ? { retryAfter: out.retryAfter } : {});
    }
    send(res, 200, out);
  },

  'POST /api/auth/logout': async (req, res) => {
    await auth.logout(bearer(req));
    send(res, 200, { ok: true });
  },

  'POST /api/auth/code': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const { currentCode, newCode } = await readJson(req);
    const out = await auth.changeCode({ userId: user.id, currentCode, newCode });
    if (out.error) return fail(res, 400, out.error);
    send(res, 200, out);
  },

  'GET /api/sync/pull': async (req, res, url) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const since = Number(url.searchParams.get('since') || 0);
    send(res, 200, await sync.pull(user.id, since));
  },

  'POST /api/sync/push': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const { records } = await readJson(req);
    const out = await sync.push(user.id, records);
    if (out.error) return fail(res, 400, out.error, out);
    send(res, 200, out);
  },

  'GET /api/keys': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    send(res, 200, await keys.keyStatus(user.id));
  },

  'POST /api/keys': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const { provider, key } = await readJson(req);
    const out = await keys.setKey(user.id, provider, key);
    if (out.error) return fail(res, 400, out.error, out.hint ? { hint: out.hint } : {});
    send(res, 200, { ...out, status: await keys.keyStatus(user.id) });
  },

  'DELETE /api/keys': async (req, res, url) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const out = await keys.clearKey(user.id, url.searchParams.get('provider'));
    if (out.error) return fail(res, 400, out.error);
    send(res, 200, { ...out, status: await keys.keyStatus(user.id) });
  },

  'POST /api/ai/realtime-session': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    const lang = LANG_PROMPTS[body.lang] ? body.lang : 'de';
    const instructions = tutorInstructions({
      lang,
      uiLang: body.uiLang,
      level: body.level,
      glossary: Array.isArray(body.glossary) ? body.glossary : [],
      dueWords: Array.isArray(body.dueWords) ? body.dueWords : [],
      facts: Array.isArray(body.facts) ? body.facts : [],
      objective: body.objective,
      correctionStyle: body.correctionStyle,
      nickname: user.nickname,
    });
    const apiKey = await keys.resolveKey(user.id, 'openai');
    const out = await ai.realtimeSession({
      lang, instructions, voice: LANG_PROMPTS[lang].voice, apiKey,
    });
    send(res, 200, { ...out, tools: TUTOR_TOOLS, instructions });
  },

  'POST /api/ai/word': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    if (!body.term || String(body.term).length > 120) return fail(res, 400, 'bad_term');
    const out = await ai.validateWord({
      lang: body.lang, term: String(body.term).trim(),
      meaning: body.meaning, uiLang: body.uiLang, level: body.level,
      apiKey: await keys.resolveKey(user.id, 'anthropic'),
    });
    bumpUsage(user.id, 'claude_calls', 1).catch(() => {});
    send(res, 200, out);
  },

  'POST /api/ai/handwriting': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    if (!body.image) return fail(res, 400, 'no_image');
    const out = await ai.critiqueHandwriting({
      lang: body.lang,
      imageBase64: String(body.image).replace(/^data:image\/png;base64,/, ''),
      target: body.target,
      uiLang: body.uiLang,
      mode: body.mode,
      recognised: body.recognised,
      apiKey: await keys.resolveKey(user.id, 'anthropic'),
    });
    bumpUsage(user.id, 'claude_calls', 1).catch(() => {});
    send(res, 200, out);
  },

  'POST /api/ai/ink': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    const candidates = await ai.recogniseInk({
      lang: body.lang, ink: body.ink, width: body.width, height: body.height,
    });
    send(res, 200, { candidates });
  },

  'POST /api/ai/speak': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    if (!body.text) return fail(res, 400, 'no_text');
    const audio = await ai.speak({
      lang: body.lang, text: body.text, slow: !!body.slow,
      apiKey: await keys.resolveKey(user.id, 'openai'),
    });
    bumpUsage(user.id, 'tts_chars', String(body.text).length).catch(() => {});
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'content-length': audio.length,
      'cache-control': 'private, max-age=604800',
    });
    res.end(audio);
  },

  'POST /api/ai/song': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    if (!body.title || !body.artist) return fail(res, 400, 'no_song');
    const out = await ai.analyseSong({
      lang: body.lang,
      title: String(body.title).slice(0, 200).trim(),
      artist: String(body.artist).slice(0, 200).trim(),
      uiLang: body.uiLang,
      level: body.level,
      apiKey: await keys.resolveKey(user.id, 'anthropic'),
    });
    bumpUsage(user.id, 'claude_calls', 1).catch(() => {});
    send(res, 200, out);
  },

  'POST /api/ai/extract': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req, 24_000_000);
    const images = (Array.isArray(body.images) ? body.images : [])
      .map((d) => String(d).replace(/^data:image\/\w+;base64,/, ''))
      .slice(0, 4);
    const out = await ai.extractVocabulary({
      lang: body.lang, images, text: String(body.text || ''),
      uiLang: body.uiLang, level: body.level,
      apiKey: await keys.resolveKey(user.id, 'anthropic'),
    });
    bumpUsage(user.id, 'claude_calls', 1).catch(() => {});
    send(res, 200, out);
  },

  'POST /api/ai/report': async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    if (!body.transcript) return fail(res, 400, 'no_transcript');
    const out = await ai.sessionReport({
      lang: body.lang, transcript: body.transcript, uiLang: body.uiLang,
      apiKey: await keys.resolveKey(user.id, 'anthropic'),
    });
    bumpUsage(user.id, 'claude_calls', 1).catch(() => {});
    send(res, 200, out);
  },
};

/* ═══ server ═══ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') return send(res, 200, 'ok');

  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method_not_allowed');
    return serveStatic(req, res, url.pathname);
  }

  const handler = ROUTES[`${req.method} ${url.pathname}`];
  if (!handler) return fail(res, 404, 'not_found');

  try {
    await handler(req, res, url);
  } catch (e) {
    if (res.headersSent) return;
    const status = e.status || (e.message === 'bad_json' ? 400 : e.message === 'too_large' ? 413 : 500);
    const code = e.code || e.message || 'server_error';
    if (status >= 500) console.error(`${req.method} ${url.pathname}`, e);
    else if (e.detail) console.warn(`${req.method} ${url.pathname}: ${code} — ${e.detail}`);
    fail(res, status, code);
  }
});

// Keep-alive slightly above a typical proxy's, so Railway's edge never hands a
// request to a socket this process is about to close.
server.keepAliveTimeout = 72_000;
server.headersTimeout = 75_000;

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — add a Postgres service in Railway and reference it.');
    process.exit(1);
  }
  await migrate();
  console.log('database ready');
  if (!ai.hasOpenAI()) console.warn('OPENAI_API_KEY missing — the talking tutor and word audio are disabled.');
  if (!ai.hasAnthropic()) console.warn('ANTHROPIC_API_KEY missing — word checking and handwriting critique are disabled.');
  server.listen(PORT, () => console.log(`Lingvisto listening on :${PORT}`));
}

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((e) => { console.error(e); process.exit(1); });
