// Nickname + 6-digit code. Six digits is only a million possibilities, so the
// code alone is not the security boundary — the lockout is. Every wrong guess
// is counted on the user row and on the caller's IP, and the delay grows fast.
import crypto from 'node:crypto';
import { q } from './db.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 400;

// PINs a brute-forcer would try in the first hundred guesses. Refusing them
// costs the user nothing and removes most of the practical risk.
const WEAK_CODES = new Set([
  '000000', '111111', '222222', '333333', '444444', '555555', '666666',
  '777777', '888888', '999999', '123456', '654321', '123123', '112233',
  '121212', '101010', '696969', '159753', '147258', '789456', '012345',
  '098765', '111222', '123321', '456456', '555666', '007007', '420420',
]);

const scrypt = (code, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(code, salt, SCRYPT.keylen, SCRYPT, (err, key) =>
      err ? reject(err) : resolve(key.toString('hex'))));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const normNick = (n) => String(n || '').trim();
export const nickKey = (n) => normNick(n).toLowerCase().normalize('NFKC');

export function validateNickname(nick) {
  const n = normNick(nick);
  if (n.length < 2) return 'nickname_short';
  if (n.length > 24) return 'nickname_long';
  if (!/^[\p{L}\p{N} _.-]+$/u.test(n)) return 'nickname_chars';
  return null;
}

export function validateCode(code) {
  const c = String(code || '');
  if (!/^\d{6}$/.test(c)) return 'code_format';
  if (WEAK_CODES.has(c)) return 'code_weak';
  // Straight runs in either direction: 123456, 234567, 987654, 210987...
  const d = c.split('').map(Number);
  const up = d.every((v, i) => i === 0 || v === (d[i - 1] + 1) % 10);
  const down = d.every((v, i) => i === 0 || v === (d[i - 1] + 9) % 10);
  if (up || down) return 'code_weak';
  return null;
}

// ---- per-IP throttle (in-memory; the service runs as one instance) ----------
const ipHits = new Map();
const IP_WINDOW_MS = 15 * 60_000;
const IP_MAX = 40;

export function ipThrottled(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < IP_WINDOW_MS);
  ipHits.set(ip, hits);
  return hits.length >= IP_MAX;
}

export function noteIpAttempt(ip) {
  const hits = ipHits.get(ip) || [];
  hits.push(Date.now());
  ipHits.set(ip, hits);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits) {
    const live = hits.filter((t) => now - t < IP_WINDOW_MS);
    if (live.length) ipHits.set(ip, live);
    else ipHits.delete(ip);
  }
}, 5 * 60_000).unref();

// How long the account is frozen after `n` consecutive wrong codes. Four free
// guesses covers fat fingers; past that the cost per guess climbs steeply, so
// walking the million-code space would take centuries.
function lockoutMs(n) {
  if (n < 4) return 0;
  if (n < 6) return 30_000;
  if (n < 8) return 5 * 60_000;
  if (n < 12) return 60 * 60_000;
  return 24 * 60 * 60_000;
}

export async function register({ nickname, code, device }) {
  const nickErr = validateNickname(nickname);
  if (nickErr) return { error: nickErr };
  const codeErr = validateCode(code);
  if (codeErr) return { error: codeErr };

  const allow = (process.env.ALLOWED_NICKNAMES || '').trim();
  if (allow) {
    const list = allow.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!list.includes(nickKey(nickname))) return { error: 'nickname_not_allowed' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(code, salt);
  try {
    const { rows } = await q(
      `INSERT INTO users (nickname, nickname_key, code_hash, code_salt)
       VALUES ($1, $2, $3, $4) RETURNING id, nickname, settings`,
      [normNick(nickname), nickKey(nickname), hash, salt],
    );
    const user = rows[0];
    return { user, token: await issueToken(user.id, device) };
  } catch (e) {
    if (e.code === '23505') return { error: 'nickname_taken' };
    throw e;
  }
}

export async function login({ nickname, code, device, ip }) {
  if (ipThrottled(ip)) return { error: 'too_many_attempts', retryAfter: 900 };

  const { rows } = await q(
    `SELECT id, nickname, code_hash, code_salt, fail_count, locked_until, settings
       FROM users WHERE nickname_key = $1`,
    [nickKey(nickname)],
  );
  const user = rows[0];

  // Spend the scrypt time either way, so an unknown nickname and a wrong code
  // take the same wall clock and the endpoint cannot enumerate accounts.
  const salt = user?.code_salt || 'decoy-salt-decoy-salt-0000000000';
  const attempt = await scrypt(String(code || ''), salt);

  if (!user) {
    noteIpAttempt(ip);
    return { error: 'bad_credentials' };
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return {
      error: 'locked',
      retryAfter: Math.ceil((new Date(user.locked_until) - Date.now()) / 1000),
    };
  }

  const a = Buffer.from(attempt, 'hex');
  const b = Buffer.from(user.code_hash, 'hex');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    noteIpAttempt(ip);
    const fails = user.fail_count + 1;
    const ms = lockoutMs(fails);
    await q(
      `UPDATE users
          SET fail_count = $2,
              locked_until = CASE WHEN $3::bigint > 0
                                  THEN now() + make_interval(secs => $3::bigint / 1000.0)
                                  ELSE NULL END
        WHERE id = $1`,
      [user.id, fails, ms],
    );
    return ms
      ? { error: 'locked', retryAfter: Math.ceil(ms / 1000) }
      : { error: 'bad_credentials', remaining: Math.max(0, 3 - fails) };
  }

  await q(
    `UPDATE users SET fail_count = 0, locked_until = NULL, last_seen_at = now() WHERE id = $1`,
    [user.id],
  );
  return {
    user: { id: user.id, nickname: user.nickname, settings: user.settings },
    token: await issueToken(user.id, device),
  };
}

export async function changeCode({ userId, currentCode, newCode }) {
  const codeErr = validateCode(newCode);
  if (codeErr) return { error: codeErr };

  const { rows } = await q(`SELECT code_hash, code_salt FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return { error: 'bad_credentials' };

  const attempt = Buffer.from(await scrypt(String(currentCode || ''), rows[0].code_salt), 'hex');
  const stored = Buffer.from(rows[0].code_hash, 'hex');
  if (attempt.length !== stored.length || !crypto.timingSafeEqual(attempt, stored)) {
    return { error: 'bad_credentials' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(newCode, salt);
  await q(`UPDATE users SET code_hash = $2, code_salt = $3 WHERE id = $1`, [userId, hash, salt]);
  // Every device has to sign in again with the new code, including this one.
  await q(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  return { ok: true };
}

async function issueToken(userId, device) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q(
    `INSERT INTO sessions (token_hash, user_id, device, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [sha256(token), userId, String(device || '').slice(0, 120), SESSION_DAYS],
  );
  return token;
}

export async function userForToken(token) {
  if (!token) return null;
  const hash = sha256(token);
  const { rows } = await q(
    `SELECT u.id, u.nickname, u.settings
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hash],
  );
  if (!rows[0]) return null;
  q(`UPDATE sessions SET last_used_at = now() WHERE token_hash = $1`, [hash]).catch(() => {});
  return rows[0];
}

export async function logout(token) {
  if (token) await q(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
}
