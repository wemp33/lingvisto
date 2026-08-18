// Per-user API keys.
//
// The keys belong to the learner, so they are entered in the app's own settings
// rather than in a hosting dashboard. They are kept on the server, not in the
// browser: the whole point of the ephemeral-token design is that the real key
// never reaches a page where any injected script could read it.
//
// Stored encrypted with AES-256-GCM. Be clear about what that buys: it protects
// against a database dump, a backup landing somewhere it should not, or a key
// showing up in a log — not against someone who already has both the database
// and the running server's secret. That is the realistic threat for a personal
// app, and it is a great deal better than plaintext.
import crypto from 'node:crypto';
import { q } from './db.js';

const ALGO = 'aes-256-gcm';
let cachedKey = null;

// Prefer an explicit APP_SECRET. Without one, fall back to a random secret
// generated once and kept in the database, so the feature works out of the box
// rather than silently refusing to store anything.
async function secretKey() {
  if (cachedKey) return cachedKey;
  let material = process.env.APP_SECRET;
  if (!material) {
    const { rows } = await q(`SELECT value FROM server_meta WHERE key = 'secret'`);
    if (rows[0]) {
      material = rows[0].value;
    } else {
      material = crypto.randomBytes(32).toString('base64');
      await q(
        `INSERT INTO server_meta (key, value) VALUES ('secret', $1) ON CONFLICT (key) DO NOTHING`,
        [material],
      );
      const again = await q(`SELECT value FROM server_meta WHERE key = 'secret'`);
      material = again.rows[0].value;
    }
  }
  cachedKey = crypto.createHash('sha256').update(material).digest();
  return cachedKey;
}

async function encrypt(plain) {
  const key = await secretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

async function decrypt(box) {
  if (!box?.ct) return null;
  try {
    const key = await secretKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong secret or tampered ciphertext. Treat as "no key" rather than
    // crashing every request the user makes.
    return null;
  }
}

const PROVIDERS = {
  openai: {
    // Loose on purpose: OpenAI has shipped several prefixes and will ship more.
    looksRight: (k) => /^sk-[A-Za-z0-9_-]{20,}$/.test(k),
    hint: 'sk-…',
    async verify(key) {
      const res = await fetch('https://api.openai.com/v1/models?limit=1', {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 401) return { ok: false, error: 'key_rejected' };
      if (!res.ok) return { ok: false, error: 'verify_failed' };
      return { ok: true };
    },
  },
  anthropic: {
    looksRight: (k) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k),
    hint: 'sk-ant-…',
    async verify(key) {
      // One token on the cheapest model is the least wasteful way to prove a
      // key works; a 401 is the answer we actually care about.
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'key_rejected' };
      if (!res.ok && res.status !== 400) return { ok: false, error: 'verify_failed' };
      return { ok: true };
    },
  },
};

export const providerNames = Object.keys(PROVIDERS);

export async function setKey(userId, provider, rawKey) {
  const p = PROVIDERS[provider];
  if (!p) return { error: 'unknown_provider' };
  const key = String(rawKey || '').trim();
  if (!key) return { error: 'empty_key' };
  if (!p.looksRight(key)) return { error: 'key_format', hint: p.hint };

  // Verify before storing, so a typo is caught at the settings screen rather
  // than surfacing later as a mysterious failure mid-conversation.
  const check = await p.verify(key).catch(() => ({ ok: false, error: 'verify_failed' }));
  if (!check.ok) return { error: check.error };

  const box = await encrypt(key);
  await q(
    `UPDATE users SET keys = jsonb_set(COALESCE(keys, '{}'::jsonb), $2, $3::jsonb, true) WHERE id = $1`,
    [userId, `{${provider}}`, JSON.stringify({ ...box, last4: key.slice(-4), setAt: Date.now() })],
  );
  return { ok: true, last4: key.slice(-4) };
}

export async function clearKey(userId, provider) {
  if (!PROVIDERS[provider]) return { error: 'unknown_provider' };
  await q(`UPDATE users SET keys = COALESCE(keys, '{}'::jsonb) - $2 WHERE id = $1`, [userId, provider]);
  return { ok: true };
}

// Never returns the key itself — only whether one is set and its last four
// characters, which is enough for the learner to tell two keys apart.
export async function keyStatus(userId) {
  const { rows } = await q(`SELECT keys FROM users WHERE id = $1`, [userId]);
  const stored = rows[0]?.keys || {};
  const out = {};
  for (const name of providerNames) {
    out[name] = {
      set: !!stored[name]?.ct,
      last4: stored[name]?.last4 || null,
      setAt: stored[name]?.setAt || null,
      // A server-wide key means the app works before the learner sets anything.
      fromServer: !stored[name]?.ct && !!process.env[`${name.toUpperCase()}_API_KEY`],
    };
  }
  return out;
}

// The key to actually use for this user's request: their own if they have set
// one, otherwise the server's, if the deployment has one.
export async function resolveKey(userId, provider) {
  if (userId != null) {
    const { rows } = await q(`SELECT keys FROM users WHERE id = $1`, [userId]);
    const box = rows[0]?.keys?.[provider];
    const own = await decrypt(box);
    if (own) return own;
  }
  return process.env[`${provider.toUpperCase()}_API_KEY`] || null;
}
