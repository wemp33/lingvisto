// FSRS-6, ported from the reference implementation (open-spaced-repetition/py-fsrs,
// MIT) so the app carries no runtime dependency. The maths is the reference's,
// not an approximation of it — see srs.test.mjs for golden vectors.
//
// Two things in here look like bugs and are not:
//   * the mean-reversion target is computed with clamping OFF, so it evaluates
//     to -4.7728 with the default parameters. Clamping it to [1,10] is the
//     classic porting mistake and diverges silently over months of history.
//   * DECAY is negative (-w20) and FACTOR is derived from it, not a constant.

export const DEFAULT_PARAMETERS = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  0.1542,
];

export const RATING = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };
export const STATE = { LEARNING: 'learning', REVIEW: 'review', RELEARNING: 'relearning' };

const STABILITY_MIN = 0.001;
const MIN_DIFFICULTY = 1.0;
const MAX_DIFFICULTY = 10.0;
const MINUTE = 60_000;
const DAY = 86_400_000;

// Default steps, expressed in milliseconds.
const LEARNING_STEPS = [1 * MINUTE, 10 * MINUTE];
const RELEARNING_STEPS = [10 * MINUTE];

const FUZZ_RANGES = [
  { start: 2.5, end: 7.0, factor: 0.15 },
  { start: 7.0, end: 20.0, factor: 0.10 },
  { start: 20.0, end: Infinity, factor: 0.05 },
];

const clampD = (d) => Math.min(Math.max(d, MIN_DIFFICULTY), MAX_DIFFICULTY);
const clampS = (s) => Math.max(s, STABILITY_MIN);

export class Scheduler {
  constructor({
    parameters = DEFAULT_PARAMETERS,
    desiredRetention = 0.9,
    maximumInterval = 36500,
    enableFuzzing = true,
    learningSteps = LEARNING_STEPS,
    relearningSteps = RELEARNING_STEPS,
  } = {}) {
    this.w = parameters.slice();
    // The slider is capped in the UI too; this is the backstop. Above 0.95 the
    // daily load multiplies far faster than people expect and the deck dies.
    this.desiredRetention = Math.min(Math.max(desiredRetention, 0.7), 0.95);
    this.maximumInterval = maximumInterval;
    this.enableFuzzing = enableFuzzing;
    this.learningSteps = learningSteps;
    this.relearningSteps = relearningSteps;
    this.DECAY = -this.w[20];
    this.FACTOR = 0.9 ** (1 / this.DECAY) - 1;
  }

  /* ---- core curves ---- */

  // Probability the card is still recallable after `elapsedDays`.
  retrievability(card, now = Date.now()) {
    // Compare against null, not falsiness: a lastReview of 0 is a real
    // timestamp and would otherwise report the card as entirely forgotten.
    if (card.lastReview == null || card.stability == null) return 0;
    const elapsedDays = Math.max(0, (now - card.lastReview) / DAY);
    return (1 + this.FACTOR * elapsedDays / card.stability) ** this.DECAY;
  }

  initialStability(rating) {
    return clampS(this.w[rating - 1]);
  }

  initialDifficulty(rating, clamp = true) {
    const d = this.w[4] - Math.E ** (this.w[5] * (rating - 1)) + 1;
    return clamp ? clampD(d) : d;
  }

  nextDifficulty(difficulty, rating) {
    const linearDamping = (delta, d) => ((10.0 - d) * delta) / 9.0;
    // Deliberately unclamped: the reference passes clamp=False here.
    const arg1 = this.initialDifficulty(RATING.EASY, false);
    const delta = -(this.w[6] * (rating - 3));
    const arg2 = difficulty + linearDamping(delta, difficulty);
    return clampD(this.w[7] * arg1 + (1 - this.w[7]) * arg2);
  }

  shortTermStability(stability, rating) {
    let inc = Math.E ** (this.w[17] * (rating - 3 + this.w[18])) * stability ** -this.w[19];
    if (rating !== RATING.AGAIN) inc = Math.max(inc, 1.0);
    return clampS(stability * inc);
  }

  nextForgetStability(difficulty, stability, retrievability) {
    const longTerm =
      this.w[11] *
      difficulty ** -this.w[12] *
      ((stability + 1) ** this.w[13] - 1) *
      Math.E ** ((1 - retrievability) * this.w[14]);
    const shortTerm = stability / Math.E ** (this.w[17] * this.w[18]);
    return Math.min(longTerm, shortTerm);
  }

  nextRecallStability(difficulty, stability, retrievability, rating) {
    const hardPenalty = rating === RATING.HARD ? this.w[15] : 1;
    const easyBonus = rating === RATING.EASY ? this.w[16] : 1;
    return (
      stability *
      (1 +
        Math.E ** this.w[8] *
          (11 - difficulty) *
          stability ** -this.w[9] *
          (Math.E ** ((1 - retrievability) * this.w[10]) - 1) *
          hardPenalty *
          easyBonus)
    );
  }

  nextStability(difficulty, stability, retrievability, rating) {
    const s =
      rating === RATING.AGAIN
        ? this.nextForgetStability(difficulty, stability, retrievability)
        : this.nextRecallStability(difficulty, stability, retrievability, rating);
    return clampS(s);
  }

  // Days until retrievability falls to the desired retention.
  nextIntervalDays(stability) {
    const raw = (stability / this.FACTOR) * (this.desiredRetention ** (1 / this.DECAY) - 1);
    return Math.min(Math.max(Math.round(raw), 1), this.maximumInterval);
  }

  // Without fuzz every card learnt in one sitting comes due on the same day
  // forever, which produces 200-card days separated by empty ones.
  fuzzIntervalMs(intervalMs, rng = Math.random) {
    if (!this.enableFuzzing) return intervalMs;
    const days = intervalMs / DAY;
    if (days < 2.5) return intervalMs;

    let delta = 1.0;
    for (const r of FUZZ_RANGES) {
      delta += r.factor * Math.max(0, Math.min(days, r.end) - r.start);
    }
    let min = Math.round(days - delta);
    let max = Math.round(days + delta);
    min = Math.max(2, min);
    max = Math.min(max, this.maximumInterval);
    min = Math.min(min, max);
    return (min + Math.floor(rng() * (max - min + 1))) * DAY;
  }

  /* ---- the review itself ---- */

  // Returns { card, log }. `card` is new; the input is not mutated.
  review(cardIn, rating, now = Date.now(), rng = Math.random) {
    const card = { ...cardIn };
    const daysSince = card.lastReview == null ? null : (now - card.lastReview) / DAY;
    let intervalMs;

    const advanceState = (steps, stateName) => {
      // Edge case: a card scheduled under a longer step list than the current one.
      if (steps.length === 0 || (card.step >= steps.length && rating !== RATING.AGAIN)) {
        card.state = STATE.REVIEW;
        card.step = null;
        return this.nextIntervalDays(card.stability) * DAY;
      }
      switch (rating) {
        case RATING.AGAIN:
          card.step = 0;
          return steps[0];
        case RATING.HARD:
          if (card.step === 0 && steps.length === 1) return steps[0] * 1.5;
          if (card.step === 0 && steps.length >= 2) return (steps[0] + steps[1]) / 2.0;
          return steps[card.step];
        case RATING.GOOD:
          if (card.step + 1 === steps.length) {
            card.state = STATE.REVIEW;
            card.step = null;
            return this.nextIntervalDays(card.stability) * DAY;
          }
          card.step += 1;
          return steps[card.step];
        case RATING.EASY:
          card.state = STATE.REVIEW;
          card.step = null;
          return this.nextIntervalDays(card.stability) * DAY;
        default:
          throw new Error(`unknown rating ${rating}`);
      }
    };

    if (card.state === STATE.LEARNING || card.state === STATE.RELEARNING) {
      if (card.stability == null || card.difficulty == null) {
        card.stability = this.initialStability(rating);
        card.difficulty = this.initialDifficulty(rating, true);
      } else if (daysSince != null && daysSince < 1) {
        card.stability = this.shortTermStability(card.stability, rating);
        card.difficulty = this.nextDifficulty(card.difficulty, rating);
      } else {
        card.stability = this.nextStability(
          card.difficulty, card.stability, this.retrievability(card, now), rating,
        );
        card.difficulty = this.nextDifficulty(card.difficulty, rating);
      }
      const steps = card.state === STATE.LEARNING ? this.learningSteps : this.relearningSteps;
      intervalMs = advanceState(steps, card.state);
    } else {
      // Review state.
      card.stability = this.nextStability(
        card.difficulty, card.stability, this.retrievability(card, now), rating,
      );
      card.difficulty = this.nextDifficulty(card.difficulty, rating);

      if (rating === RATING.AGAIN) {
        if (this.relearningSteps.length === 0) {
          intervalMs = this.nextIntervalDays(card.stability) * DAY;
        } else {
          card.state = STATE.RELEARNING;
          card.step = 0;
          intervalMs = this.relearningSteps[0];
        }
      } else {
        intervalMs = this.nextIntervalDays(card.stability) * DAY;
      }
    }

    if (card.state === STATE.REVIEW) intervalMs = this.fuzzIntervalMs(intervalMs, rng);

    card.due = now + intervalMs;
    card.lastReview = now;
    card.reps = (card.reps || 0) + 1;
    if (rating === RATING.AGAIN) card.lapses = (card.lapses || 0) + 1;

    const log = {
      cardId: card.id,
      rating,
      reviewedAt: now,
      elapsedDays: daysSince == null ? null : Math.round(daysSince),
      stateBefore: cardIn.state,
    };
    return { card, log };
  }

  // What each button would do, for the "1m / 10m / 4d / 9d" hints on the
  // review buttons. Fuzz is disabled so the preview matches what is shown.
  preview(card, now = Date.now()) {
    const out = {};
    const noFuzz = () => 0.5;
    for (const r of [RATING.AGAIN, RATING.HARD, RATING.GOOD, RATING.EASY]) {
      const saved = this.enableFuzzing;
      this.enableFuzzing = false;
      out[r] = this.review(card, r, now, noFuzz).card.due - now;
      this.enableFuzzing = saved;
    }
    return out;
  }
}

/* ---------- cards ---------- */

// Each glossary word spawns one card per skill. Recognition and production have
// genuinely different forgetting curves, so they cannot share a schedule.
export const SKILLS = ['recognise', 'produce', 'pronounce', 'write'];

export function newCard(wordId, skill, now = Date.now()) {
  return {
    id: `${wordId}:${skill}`,
    wordId,
    skill,
    state: STATE.LEARNING,
    step: 0,
    stability: null,
    difficulty: null,
    due: now,
    lastReview: null,
    reps: 0,
    lapses: 0,
    suspended: false,
  };
}

// FSRS takes only 1-4. A continuous score from speech or handwriting has to be
// bucketed before it gets here; the raw score is logged separately so the
// thresholds can be recalibrated later without throwing away history.
export function gradeFromScore(score) {
  if (score < 0.5) return RATING.AGAIN;
  if (score < 0.75) return RATING.HARD;
  if (score < 0.92) return RATING.GOOD;
  return RATING.EASY;
}

/* ---------- queue building ---------- */

// Anki's convention: the study day rolls over at 04:00 local, so a late-night
// session before midnight counts as the same day as one twenty minutes later.
export const ROLLOVER_HOUR = 4;

export function dayStart(now = Date.now()) {
  const d = new Date(now);
  if (d.getHours() < ROLLOVER_HOUR) d.setDate(d.getDate() - 1);
  d.setHours(ROLLOVER_HOUR, 0, 0, 0);
  return d.getTime();
}

// FSRS schedules every card in isolation — no equation reads a sibling. Left
// alone, that means being drilled on recognising a word you can already
// actively produce. Production strictly dominates recognition, so a success
// there is real evidence about the recognition card and is credited forward.
const DOMINATES = { produce: ['recognise'], write: ['recognise'], pronounce: [] };

export function creditSiblings(cards, reviewedCard, rating, now = Date.now()) {
  if (rating < RATING.GOOD) return [];
  const weaker = DOMINATES[reviewedCard.skill] || [];
  const touched = [];
  for (const c of cards) {
    if (c.wordId !== reviewedCard.wordId || !weaker.includes(c.skill)) continue;
    if (c.state === STATE.LEARNING || c.due > now) continue;
    // Push it out by the sibling's own next interval rather than grading it,
    // so its stability is never inflated by evidence it did not earn.
    touched.push({ ...c, due: now + Math.max(DAY, (reviewedCard.due - now) * 0.6) });
  }
  return touched;
}

// Siblings shown in the same session measure nothing — you just read the answer
// on the other card. Burying guarantees a day's gap; dispersing spreads them out.
export function disperseSiblings(cards, justScheduled, minGapDays = 2) {
  const gap = minGapDays * DAY;
  const out = [];
  for (const c of cards) {
    if (c.wordId !== justScheduled.wordId || c.id === justScheduled.id) continue;
    if (c.state !== STATE.REVIEW) continue;
    if (Math.abs(c.due - justScheduled.due) < gap) {
      out.push({ ...c, due: justScheduled.due + gap });
    }
  }
  return out;
}

// Spread a new due date onto whichever of the nearby days is least busy.
//
// Fuzz stops everything learnt in one sitting from clumping, but it is blind —
// it scatters at random and can pile three cards onto a day that already has
// eighty. This looks at what is actually scheduled and picks the quietest day
// in the window, which flattens the daily load without moving anything far
// enough to matter to memory. A 200-card day is what makes people quit.
export function loadBalance(intervalMs, dueByDay, { now = Date.now(), spread = 0.12 } = {}) {
  const DAY = 86_400_000;
  const days = intervalMs / DAY;
  if (days < 3) return intervalMs;

  const window = Math.max(1, Math.round(days * spread));
  const target = Math.round(days);
  let best = target;
  let bestLoad = Infinity;

  for (let d = target - window; d <= target + window; d++) {
    if (d < 1) continue;
    const key = Math.floor((now + d * DAY) / DAY);
    const load = dueByDay.get(key) || 0;
    // Prefer the quietest day, and the one nearest the ideal interval when
    // several are equally quiet.
    const score = load + Math.abs(d - target) * 0.35;
    if (score < bestLoad) { bestLoad = score; best = d; }
  }
  return best * DAY;
}

// How many cards fall on each day, keyed by day number.
export function dueHistogram(cards, now = Date.now()) {
  const DAY = 86_400_000;
  const map = new Map();
  for (const c of cards) {
    if (c.suspended || c.due <= now) continue;
    const key = Math.floor(c.due / DAY);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

export function buildQueue(cards, { newPerDay = 20, maxReviews = 200, now = Date.now() } = {}) {
  const due = [];
  const fresh = [];
  for (const c of cards) {
    if (c.suspended) continue;
    if (c.due > now) continue;
    (c.reps === 0 ? fresh : due).push(c);
  }
  due.sort((a, b) => a.due - b.due);
  fresh.sort((a, b) => a.due - b.due);

  const queue = due.slice(0, maxReviews).concat(fresh.slice(0, newPerDay));
  // One word should not present four cards back to back.
  const seen = new Map();
  queue.sort((a, b) => {
    const ka = seen.get(a.wordId) || 0;
    const kb = seen.get(b.wordId) || 0;
    return ka - kb;
  });
  return queue;
}

// Rough daily-load multiplier relative to 90% retention, so the settings slider
// can warn honestly instead of letting people pick 0.97 and drown.
export function workloadMultiplier(desiredRetention) {
  const base = Math.log(0.9);
  return Math.round((base / Math.log(desiredRetention)) ** 1.6 * 100) / 100;
}
