// FSRS parameter tuning from the learner's own review log.
//
// The shipped parameters were fitted across hundreds of millions of reviews, so
// they are a strong prior — for a while they will beat anything fitted to one
// person. What they cannot know is that this particular learner forgets German
// nouns faster than Italian verbs, or that their "Good" means what most people
// call "Hard". After a few hundred reviews their own history says more.
//
// The method is coordinate descent on binary log loss: for each parameter, try
// a few values around the current one, keep whatever predicts this learner's
// actual remembering and forgetting best, repeat. It is slower than gradient
// descent and completely transparent, which is the right trade for something
// that runs once a month on one person's data.
//
// Two honesty rules are built in. Below MIN_REVIEWS it refuses to tune at all
// and says so, because fitting 21 parameters to 80 observations produces
// confident nonsense. And a tuned set is only returned if it beats the defaults
// on held-out reviews, not on the ones it was fitted to.

import { q } from './db.js';
import { DEFAULT_PARAMETERS, simulate, logLoss } from './fsrs-core.js';

export const MIN_REVIEWS = 400;

// Lower and upper bounds from the reference implementation. Straying outside
// these produces schedulers that are not merely worse but unstable.
const BOUNDS = [
  [0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100],
  [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75],
  [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5],
  [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1],
  [1, 6], [0, 2], [0, 2], [0.0, 0.8],
  [0.1, 0.8],
];

// Read the learner's review log straight out of the sync store. The client has
// been pushing these all along; nothing extra has to be uploaded.
export async function loadReviews(userId, lang = null) {
  const { rows } = await q(
    `SELECT data FROM records
      WHERE user_id = $1 AND kind = 'log' AND deleted = false
      ORDER BY (data->>'reviewedAt')::bigint ASC`,
    [userId],
  );
  return rows
    .map((r) => r.data)
    .filter((d) => d && d.cardId && d.rating >= 1 && d.rating <= 4 && d.reviewedAt)
    .filter((d) => !lang || d.lang === lang);
}

// Group into per-card histories, which is what the model actually consumes:
// an interval and a grade only make sense in sequence.
export function toHistories(reviews) {
  const byCard = new Map();
  for (const r of reviews) {
    if (!byCard.has(r.cardId)) byCard.set(r.cardId, []);
    byCard.get(r.cardId).push(r);
  }
  const out = [];
  for (const [cardId, list] of byCard) {
    list.sort((a, b) => a.reviewedAt - b.reviewedAt);
    // A card with one review carries no information about forgetting: there is
    // no interval to have survived.
    if (list.length >= 2) out.push({ cardId, reviews: list });
  }
  return out;
}

function clamp(v, i) {
  const [lo, hi] = BOUNDS[i];
  return Math.min(hi, Math.max(lo, v));
}

// Split by card, not by review: putting two reviews of the same card on
// opposite sides of the split lets the model see its own answer.
function splitHistories(histories, holdout = 0.25) {
  const test = [];
  const train = [];
  histories.forEach((h, i) => ((i % Math.round(1 / holdout) === 0) ? test : train).push(h));
  return { train, test: test.length ? test : train };
}

export function optimise(histories, { rounds = 4, onProgress = null } = {}) {
  const { train, test } = splitHistories(histories);
  let params = DEFAULT_PARAMETERS.slice();

  const baseline = {
    train: logLoss(simulate(train, DEFAULT_PARAMETERS)),
    test: logLoss(simulate(test, DEFAULT_PARAMETERS)),
  };

  let best = logLoss(simulate(train, params));

  for (let round = 0; round < rounds; round++) {
    // Shrink the step each round: coarse sweep first, then refine.
    const scale = 0.35 / (round + 1);
    let improved = false;

    for (let i = 0; i < params.length; i++) {
      const current = params[i];
      const span = Math.max(Math.abs(current) * scale, (BOUNDS[i][1] - BOUNDS[i][0]) * scale * 0.08);
      for (const delta of [-span, -span / 2, span / 2, span]) {
        const trial = params.slice();
        trial[i] = clamp(current + delta, i);
        if (trial[i] === current) continue;
        const loss = logLoss(simulate(train, trial));
        if (loss < best - 1e-9) {
          best = loss;
          params = trial;
          improved = true;
        }
      }
      onProgress?.({ round, param: i, loss: best });
    }
    if (!improved) break;
  }

  const tuned = {
    train: logLoss(simulate(train, params)),
    test: logLoss(simulate(test, params)),
  };

  // The only number that matters: did it get better on reviews it never saw?
  // Fitting 21 parameters will always improve the training loss, so that
  // figure on its own would be self-congratulation.
  const better = tuned.test < baseline.test - 1e-6;

  return {
    params: better ? params : DEFAULT_PARAMETERS.slice(),
    improved: better,
    baseline,
    tuned,
    // How much of the remaining error was removed on held-out data.
    gain: better ? Math.round(((baseline.test - tuned.test) / baseline.test) * 1000) / 10 : 0,
    reviews: histories.reduce((a, h) => a + h.reviews.length, 0),
    cards: histories.length,
  };
}

// What the learner actually retained, versus what they asked for. If these
// diverge badly the parameters are not the problem — the target is.
export function measuredRetention(histories) {
  let hit = 0;
  let total = 0;
  for (const h of histories) {
    for (let i = 1; i < h.reviews.length; i++) {
      const r = h.reviews[i];
      if (r.stateBefore !== 'review') continue;
      total += 1;
      if (r.rating > 1) hit += 1;
    }
  }
  return total ? { retention: hit / total, n: total } : { retention: null, n: 0 };
}
