// Device sync. The client is the source of truth while offline: it writes to
// IndexedDB immediately, stamps every record with its own `updatedAt`, and
// pushes later. The server merges last-write-wins per record and hands back a
// `seq` cursor so the other device can pull just what changed.
//
// Last-write-wins is the right trade here: one human on two devices, editing
// small independent records (a word, a card's schedule, a whiteboard page).
// The one case worth protecting is a *deletion* racing an edit, so a delete
// carries its own updatedAt and loses to a later edit like anything else.
import { q } from './db.js';

const KINDS = new Set(['word', 'card', 'page', 'log', 'pref', 'convo', 'song', 'capture']);
const MAX_BATCH = 500;
const MAX_RECORD_BYTES = 1_500_000; // a whiteboard page with a lot of ink

export async function pull(userId, since = 0, limit = 400) {
  const { rows } = await q(
    `SELECT kind, id, updated_at, deleted, data, seq
       FROM records
      WHERE user_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
    [userId, Number(since) || 0, Math.min(limit, 1000)],
  );
  const cursor = rows.length ? Number(rows[rows.length - 1].seq) : Number(since) || 0;
  return {
    records: rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      updatedAt: Number(r.updated_at),
      deleted: r.deleted,
      data: r.data,
    })),
    cursor,
    more: rows.length >= Math.min(limit, 1000),
  };
}

export async function push(userId, records) {
  if (!Array.isArray(records)) return { error: 'bad_payload' };
  if (records.length > MAX_BATCH) return { error: 'batch_too_large', max: MAX_BATCH };

  const rejected = [];
  const accepted = [];

  for (const r of records) {
    if (!r || !KINDS.has(r.kind) || typeof r.id !== 'string' || !r.id) {
      rejected.push({ id: r?.id ?? null, reason: 'bad_record' });
      continue;
    }
    const updatedAt = Number(r.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
      rejected.push({ id: r.id, reason: 'bad_updated_at' });
      continue;
    }
    const json = JSON.stringify(r.data ?? {});
    if (json.length > MAX_RECORD_BYTES) {
      rejected.push({ id: r.id, reason: 'too_large' });
      continue;
    }
    accepted.push({ kind: r.kind, id: r.id, updatedAt, deleted: !!r.deleted, json });
  }

  if (!accepted.length) return { cursor: await headSeq(userId), applied: 0, rejected };

  const client = await (await import('./db.js')).pool.connect();
  try {
    await client.query('BEGIN');
    let applied = 0;
    for (const a of accepted) {
      // nextval() per row keeps `seq` strictly increasing even inside one
      // transaction, so a pull cursor never skips a sibling record.
      const res = await client.query(
        `INSERT INTO records (user_id, kind, id, updated_at, deleted, data, seq)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, nextval('record_seq'))
         ON CONFLICT (user_id, kind, id) DO UPDATE
           SET updated_at = EXCLUDED.updated_at,
               deleted    = EXCLUDED.deleted,
               data       = EXCLUDED.data,
               seq        = nextval('record_seq')
           WHERE records.updated_at < EXCLUDED.updated_at`,
        [userId, a.kind, a.id, a.updatedAt, a.deleted, a.json],
      );
      applied += res.rowCount;
    }
    await client.query('COMMIT');
    return { cursor: await headSeq(userId), applied, rejected };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function headSeq(userId) {
  const { rows } = await q(`SELECT COALESCE(MAX(seq), 0) AS seq FROM records WHERE user_id = $1`, [userId]);
  return Number(rows[0].seq);
}

export async function wipe(userId) {
  await q(`DELETE FROM records WHERE user_id = $1`, [userId]);
}
