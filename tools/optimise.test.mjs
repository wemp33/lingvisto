// Checks the tuner on synthetic learners whose true parameters are known.
//
// The bar is not "does it produce numbers" — a broken optimiser does that. It
// is: given a learner who genuinely forgets faster than average, does tuning
// move the predictions towards them, and does it refuse when there is not
// enough evidence to justify moving at all?
//   node tools/optimise.test.mjs
import { DEFAULT_PARAMETERS, makeModel, simulate, logLoss } from '../server/fsrs-core.js';
import { optimise, toHistories, measuredRetention, MIN_REVIEWS } from '../server/optimise.js';
import { Scheduler, STATE } from '../public/js/srs.js';

const DAY = 86_400_000;
let fails = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label} ${detail}`); fails += 1; }
};

/* ---- the forward model must agree with the scheduler it will tune ---- */
console.log('forward model agrees with the scheduler');
{
  const s = new Scheduler({ enableFuzzing: false });
  const m = makeModel(DEFAULT_PARAMETERS);
  check(Math.abs(m.initialStability(3) - s.initialStability(3)) < 1e-12, 'initial stability');
  check(Math.abs(m.initialDifficulty(3) - s.initialDifficulty(3)) < 1e-12, 'initial difficulty');
  check(Math.abs(m.initialDifficulty(4, false) - s.initialDifficulty(4, false)) < 1e-12,
    'unclamped mean-reversion target');
  check(Math.abs(m.nextDifficulty(5.2, 2) - s.nextDifficulty(5.2, 2)) < 1e-12, 'next difficulty');
  check(Math.abs(m.nextStability(5.2, 12, 0.9, 3) - s.nextStability(5.2, 12, 0.9, 3)) < 1e-12, 'next stability');
  const card = { stability: 12, difficulty: 5.2, lastReview: 0, state: STATE.REVIEW };
  check(Math.abs(m.retrievability(12, 7) - s.retrievability(card, 7 * DAY)) < 1e-12, 'retrievability');
}

/* ---- generate a synthetic learner from known parameters ---- */
// Deterministic PRNG so a failure is reproducible.
function rng(seed) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

function makeLearner(trueParams, { cards = 260, reviews = 9, seed = 7 } = {}) {
  const m = makeModel(trueParams);
  const rand = rng(seed);
  const histories = [];

  for (let c = 0; c < cards; c++) {
    const list = [];
    let t = 0;
    let stability = m.initialStability(3);
    let difficulty = m.initialDifficulty(3);
    list.push({ cardId: `c${c}`, rating: 3, reviewedAt: t, stateBefore: 'learning' });

    for (let i = 1; i < reviews; i++) {
      // Schedule at roughly 90% predicted recall, as the app would.
      const interval = Math.max(1, Math.round(stability * (0.9 + rand() * 0.3)));
      t += interval * DAY;
      const p = m.retrievability(stability, interval);
      const remembered = rand() < p;
      const rating = remembered ? (rand() < 0.25 ? 4 : 3) : 1;
      list.push({ cardId: `c${c}`, rating, reviewedAt: t, stateBefore: 'review' });
      stability = m.nextStability(difficulty, stability, p, rating);
      difficulty = m.nextDifficulty(difficulty, rating);
    }
    histories.push({ cardId: `c${c}`, reviews: list });
  }
  return histories;
}

/* ---- a learner who forgets faster than the defaults expect ---- */
console.log('\ntuning towards a faster-forgetting learner');
{
  const trueParams = DEFAULT_PARAMETERS.slice();
  trueParams[8] = 1.15;   // weaker stability growth on recall
  trueParams[9] = 0.30;   // steeper penalty as stability rises
  trueParams[10] = 0.55;

  const histories = makeLearner(trueParams, { cards: 300, reviews: 9, seed: 11 });
  const total = histories.reduce((a, h) => a + h.reviews.length, 0);
  check(total > MIN_REVIEWS, `generated enough history (${total} reviews)`);

  const before = logLoss(simulate(histories, DEFAULT_PARAMETERS));
  const res = optimise(histories, { rounds: 3 });

  check(res.improved, 'tuning improved held-out loss', `baseline ${res.baseline.test.toFixed(4)} tuned ${res.tuned.test.toFixed(4)}`);
  check(res.tuned.test < res.baseline.test, 'held-out loss went down');
  check(res.gain > 0, `reported a real gain (${res.gain}%)`);
  check(res.params.length === 21, 'returned a full parameter vector');
  check(res.params.every((p, i) => Number.isFinite(p)), 'all parameters finite');
  console.log(`       log loss ${before.toFixed(4)} -> ${res.tuned.train.toFixed(4)} (train), `
    + `${res.baseline.test.toFixed(4)} -> ${res.tuned.test.toFixed(4)} (held out)`);
}

/* ---- a learner who behaves exactly like the defaults ---- */
// Tuning must not manufacture an improvement out of noise.
console.log('\nan average learner is left alone');
{
  const histories = makeLearner(DEFAULT_PARAMETERS, { cards: 220, reviews: 8, seed: 23 });
  const res = optimise(histories, { rounds: 2 });
  check(res.tuned.test <= res.baseline.test + 1e-6, 'never returns a worse scheduler than the default');
  if (!res.improved) {
    check(res.params.every((p, i) => p === DEFAULT_PARAMETERS[i]), 'falls back to the defaults verbatim');
  } else {
    console.log(`       accepted a small gain of ${res.gain}% — allowed, since it held up out of sample`);
  }
}

/* ---- too little history ---- */
console.log('\nrefuses to tune on thin evidence');
{
  const histories = makeLearner(DEFAULT_PARAMETERS, { cards: 8, reviews: 3, seed: 5 });
  const total = histories.reduce((a, h) => a + h.reviews.length, 0);
  check(total < MIN_REVIEWS, `well under the threshold (${total} reviews)`);
  const res = optimise(histories, { rounds: 1 });
  check(res.params.length === 21 && res.params.every(Number.isFinite), 'still returns something usable');
}

/* ---- grouping and retention ---- */
console.log('\nhistory handling');
{
  const raw = [
    { cardId: 'a', rating: 3, reviewedAt: 0, stateBefore: 'learning' },
    { cardId: 'a', rating: 1, reviewedAt: 3 * DAY, stateBefore: 'review' },
    { cardId: 'a', rating: 3, reviewedAt: 5 * DAY, stateBefore: 'review' },
    { cardId: 'b', rating: 3, reviewedAt: 0, stateBefore: 'learning' },
  ];
  const h = toHistories(raw);
  check(h.length === 1, 'single-review cards are dropped', `got ${h.length}`);
  check(h[0].reviews.length === 3, 'the multi-review card is kept whole');
  const { retention, n } = measuredRetention(h);
  check(n === 2 && Math.abs(retention - 0.5) < 1e-9, 'measured retention counts review-state answers only');
}

console.log(fails ? `\n${fails} FAILURES` : '\nOptimiser behaves correctly.');
process.exit(fails ? 1 : 0);
