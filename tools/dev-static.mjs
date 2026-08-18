// Local UI harness: serves public/ and answers the API with canned data held
// in memory. No Postgres, no API keys, no network. It exists so the interface
// can be worked on and checked offline — it is not the real server and is
// never deployed.
//   node tools/dev-static.mjs   →  http://localhost:4173
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file, not the working directory, so it can be launched
// from anywhere.
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = process.env.DEV_PORT || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};

const users = new Map();   // nickname -> code
const records = new Map(); // token -> [record]
let seq = 0;

const json = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); }
  });
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    const body = req.method === 'POST' ? await readBody(req) : {};

    if (p === '/api/health') return json(res, 200, { ok: true, ai: { openai: false, anthropic: false }, languages: ['de', 'ru', 'it'] });

    if (p === '/api/auth/register') {
      if (users.has(body.nickname)) return json(res, 400, { error: 'nickname_taken' });
      if (!/^\d{6}$/.test(body.code || '')) return json(res, 400, { error: 'code_format' });
      users.set(body.nickname, body.code);
      const token = `dev-${body.nickname}`;
      records.set(token, []);
      return json(res, 200, { token, user: { id: 1, nickname: body.nickname, settings: {} } });
    }

    if (p === '/api/auth/login') {
      if (users.get(body.nickname) !== body.code) return json(res, 401, { error: 'bad_credentials' });
      const token = `dev-${body.nickname}`;
      return json(res, 200, { token, user: { id: 1, nickname: body.nickname, settings: {} } });
    }

    if (p === '/api/auth/logout') return json(res, 200, { ok: true });

    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!records.has(token)) records.set(token, []);
    const mine = records.get(token);

    if (p === '/api/sync/pull') {
      const since = Number(url.searchParams.get('since') || 0);
      const out = mine.filter((r) => r.seq > since);
      return json(res, 200, {
        records: out.map(({ seq: _s, ...r }) => r),
        cursor: out.length ? out[out.length - 1].seq : since,
        more: false,
      });
    }

    if (p === '/api/sync/push') {
      for (const r of body.records || []) {
        const i = mine.findIndex((x) => x.kind === r.kind && x.id === r.id);
        const row = { ...r, seq: ++seq };
        if (i >= 0) mine[i] = row; else mine.push(row);
      }
      return json(res, 200, { cursor: seq, applied: (body.records || []).length, rejected: [] });
    }

    // Canned model responses, clearly marked so nothing here is mistaken for
    // a real check.
    if (p === '/api/ai/word') {
      return json(res, 200, {
        status: 'ok',
        lemma: body.term,
        asWritten: body.term,
        pos: 'noun',
        translations: { pl: ['[dev] tłumaczenie'], en: ['[dev] translation'] },
        ipa: 'dev',
        grammar: { note: 'dev server — no model was called' },
        example: { text: `${body.term} …`, pl: '[dev]', en: '[dev]' },
        difficulty: 2,
      });
    }
    if (p === '/api/ai/handwriting') {
      return json(res, 200, { reading: '[dev]', legible: true, verdict: 'close', comment: 'Dev server: no model was called.', issues: [] });
    }
    if (p === '/api/ai/ink') return json(res, 200, { candidates: [] });
    if (p === '/api/ai/song') {
      return json(res, 200, {
        found: true, confidence: 'high',
        title: body.title, artist: body.artist, language: body.lang, year: '1984', genre: 'dev',
        about: '[dev] No model was called. This is placeholder text standing in for a description.',
        difficulty: 3, register: 'everyday',
        vocabulary: [
          { lemma: '[dev] Wort', pos: 'noun', translations: { pl: ['[dev] słowo'], en: ['[dev] word'] },
            grammar: { article: 'das' }, example: { text: '[dev] Beispiel.', pl: '[dev]', en: '[dev]' },
            note: 'dev stub', core: true },
          { lemma: '[dev] sehnen', pos: 'verb', translations: { pl: ['[dev] tęsknić'], en: ['[dev] to long'] },
            example: { text: '[dev] Beispiel.', pl: '[dev]', en: '[dev]' }, core: false },
        ],
        expressions: [{ expression: '[dev] etwas im Griff haben', meaning: '[dev] to have it under control' }],
        grammarPoints: [{ point: '[dev] Dativ', explain: '[dev] placeholder' }],
        culturalNotes: ['[dev] placeholder'],
        listeningTips: ['[dev] placeholder'],
      });
    }
    if (p === '/api/ai/report') return json(res, 200, { summary: '[dev] no model was called.', corrections: [], newWords: [] });
    if (p === '/api/ai/realtime-session') return json(res, 503, { error: 'no_key' });
    if (p === '/api/ai/speak') return json(res, 503, { error: 'no_key' });

    return json(res, 404, { error: 'not_found' });
  }

  let rel = p === '/' ? '/index.html' : p;
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    if (path.extname(rel)) { res.writeHead(404); return res.end('not found'); }
    return fs.createReadStream(path.join(PUBLIC, 'index.html'))
      .pipe(res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }));
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
}).listen(PORT, () => console.log(`Lingvisto UI harness on http://localhost:${PORT}`));
