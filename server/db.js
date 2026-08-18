// Postgres access + schema migration. One dependency (pg); everything else is
// stdlib. The sync model is deliberately generic: every user-owned thing is a
// row in `records` keyed by (user_id, kind, id), carrying a client-authored
// `updated_at` for last-write-wins and a server-authored `seq` that clients use
// as a pull cursor.
import pg from 'pg';

const { Pool } = pg;

// Railway's Postgres image serves a self-signed certificate, so TLS has to be
// used with verification off — node cannot chain it to a public root. This
// covers the internal host (postgres.railway.internal), the TCP proxy and the
// public domain. Set PGSSLMODE=disable to force it off.
const url = process.env.DATABASE_URL || '';
const needsSsl = process.env.PGSSLMODE === 'disable'
  ? false
  : /[?&]sslmode=require/.test(url) || /railway\.internal|rlwy\.net|railway\.app/.test(url);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  nickname      TEXT NOT NULL,
  nickname_key  TEXT NOT NULL UNIQUE,       -- lowercased, for case-insensitive login
  code_hash     TEXT NOT NULL,              -- scrypt(code, salt), hex
  code_salt     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  fail_count    INT NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,            -- sha256 of the opaque bearer token
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS records (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT   NOT NULL,               -- word | card | page | log | pref
  id         TEXT   NOT NULL,               -- client-generated uuid
  updated_at BIGINT NOT NULL,               -- client clock, ms — last-write-wins
  deleted    BOOLEAN NOT NULL DEFAULT false,
  data       JSONB  NOT NULL,
  seq        BIGINT NOT NULL,               -- server clock, for pull cursors
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS records_pull_idx ON records(user_id, seq);

-- A single monotonically increasing counter shared by every record, so a client
-- can ask "everything after seq N" without worrying about clock skew.
CREATE SEQUENCE IF NOT EXISTS record_seq;

CREATE TABLE IF NOT EXISTS usage (
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      DATE   NOT NULL,
  kind     TEXT   NOT NULL,                 -- realtime_sec | claude_in | claude_out | tts_chars
  amount   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);
`;

export async function migrate() {
  await q(SCHEMA);
}

export async function bumpUsage(userId, kind, amount) {
  if (!amount) return;
  await q(
    `INSERT INTO usage (user_id, day, kind, amount) VALUES ($1, CURRENT_DATE, $2, $3)
     ON CONFLICT (user_id, day, kind) DO UPDATE SET amount = usage.amount + EXCLUDED.amount`,
    [userId, kind, Math.round(amount)],
  );
}
