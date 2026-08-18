// Review. Four kinds of card per word, each on its own FSRS schedule, because
// recognising a word, producing it, saying it and writing it are four different
// memories that decay at four different rates.
//
// One honesty rule runs through this screen: the app only claims to have graded
// something when it actually can. Typing and handwriting are checked against a
// known answer. Pronunciation is not — no browser API scores phonemes, and an
// LLM asked to judge audio will cheerfully call plainly wrong articulation
// native-like. So that card plays the model pronunciation and asks the learner
// to judge themselves, rather than inventing a score.

import * as store from './store.js';
import * as api from './api.js';
import * as kb from './keyboard.js';
import { Scheduler, RATING, STATE, SKILLS, buildQueue, creditSiblings, disperseSiblings, gradeFromScore, dayStart, loadBalance, dueHistogram } from './srs.js';
import { LANGS, looseEqual, stripStress } from './lang.js';
import { InkSurface } from './ink.js';
import { t, uiLang, relativeTime } from './i18n.js';
import { el, clear, toast, toastError, tap, debounce } from './ui.js';

export async function dueCount(lang, prefs = {}) {
  const [cards, words] = await Promise.all([store.all('card'), store.all('word')]);
  const byId = new Map(words.map((w) => [w.id, w]));
  const mine = cards.filter((c) => byId.get(c.wordId)?.lang === lang);
  return buildQueue(mine, {
    newPerDay: prefs.newPerDay ?? 5,
    maxReviews: prefs.maxReviews ?? 120,
  }).length;
}

export async function dueWordsForTutor(lang, limit = 25) {
  const [cards, words] = await Promise.all([store.all('card'), store.all('word')]);
  const byId = new Map(words.map((w) => [w.id, w]));
  const now = Date.now();
  const ids = new Set(
    cards.filter((c) => c.due <= now && byId.get(c.wordId)?.lang === lang).map((c) => c.wordId),
  );
  return [...ids].slice(0, limit).map((id) => ({ term: byId.get(id).term }));
}

export function renderReview(root, ctx) {
  clear(root);
  const lang = ctx.lang();
  const L = LANGS[lang];
  const prefs = ctx.prefs();
  // Parameters tuned to this learner if they have enough history for it to
  // mean anything; the population defaults otherwise.
  const scheduler = new Scheduler({
    desiredRetention: prefs.retention ?? 0.9,
    parameters: prefs.fsrsParams || undefined,
  });

  const wrap = el('div.rv');
  const bar = el('div.bar');
  const barFill = el('i');
  bar.append(barFill);
  const stage = el('div.stage');
  const grade = el('div.grade', { hidden: true });
  wrap.append(bar, stage, grade);
  root.append(wrap);

  let queue = [];
  let words = new Map();
  let allCards = [];
  let index = 0;
  let done = 0;
  let current = null;
  let revealed = false;
  let inkSurface = null;

  async function load() {
    const [cards, wordList] = await Promise.all([store.all('card'), store.all('word')]);
    words = new Map(wordList.map((w) => [w.id, w]));
    allCards = cards.filter((c) => words.get(c.wordId)?.lang === lang);
    queue = buildQueue(allCards, {
      newPerDay: prefs.newPerDay ?? 5,
      maxReviews: prefs.maxReviews ?? 120,
    });
    index = 0;
    done = 0;
    next();
  }

  function next() {
    revealed = false;
    inkSurface?.destroy();
    inkSurface = null;
    kb.hide();
    grade.hidden = true;
    clear(grade);

    current = queue[index];
    barFill.style.width = `${queue.length ? (done / queue.length) * 100 : 100}%`;

    if (!current) return renderDone();
    const word = words.get(current.wordId);
    if (!word) { index += 1; return next(); }
    renderCard(word, current);
  }

  function renderDone() {
    clear(stage);
    const node = el('div.empty');
    node.append(
      el('p', { text: t('rv.allDone') }),
      el('p.hint2', { text: t('rv.allDoneHint') }),
    );
    stage.append(node);
    ctx.refreshDue();
  }

  /* ── grading ─────────────────────────────────────────────────────────── */

  function showGrades(auto = null) {
    clear(grade);
    grade.hidden = false;
    const preview = scheduler.preview(current);
    const labels = [
      [RATING.AGAIN, 'rv.again'],
      [RATING.HARD, 'rv.hard'],
      [RATING.GOOD, 'rv.good'],
      [RATING.EASY, 'rv.easy'],
    ];
    for (const [r, key] of labels) {
      grade.append(el('button', {
        dataset: { r: String(r) },
        onclick: () => applyGrade(r),
      }, [
        el('span', { text: t(key) }),
        el('span.when', { text: relativeTime(preview[r]) }),
      ]));
    }
    // An auto-graded card still shows the buttons — the learner always has the
    // final say over their own memory.
    if (auto != null) {
      const btn = grade.querySelector(`button[data-r="${auto}"]`);
      btn?.setAttribute('style', 'outline:2px solid var(--accent);outline-offset:-2px');
    }
  }

  async function applyGrade(rating, rawScore = null) {
    tap(10);
    const now = Date.now();
    const { card, log } = scheduler.review(current, rating, now);

    // Nudge the new due date onto the quietest nearby day, so review load stays
    // flat instead of arriving in spikes.
    if (card.state === STATE.REVIEW) {
      card.due = now + loadBalance(card.due - now, dueHistogram(allCards, now), { now });
    }

    const writes = [
      { kind: 'card', id: card.id, updatedAt: now, data: card },
      { kind: 'log', id: store.uid(), updatedAt: now, data: { ...log, rawScore, lang } },
    ];

    // FSRS models every card in isolation, so sibling relationships have to be
    // applied by hand: spread siblings apart in time, and credit the weaker
    // skill when a stronger one succeeds.
    for (const s of disperseSiblings(allCards, card)) {
      writes.push({ kind: 'card', id: s.id, updatedAt: now, data: s });
    }
    for (const s of creditSiblings(allCards, card, rating, now)) {
      writes.push({ kind: 'card', id: s.id, updatedAt: now, data: s });
    }

    await store.putMany(writes);
    allCards = allCards.map((c) => {
      const w = writes.find((x) => x.kind === 'card' && x.id === c.id);
      return w ? w.data : c;
    });

    done += 1;
    index += 1;
    next();
  }

  /* ── card layouts ────────────────────────────────────────────────────── */

  function renderCard(word, card) {
    clear(stage);
    stage.append(el('div.ask', { text: t(`rv.skill.${card.skill}`) }));

    if (card.skill === 'recognise') return renderRecognise(word);
    if (card.skill === 'produce') return renderProduce(word);
    if (card.skill === 'pronounce') return renderPronounce(word);
    return renderWrite(word);
  }

  const glossOf = (word) =>
    (word.translations?.[uiLang()] || word.translations?.en || word.translations?.pl || []).join(', ');

  function renderRecognise(word) {
    stage.append(el('div.prompt', { text: word.term, lang: L.bcp47 }));
    const reveal = el('button.btn.quiet', { text: t('rv.show'), style: { maxWidth: '260px' } });
    stage.append(reveal);
    reveal.addEventListener('click', () => {
      reveal.remove();
      stage.append(el('div.answer', { text: glossOf(word) }));
      if (word.example?.text) {
        stage.append(el('div.note', { text: word.example.text, lang: L.bcp47, style: { fontFamily: 'var(--serif)', fontSize: '16px' } }));
      }
      showGrades();
    });
  }

  function renderProduce(word) {
    stage.append(el('div.prompt', { text: glossOf(word), style: { fontSize: '28px' } }));
    const input = el('input.input.l2', {
      type: 'text', placeholder: L.endonym, lang: L.bcp47,
      style: { maxWidth: '340px', textAlign: 'center' },
      autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    });
    const verdict = el('div.answer');
    stage.append(input, verdict);
    kb.bind(input, () => lang);

    const check = () => {
      const typed = input.value.trim();
      if (!typed) return;
      kb.hide();
      // Stress marks and capitalisation are not what this card is testing.
      const right = looseEqual(typed, word.term);
      verdict.textContent = right ? '✓ ' + t('rv.correct') : '✕ ' + t('rv.notQuite');
      verdict.style.color = right ? 'var(--accent)' : 'var(--rose)';
      if (!right) {
        stage.append(el('div.prompt', { text: word.term, lang: L.bcp47, style: { fontSize: '30px' } }));
      }
      input.disabled = true;
      showGrades(right ? RATING.GOOD : RATING.AGAIN);
    };
    input.addEventListener('kb-submit', check);
    stage.append(el('button.btn.quiet', { text: t('act.check'), style: { maxWidth: '200px' }, onclick: check }));
    setTimeout(() => input.focus(), 120);
  }

  function renderPronounce(word) {
    stage.append(el('div.prompt', { text: word.term, lang: L.bcp47 }));
    if (word.ipa) stage.append(el('div.note', { text: `[${word.ipa}]` }));

    const play = async (slow) => {
      try {
        const url = await api.speak(word.term, lang, { slow });
        await new Audio(url).play();
      } catch (e) { toastError(e); }
    };

    stage.append(el('div', { style: { display: 'flex', gap: '9px' } }, [
      el('button.btn.sm', { text: '▶ ' + t('gl.listen'), onclick: () => play(false) }),
      el('button.btn.sm.quiet', { text: '▶ ' + t('gl.listenSlow'), onclick: () => play(true) }),
    ]));

    stage.append(el('div.note', {
      text: L.pronunciation.focus[uiLang()]?.[0]
        ? `${t('rv.tapToSpeak')} · ${L.pronunciation.focus[uiLang()][0]}`
        : t('rv.tapToSpeak'),
      style: { maxWidth: '30ch' },
    }));

    // Self-assessment, honestly labelled. The alternative would be a fabricated
    // score, and a learner who is told they are right when they are not is
    // worse off than one who is told nothing.
    play(false);
    showGrades();
  }

  function renderWrite(word) {
    stage.append(el('div.prompt', { text: glossOf(word), style: { fontSize: '24px' } }));

    const pad = el('div', {
      style: {
        position: 'relative', width: '100%', maxWidth: '520px', height: '190px',
        background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '14px', overflow: 'hidden',
      },
    });
    const g = el('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%' } });
    const d = el('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%' } });
    const w = el('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%', touchAction: 'none' } });
    pad.append(g, d, w);
    stage.append(pad);

    const verdict = el('div.answer');
    stage.append(verdict);

    inkSurface = new InkSurface({ wrap: pad, dry: d, wet: w, guides: g }, {
      guideStyle: 'fourline',
      onStrokeEnd: () => autoCheck(),
    });

    const row = el('div', { style: { display: 'flex', gap: '9px' } }, [
      el('button.btn.sm.quiet', { text: '↶ ' + t('act.undo'), onclick: () => inkSurface.undo() }),
      el('button.btn.sm.quiet', { text: t('act.clear'), onclick: () => { inkSurface.clearInk(); verdict.textContent = ''; } }),
      el('button.btn.sm', { text: t('act.check'), onclick: () => autoCheck.flush() }),
    ]);
    stage.append(row);

    const autoCheck = debounce(async () => {
      if (inkSurface?.isEmpty()) return;
      verdict.textContent = t('wr.reading');
      verdict.style.color = 'var(--muted)';
      try {
        const r = await api.recogniseInk({
          lang,
          ink: inkSurface.toRecognitionInk(),
          width: Math.round(inkSurface.w),
          height: Math.round(inkSurface.h),
        });
        const candidates = r.candidates || [];
        const hit = candidates.findIndex((c) => looseEqual(c, word.term));
        if (hit === 0) {
          verdict.textContent = '✓ ' + t('rv.correct');
          verdict.style.color = 'var(--accent)';
          showGrades(RATING.GOOD);
        } else if (hit > 0) {
          verdict.textContent = '≈ ' + candidates[0];
          verdict.style.color = 'var(--amber)';
          showGrades(RATING.HARD);
        } else {
          verdict.textContent = candidates.length
            ? `${t('wr.iRead')}: ${candidates[0]} · ${t('rv.expected')}: ${word.term}`
            : t('rv.notQuite');
          verdict.style.color = 'var(--rose)';
          showGrades(RATING.AGAIN);
        }
      } catch {
        // With no recogniser the learner grades themselves rather than being
        // blocked; the writing practice still happened.
        verdict.textContent = word.term;
        verdict.style.color = 'var(--accent-deep)';
        showGrades();
      }
    }, 700);
  }

  load();
  const off = store.onChange('word', load);
  return () => { off(); inkSurface?.destroy(); kb.hide(); };
}
