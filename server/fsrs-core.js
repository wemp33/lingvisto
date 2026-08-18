// The FSRS-6 forward model, server side.
//
// This is the same maths as public/js/srs.js, but used for the opposite
// purpose: instead of asking "when should this come up again", it asks "given
// these parameters, how likely was the learner to remember this — and did
// they?". That difference is what makes the parameters fittable.
//
// Kept deliberately separate from the scheduler rather than shared, because the
// scheduler is checked against the reference implementation by golden vectors
// and should not grow branches it does not need. The equations below are
// verified against it in tools/optimise.test.mjs.

export const DEFAULT_PARAMETERS = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  0.1542,
];

const STABILITY_MIN = 0.001;
const DAY = 86_400_000;

const clampD = (d) => Math.min(10, Math.max(1, d));
const clampS = (s) => Math.max(s, STABILITY_MIN);

export function makeModel(w) {
  const DECAY = -w[20];
  const FACTOR = 0.9 ** (1 / DECAY) - 1;

  const retrievability = (stability, elapsedDays) =>
    (1 + (FACTOR * Math.max(0, elapsedDays)) / stability) ** DECAY;

  const initialStability = (g) => clampS(w[g - 1]);
  const initialDifficulty = (g, clamp = true) => {
    const d = w[4] - Math.E ** (w[5] * (g - 1)) + 1;
    return clamp ? clampD(d) : d;
  };

  const nextDifficulty = (d, g) => {
    const damped = ((10 - d) * -(w[6] * (g - 3))) / 9;
    // Unclamped mean-reversion target, as in the reference.
    return clampD(w[7] * initialDifficulty(4, false) + (1 - w[7]) * (d + damped));
  };

  const shortTermStability = (s, g) => {
    let inc = Math.E ** (w[17] * (g - 3 + w[18])) * s ** -w[19];
    if (g !== 1) inc = Math.max(inc, 1);
    return clampS(s * inc);
  };

  const forgetStability = (d, s, r) =>
    Math.min(
      w[11] * d ** -w[12] * ((s + 1) ** w[13] - 1) * Math.E ** ((1 - r) * w[14]),
      s / Math.E ** (w[17] * w[18]),
    );

  const recallStability = (d, s, r, g) =>
    s * (1 + Math.E ** w[8] * (11 - d) * s ** -w[9] * (Math.E ** ((1 - r) * w[10]) - 1)
      * (g === 2 ? w[15] : 1) * (g === 4 ? w[16] : 1));

  const nextStability = (d, s, r, g) =>
    clampS(g === 1 ? forgetStability(d, s, r) : recallStability(d, s, r, g));

  return { retrievability, initialStability, initialDifficulty, nextDifficulty, shortTermStability, nextStability };
}

// Replay each card's history. For every review after the first, record what the
// model predicted the learner's chance of recall was, and what actually
// happened. Those pairs are the whole training signal.
export function simulate(histories, w) {
  const m = makeModel(w);
  const preds = [];

  for (const h of histories) {
    let stability = null;
    let difficulty = null;
    let last = null;

    for (const r of h.reviews) {
      if (stability == null) {
        stability = m.initialStability(r.rating);
        difficulty = m.initialDifficulty(r.rating);
        last = r.reviewedAt;
        continue;
      }

      const elapsed = (r.reviewedAt - last) / DAY;
      const p = m.retrievability(stability, elapsed);
      // Same-day reviews are drill, not recall over an interval; they carry
      // almost no information about forgetting and would swamp the fit.
      if (elapsed >= 1) preds.push({ p, actual: r.rating > 1 ? 1 : 0 });

      if (elapsed < 1) {
        stability = m.shortTermStability(stability, r.rating);
      } else {
        stability = m.nextStability(difficulty, stability, p, r.rating);
      }
      difficulty = m.nextDifficulty(difficulty, r.rating);
      last = r.reviewedAt;
    }
  }
  return preds;
}

// Binary cross-entropy. Lower is a better-calibrated model of this learner.
export function logLoss(preds) {
  if (!preds.length) return Infinity;
  const EPS = 1e-9;
  let sum = 0;
  for (const { p, actual } of preds) {
    const q = Math.min(1 - EPS, Math.max(EPS, p));
    sum += actual ? -Math.log(q) : -Math.log(1 - q);
  }
  return sum / preds.length;
}

// Root mean square of predicted-versus-actual, bucketed. More legible than log
// loss when it has to be shown to a person.
export function rmse(preds, buckets = 20) {
  if (!preds.length) return null;
  const bins = Array.from({ length: buckets }, () => ({ n: 0, p: 0, a: 0 }));
  for (const { p, actual } of preds) {
    const b = bins[Math.min(buckets - 1, Math.floor(p * buckets))];
    b.n += 1;
    b.p += p;
    b.a += actual;
  }
  let sum = 0;
  let n = 0;
  for (const b of bins) {
    if (!b.n) continue;
    sum += b.n * ((b.p / b.n) - (b.a / b.n)) ** 2;
    n += b.n;
  }
  return n ? Math.sqrt(sum / n) : null;
}
