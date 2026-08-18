// The glossary: the learner's own words, checked before they are stored.
//
// Nothing the model proposes is written straight to the database. A new word
// goes to a review screen first, showing what was corrected and why, with the
// option to keep it exactly as typed. A glossary quietly "fixed" by a model is
// worse than one with a typo in it, because the learner never finds out.

import * as store from './store.js';
import * as api from './api.js';
import * as kb from './keyboard.js';
import { LANGS, stripStress, looseEqual } from './lang.js';
import { newCard, SKILLS, STATE } from './srs.js';
import { t, uiLang, relativeTime, formatDate } from './i18n.js';
import { el, clear, sheet, toast, toastError, confirmAction, tap, debounce } from './ui.js';
import { songsSection } from './songs.js';

/* ---------- data ---------- */

export async function allWords(lang = null) {
  const words = await store.all('word');
  return lang ? words.filter((w) => w.lang === lang) : words;
}

export function findDuplicate(words, lang, term) {
  const norm = (s) => stripStress(String(s || '')).toLowerCase().trim();
  const target = norm(term);
  return words.find((w) => w.lang === lang && (norm(w.term) === target || norm(w.asWritten) === target)) || null;
}

// One word becomes four cards. Recognition and production have genuinely
// different forgetting curves, so they cannot share a schedule — but four
// cards per word also means the new-words-per-day limit is really a
// new-cards-per-day limit multiplied by four, which is why the default is low.
export async function saveWord(word) {
  const now = Date.now();
  const id = word.id || store.uid();
  const record = { ...word, id, updatedAt: now, createdAt: word.createdAt || now };
  await store.put('word', id, record);

  const existing = await store.all('card');
  const have = new Set(existing.filter((c) => c.wordId === id).map((c) => c.skill));
  const fresh = SKILLS.filter((s) => !have.has(s)).map((s) => ({
    kind: 'card', id: `${id}:${s}`, updatedAt: now, data: newCard(id, s, now),
  }));
  if (fresh.length) await store.putMany(fresh);
  return record;
}

export async function deleteWord(id) {
  const cards = await store.all('card');
  await Promise.all(cards.filter((c) => c.wordId === id).map((c) => store.remove('card', c.id)));
  await store.remove('word', id);
}

// A compact view for the tutor's prompt: just enough to weave a word into
// conversation, without shipping the whole record.
export async function glossaryForTutor(lang, limit = 200) {
  const words = await allWords(lang);
  return words
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((w) => ({ term: w.term, gloss: (w.translations?.[uiLang()] || w.translations?.en || [])[0] || '' }));
}

/* ---------- strength ---------- */

// Four dots, one per skill, filled by how stable that card is. Deliberately
// coarse: a precise number here would imply a precision the scheduler does not
// actually have.
export function strengthDots(cards, wordId) {
  const mine = cards.filter((c) => c.wordId === wordId);
  return SKILLS.map((skill) => {
    const c = mine.find((x) => x.skill === skill);
    if (!c || c.reps === 0) return 0;
    if (c.state === STATE.LEARNING || c.state === STATE.RELEARNING) return 1;
    if (c.stability < 21) return 2;
    return 3;
  });
}

const dotsNode = (levels) => {
  const n = el('span.dots');
  for (const lv of levels) n.append(el(`i${lv ? `.s${lv}` : ''}`));
  return n;
};

/* ═══ add a word ═════════════════════════════════════════════════════════ */

export function openAddWord(ctx, { prefill = '', lang = null, onSaved = null } = {}) {
  const L = LANGS[lang || ctx.lang()];
  const body = el('div');

  const termInput = el('input.input.l2', {
    type: 'text', value: prefill, placeholder: L.endonym,
    lang: L.bcp47, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
  });
  const meaningInput = el('input.input', {
    type: 'text',
    placeholder: uiLang() === 'pl' ? 'po polsku…' : 'in English…',
  });

  const err = el('div.errline', { hidden: true });
  const checkBtn = el('button.btn', { text: t('act.check') });

  body.append(
    el('div.field', {}, [
      el('label', { text: t('gl.term') }),
      termInput,
      el('div.hint', { text: t('gl.termHint', { lang: L.name[uiLang()] }) }),
    ]),
    el('div.field', {}, [
      el('label', { text: t('gl.meaning') }),
      meaningInput,
      el('div.hint', { text: t('gl.meaningOptional') }),
    ]),
    err,
    checkBtn,
  );

  // Lingvisto's own keyboard, because iOS gives a web page no way to switch the
  // system one. The meaning field keeps the normal keyboard — it is being
  // typed in Polish or English, which the learner already has.
  kb.bind(termInput, () => L.code);

  const h = sheet({
    title: t('gl.add'),
    body,
    onClose: () => kb.hide(),
  });

  const run = async () => {
    const term = termInput.value.trim();
    if (!term) return;
    err.hidden = true;
    kb.hide();

    const words = await allWords(L.code);
    const dup = findDuplicate(words, L.code, term);
    if (dup) {
      err.hidden = false;
      clear(err).append(
        document.createTextNode(t('gl.duplicate') + ' '),
        el('button', {
          text: t('gl.openExisting'),
          style: { color: 'var(--accent)', fontWeight: '600', textDecoration: 'underline' },
          onclick: () => { h.close(); openWord(ctx, dup); },
        }),
      );
      return;
    }

    checkBtn.disabled = true;
    clear(checkBtn).append(el('span.spinner'), document.createTextNode(' ' + t('gl.checking')));

    try {
      const result = await api.validateWord({
        lang: L.code,
        term,
        meaning: meaningInput.value.trim() || undefined,
        uiLang: uiLang(),
        level: ctx.level(),
      });
      h.close();
      openWordReview(ctx, { lang: L.code, typed: term, result, onSaved });
    } catch (e) {
      checkBtn.disabled = false;
      clear(checkBtn).append(document.createTextNode(t('act.check')));
      // With no key or no signal the word is still worth keeping; it can be
      // enriched later rather than lost now.
      if (e.code === 'no_key' || e.code === 'offline') {
        const keep = await confirmAction({
          title: t('gl.add'),
          message: `${e.code === 'no_key' ? t('err.no_key') : t('err.offline')} ${t('gl.acceptAnyway')}?`,
          confirmLabel: t('gl.acceptAnyway'),
        });
        if (keep) {
          const saved = await saveWord({
            lang: L.code, term, asWritten: term,
            translations: { [uiLang()]: meaningInput.value.trim() ? [meaningInput.value.trim()] : [] },
            source: 'hand', unchecked: true,
          });
          h.close();
          toast(t('act.save'));
          onSaved?.(saved);
        }
      } else toastError(e);
    }
  };

  checkBtn.addEventListener('click', run);
  termInput.addEventListener('kb-submit', run);
  setTimeout(() => termInput.focus(), 340);
}

/* ═══ review what the model proposed ═════════════════════════════════════ */

function openWordReview(ctx, { lang, typed, result, onSaved }) {
  const L = LANGS[lang];
  const body = el('div');

  const bad = result.status === 'not_a_word' || result.status === 'wrong_language';
  const corrected = result.status === 'corrected';

  if (bad) {
    body.append(el('div.card', {}, [
      el('div.card-body', {}, [
        el('span.pill.bad', { text: result.status === 'not_a_word' ? '✕' : '?' }),
        el('p', {
          style: { margin: '10px 0 0', fontSize: '15px' },
          text: result.status === 'not_a_word'
            ? t('gl.notAWord', { lang: L.name[uiLang()] })
            : (result.correctionNote || ''),
        }),
        result.correctionNote && result.status === 'not_a_word'
          ? el('p.note', { text: result.correctionNote })
          : null,
      ]),
    ]));
  }

  if (corrected) {
    body.append(el('div.card', {}, [
      el('div.card-body', {}, [
        el('span.pill.warn', { text: t('gl.corrected') }),
        el('p', { style: { margin: '10px 0 2px' } }, [
          el('span', { text: t('gl.youWrote') + ': ', style: { color: 'var(--muted)', fontSize: '13px' } }),
          el('span.l2', { text: typed, style: { textDecoration: 'line-through', color: 'var(--rose)' } }),
        ]),
        el('p', { style: { margin: '2px 0 0' } }, [
          el('span.l2.big', { text: result.lemma, lang: L.bcp47 }),
        ]),
        result.correctionNote ? el('p.note', { text: result.correctionNote }) : null,
      ]),
    ]));
  }

  /* the entry itself */
  const entry = el('div.card');
  const eb = el('div.card-body');

  if (!corrected && !bad) {
    eb.append(el('div', { style: { marginBottom: '10px' } }, [
      el('span.l2.big', { text: result.lemma, lang: L.bcp47 }),
    ]));
  }

  const line = (label, value) => (value
    ? el('div', { style: { display: 'flex', gap: '10px', padding: '7px 0', borderTop: '1px solid var(--line-soft)' } }, [
      el('span', { text: label, style: { fontSize: '13px', color: 'var(--muted)', minWidth: '92px', flex: '0 0 auto' } }),
      el('span', { text: value, style: { fontSize: '15px' } }),
    ])
    : null);

  const tr = (list) => (list || []).join(', ');
  eb.append(
    line(uiLang() === 'pl' ? 'polski' : 'Polish', tr(result.translations?.pl)),
    line(uiLang() === 'pl' ? 'angielski' : 'English', tr(result.translations?.en)),
    line('IPA', result.ipa ? `[${result.ipa}]` : ''),
    line(t('gl.grammar'), Object.entries(result.grammar || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')),
    result.register && result.register !== 'neutral' ? line('register', result.register) : null,
  );

  if (result.example?.text) {
    eb.append(el('div', { style: { marginTop: '12px', paddingTop: '11px', borderTop: '1px solid var(--line-soft)' } }, [
      el('div.l2', { text: result.example.text, lang: L.bcp47, style: { fontSize: '17px', lineHeight: '1.4' } }),
      el('div.note', { text: result.example[uiLang()] || result.example.en || '', style: { marginTop: '4px' } }),
    ]));
  }

  if (result.falseFriend) {
    eb.append(el('div', {
      style: {
        marginTop: '12px', padding: '10px 12px', borderRadius: '11px',
        background: 'var(--amber-wash)', fontSize: '14px', color: 'var(--amber)',
      },
      text: `⚠ ${result.falseFriend}`,
    }));
  }

  entry.append(eb);
  body.append(entry);

  const save = async (useTyped) => {
    const word = {
      lang,
      term: useTyped ? typed : (result.lemma || typed),
      asWritten: typed,
      pos: result.pos,
      translations: result.translations || {},
      ipa: result.ipa,
      grammar: result.grammar || {},
      example: result.example || null,
      register: result.register,
      falseFriend: result.falseFriend,
      difficulty: result.difficulty,
      source: 'hand',
      status: result.status,
      unchecked: useTyped,
    };
    const saved = await saveWord(word);
    h.close();
    tap(10);
    toast(t('act.save'));
    onSaved?.(saved);
  };

  const buttons = el('div.btnrow');
  if (!bad) buttons.append(el('button.btn', { text: t('gl.accept'), onclick: () => save(false) }));
  buttons.append(el('button.btn.quiet', {
    text: bad ? t('gl.acceptAnyway') : t('gl.youWrote') + ': ' + typed,
    onclick: () => save(true),
  }));
  body.append(buttons);

  const h = sheet({ title: t('gl.review'), body });
}

/* ═══ word detail ════════════════════════════════════════════════════════ */

export async function openWord(ctx, word) {
  const L = LANGS[word.lang];
  const cards = (await store.all('card')).filter((c) => c.wordId === word.id);
  const body = el('div');

  const head = el('div', { style: { marginBottom: '4px' } });
  head.append(el('div.l2.big', { text: word.term, lang: L.bcp47 }));
  if (word.ipa) head.append(el('div.note', { text: `[${word.ipa}]`, style: { marginTop: '2px' } }));

  const audio = el('div', { style: { display: 'flex', gap: '8px', margin: '12px 0 16px' } });
  const play = async (slow) => {
    try {
      const url = await api.speak(word.term, word.lang, { slow });
      const a = new Audio(url);
      a.play().catch(() => toast(t('err.generic'), { bad: true }));
    } catch (e) { toastError(e); }
  };
  audio.append(
    el('button.btn.sm', { text: '▶  ' + t('gl.listen'), onclick: () => play(false) }),
    el('button.btn.sm.quiet', { text: '▶  ' + t('gl.listenSlow'), onclick: () => play(true) }),
  );

  body.append(head, audio);

  const rows = el('div.rows');
  const addRow = (label, value) => {
    if (!value) return;
    rows.append(el('div.row', {}, [
      el('div.grow', {}, [el('div.sub', { text: label }), el('div.lab', { text: value })]),
    ]));
  };
  addRow(uiLang() === 'pl' ? 'polski' : 'Polish', (word.translations?.pl || []).join(', '));
  addRow(uiLang() === 'pl' ? 'angielski' : 'English', (word.translations?.en || []).join(', '));
  for (const [k, v] of Object.entries(word.grammar || {})) addRow(k, v);
  if (word.register && word.register !== 'neutral') addRow('register', word.register);
  body.append(rows);

  if (word.example?.text) {
    body.append(el('div.sect', { text: t('gl.example') }));
    body.append(el('div.card', {}, [el('div.card-body', {}, [
      el('div.l2', { text: word.example.text, lang: L.bcp47, style: { fontSize: '17px', lineHeight: '1.45' } }),
      el('div.note', { text: word.example[uiLang()] || word.example.en || '' }),
    ])]));
  }

  /* schedule */
  body.append(el('div.sect', { text: t('gl.strength') }));
  const sched = el('div.rows');
  for (const skill of SKILLS) {
    const c = cards.find((x) => x.skill === skill);
    const dueIn = c && c.reps > 0 ? relativeTime(c.due - Date.now()) : '—';
    sched.append(el('div.row', {}, [
      el('div.grow', {}, [el('div.lab', { text: t(`rv.skill.${skill}`) })]),
      el('div.val', { text: c && c.reps > 0 ? (c.due < Date.now() ? t('gl.new') : dueIn) : t('gl.new') }),
    ]));
  }
  body.append(sched);

  body.append(el('div.note', {
    text: `${t('gl.addedOn')} ${formatDate(word.createdAt)} · ${word.source === 'talk' ? t('gl.fromTalk') : t('gl.byHand')}`,
  }));

  body.append(el('div', { style: { marginTop: '20px' } }, [
    el('button.btn.quiet.danger', {
      text: t('act.delete'),
      style: { color: 'var(--rose)' },
      onclick: async () => {
        if (await confirmAction({ title: t('act.delete'), message: t('gl.deleteWarn'), confirmLabel: t('act.delete'), danger: true })) {
          await deleteWord(word.id);
          h.close();
          toast(t('act.delete'));
        }
      },
    }),
  ]));

  const h = sheet({ title: '', body });
}

/* ═══ screen ═════════════════════════════════════════════════════════════ */

export function renderWords(root, ctx) {
  clear(root);
  const lang = ctx.lang();

  const search = el('input.input', { type: 'search', placeholder: t('gl.search'), style: { marginBottom: '12px' } });
  const filter = el('div.seg', { style: { marginBottom: '14px' } });
  const list = el('div.rows');
  const countNote = el('div.note');

  let mode = 'all';
  for (const [key, label] of [['all', 'gl.all'], ['new', 'gl.new'], ['learning', 'gl.learning'], ['known', 'gl.known']]) {
    filter.append(el('button', {
      text: t(label),
      'aria-pressed': String(key === 'all'),
      onclick: (e) => {
        mode = key;
        filter.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
        paint();
      },
    }));
  }

  root.append(
    el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px' } }, [
      el('h2.title', { text: t('gl.title'), style: { flex: '1', margin: '0' } }),
      el('button.btn.sm', { text: '＋ ' + t('act.add'), onclick: () => openAddWord(ctx, { onSaved: paint }) }),
    ]),
    search, filter, list, countNote,
  );

  // Songs sit under the word list rather than in the tab bar: they are a way
  // of filling the glossary, not a fifth place to go.
  const songs = songsSection(ctx, paint);
  root.append(songs);

  async function paint() {
    const words = (await allWords(lang)).sort((a, b) => b.createdAt - a.createdAt);
    const cards = await store.all('card');
    const q = search.value.trim().toLowerCase();

    const filtered = words.filter((w) => {
      if (q) {
        const hay = [w.term, w.asWritten, ...(w.translations?.pl || []), ...(w.translations?.en || [])]
          .join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (mode === 'all') return true;
      const mine = cards.filter((c) => c.wordId === w.id);
      const reps = mine.reduce((a, c) => a + (c.reps || 0), 0);
      const stable = mine.filter((c) => c.state === STATE.REVIEW && c.stability >= 21).length;
      if (mode === 'new') return reps === 0;
      if (mode === 'known') return stable >= 3;
      return reps > 0 && stable < 3;
    });

    clear(list);
    if (!filtered.length) {
      list.replaceWith(emptyState());
      countNote.textContent = '';
      return;
    }
    for (const w of filtered) {
      const gloss = (w.translations?.[uiLang()] || w.translations?.en || []).join(', ');
      list.append(el('button.wordrow', {
        onclick: () => openWord(ctx, w),
      }, [
        el('span.grow', {}, [
          el('span.term', { text: w.term, lang: LANGS[w.lang].bcp47 }),
          el('span.gloss', { text: gloss }),
        ]),
        el('span.meta', {}, [
          dotsNode(strengthDots(cards, w.id)),
          w.unchecked ? el('span.pill.warn', { text: '?' }) : null,
          w.source === 'song' ? el('span.pill', { text: '♪' }) : null,
        ]),
      ]));
    }
    countNote.textContent = t('gl.count', { n: filtered.length });
  }

  function emptyState() {
    const node = el('div.empty');
    node.append(
      el('p', { text: t('gl.empty') }),
      el('p.hint2', { text: t('gl.emptyHint') }),
      el('div', { style: { marginTop: '20px' } }, [
        el('button.btn.sm', { text: '＋ ' + t('gl.add'), onclick: () => openAddWord(ctx, { onSaved: () => renderWords(root, ctx) }) }),
      ]),
    );
    return node;
  }

  search.addEventListener('input', debounce(paint, 160));
  const off = store.onChange('word', paint);
  paint();
  return off;
}
