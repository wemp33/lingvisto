// Learning from a song.
//
// You give it a title and a band; it gives you back a vocabulary lesson.
//
// What it deliberately does NOT do is show you the lyrics. Partly because they
// are not ours to reproduce, but mostly because a lyric sheet is not a study
// artifact — you cannot review a line of a song, whereas you can review
// "sich sehnen nach + Dativ". So the song becomes a glossary, an example
// sentence set written from scratch, a few grammar points and some notes on
// what to listen for. Words go into the same glossary and the same spaced
// repetition as everything else, tagged with where they came from.

import * as store from './store.js';
import * as api from './api.js';
import { LANGS } from './lang.js';
import { allWords, saveWord, findDuplicate } from './glossary.js';
import { t, uiLang, formatDate } from './i18n.js';
import { el, clear, sheet, toast, toastError, confirmAction, tap } from './ui.js';

/* ---------- data ---------- */

export async function allSongs(lang = null) {
  const songs = await store.all('song');
  return lang ? songs.filter((s) => s.lang === lang) : songs;
}

async function saveSong(song) {
  const id = song.id || store.uid();
  const record = { ...song, id, updatedAt: Date.now(), createdAt: song.createdAt || Date.now() };
  await store.put('song', id, record);
  return record;
}

// Add the model's picks to the glossary, skipping anything already there.
// `lesson.vocabulary` entries are already dictionary-form and enriched, so they
// go straight in rather than through a second validation round trip.
async function addWords(lesson, lang, songId, picks) {
  const existing = await allWords(lang);
  let added = 0;
  for (const v of picks) {
    if (findDuplicate(existing, lang, v.lemma)) continue;
    await saveWord({
      lang,
      term: v.lemma,
      asWritten: v.lemma,
      pos: v.pos,
      translations: v.translations || {},
      ipa: v.ipa,
      grammar: v.grammar || {},
      example: v.example || null,
      notes: v.note,
      source: 'song',
      songId,
      songTitle: `${lesson.title || ''} — ${lesson.artist || ''}`.trim(),
      poetic: v.core === false,
    });
    existing.push({ lang, term: v.lemma });
    added += 1;
  }
  return added;
}

/* ---------- the ask ---------- */

export function openSongPrompt(ctx, { onDone = null } = {}) {
  const lang = ctx.lang();
  const L = LANGS[lang];
  const body = el('div');

  const titleInput = el('input.input', {
    type: 'text', placeholder: t('sg.song'),
    autocapitalize: 'words', autocorrect: 'off', spellcheck: 'false',
  });
  const artistInput = el('input.input', {
    type: 'text', placeholder: t('sg.artist'),
    autocapitalize: 'words', autocorrect: 'off', spellcheck: 'false',
  });
  const go = el('button.btn', { text: t('sg.analyse') });
  const status = el('div.hint', { style: { textAlign: 'center', marginTop: '12px' } });

  body.append(
    el('div.field', {}, [el('label', { text: t('sg.song') }), titleInput]),
    el('div.field', {}, [el('label', { text: t('sg.artist') }), artistInput]),
    go,
    status,
    el('div.note', {
      text: t('sg.noLyrics'),
      style: { textAlign: 'center', marginTop: '18px' },
    }),
  );

  // The system keyboard is right here: song titles and band names are proper
  // nouns in any script, not target-language study text.
  const h = sheet({ title: t('sg.title'), body });

  go.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const artist = artistInput.value.trim();
    if (!title || !artist) return;

    go.disabled = true;
    clear(go).append(el('span.spinner'), document.createTextNode(' ' + t('sg.analysing')));
    status.textContent = '';

    try {
      const lesson = await api.analyseSong({
        lang, title, artist, uiLang: uiLang(), level: ctx.level(),
      });

      if (!lesson.found || !(lesson.vocabulary || []).length) {
        go.disabled = false;
        clear(go).append(document.createTextNode(t('sg.analyse')));
        status.innerHTML = '';
        status.append(
          el('div', { text: t('sg.notFound'), style: { color: 'var(--rose)', fontWeight: '600' } }),
          el('div', { text: t('sg.notFoundHint'), style: { marginTop: '4px' } }),
        );
        return;
      }

      const saved = await saveSong({
        lang, title: lesson.title || title, artist: lesson.artist || artist, lesson,
      });
      h.close();
      openLesson(ctx, saved, { onDone });
    } catch (e) {
      go.disabled = false;
      clear(go).append(document.createTextNode(t('sg.analyse')));
      toastError(e);
    }
  });

  setTimeout(() => titleInput.focus(), 340);
}

/* ---------- the lesson ---------- */

export function openLesson(ctx, song, { onDone = null } = {}) {
  const lesson = song.lesson || {};
  const lang = song.lang;
  const L = LANGS[lang];
  const body = el('div');

  /* header */
  body.append(el('div', { style: { marginBottom: '6px' } }, [
    el('div.l2', { text: lesson.title || song.title, style: { fontSize: '24px', lineHeight: '1.2' } }),
    el('div.note', { text: lesson.artist || song.artist, style: { marginTop: '2px' } }),
  ]));

  const chips = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '10px 0 4px' } });
  if (lesson.year) chips.append(el('span.pill', { text: lesson.year }));
  if (lesson.genre) chips.append(el('span.pill', { text: lesson.genre }));
  if (lesson.difficulty) chips.append(el('span.pill', { text: `${t('sg.difficulty')} ${lesson.difficulty}/5` }));
  if (lesson.register) chips.append(el('span.pill', { text: lesson.register }));
  body.append(chips);

  // The model is told to say when it is unsure rather than bluff; when it does,
  // that has to reach the learner instead of being smoothed over.
  if (lesson.confidence === 'low') {
    body.append(el('div', {
      style: {
        margin: '12px 0', padding: '10px 12px', borderRadius: '11px',
        background: 'var(--amber-wash)', color: 'var(--amber)', fontSize: '13.5px',
      },
      text: `⚠ ${t('sg.lowConfidence')}`,
    }));
  }
  if (lesson.language && lesson.language !== lang) {
    body.append(el('div', {
      style: {
        margin: '12px 0', padding: '10px 12px', borderRadius: '11px',
        background: 'var(--rose-wash)', color: 'var(--rose)', fontSize: '13.5px',
      },
      text: `⚠ ${t('sg.wrongLang', { lang: L.name[uiLang()] })}`,
    }));
  }

  if (lesson.about) {
    body.append(el('div.sect', { text: t('sg.about') }));
    body.append(el('div.card', {}, [el('div.card-body', {}, [
      el('p', { text: lesson.about, style: { margin: '0', fontSize: '15px', lineHeight: '1.55' } }),
    ])]));
  }

  /* vocabulary, each row selectable */
  const vocab = lesson.vocabulary || [];
  const picked = new Set(vocab.map((_, i) => i));

  body.append(el('div.sect', { text: `${t('sg.vocab')} · ${vocab.length}` }));
  const rows = el('div.rows');

  vocab.forEach((v, i) => {
    const check = el('div.val', { text: '✓', style: { color: 'var(--accent)', fontSize: '18px' } });
    const row = el('button.wordrow', {
      onclick: () => {
        if (picked.has(i)) { picked.delete(i); check.style.opacity = '.16'; }
        else { picked.add(i); check.style.opacity = '1'; }
        tap();
        paintAddButton();
      },
    }, [
      el('span.grow', {}, [
        el('span.term', { text: v.lemma, lang: L.bcp47 }),
        el('span.gloss', { text: (v.translations?.[uiLang()] || v.translations?.en || []).join(', ') }),
        v.note ? el('span.gloss', { text: v.note, style: { color: 'var(--faint)' } }) : null,
      ]),
      el('span.meta', {}, [
        check,
        v.core === false ? el('span.pill.warn', { text: t('sg.poetic') }) : null,
      ]),
    ]);
    rows.append(row);
  });
  body.append(rows);

  const addBtn = el('button.btn', { style: { marginTop: '14px' } });
  const paintAddButton = () => {
    clear(addBtn).append(document.createTextNode(t('sg.addAll', { n: picked.size })));
    addBtn.disabled = picked.size === 0;
  };
  paintAddButton();

  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    const n = await addWords(lesson, lang, song.id, [...picked].map((i) => vocab[i]));
    toast(t('sg.added', { n }));
    tap(10);
    await saveSong({ ...song, addedAt: Date.now(), addedCount: n });
    onDone?.();
    // Each word brings four cards, all due immediately — the review badge has
    // to say so, or a song import looks like it did nothing.
    ctx.refreshDue?.();
    h.close();
  });
  body.append(addBtn);

  /* the rest */
  const listCard = (titleKey, items, render) => {
    if (!items?.length) return;
    body.append(el('div.sect', { text: t(titleKey) }));
    const card = el('div.rows');
    for (const it of items) card.append(render(it));
    body.append(card);
  };

  listCard('sg.expressions', lesson.expressions, (x) => el('div.row', {}, [
    el('div.grow', {}, [
      el('div.lab', { text: x.expression, lang: L.bcp47, style: { fontFamily: 'var(--serif)' } }),
      el('div.sub', { text: x.meaning }),
      x.literal ? el('div.sub', { text: `≈ ${x.literal}`, style: { color: 'var(--faint)' } }) : null,
    ]),
  ]));

  listCard('sg.grammar', lesson.grammarPoints, (x) => el('div.row', {}, [
    el('div.grow', {}, [
      el('div.lab', { text: x.point }),
      el('div.sub', { text: x.explain }),
    ]),
  ]));

  listCard('sg.listening', (lesson.listeningTips || []).map((x) => ({ x })), ({ x }) => el('div.row', {}, [
    el('div.grow', {}, [el('div.sub', { text: x, style: { fontSize: '14px', color: 'var(--ink)' } })]),
  ]));

  listCard('sg.culture', (lesson.culturalNotes || []).map((x) => ({ x })), ({ x }) => el('div.row', {}, [
    el('div.grow', {}, [el('div.sub', { text: x, style: { fontSize: '14px', color: 'var(--ink)' } })]),
  ]));

  body.append(el('div.note', {
    text: t('sg.noLyrics'),
    style: { textAlign: 'center', marginTop: '20px' },
  }));

  body.append(el('div', { style: { marginTop: '14px' } }, [
    el('button.btn.quiet', {
      text: t('act.delete'),
      style: { color: 'var(--rose)' },
      onclick: async () => {
        if (await confirmAction({ title: t('act.delete'), message: t('sg.deleteWarn'), confirmLabel: t('act.delete'), danger: true })) {
          await store.remove('song', song.id);
          h.close();
          onDone?.();
        }
      },
    }),
  ]));

  const h = sheet({ title: '', body });
}

/* ---------- the list, shown inside Words ---------- */

export function songsSection(ctx, onChanged) {
  const wrap = el('div');
  const list = el('div.rows');

  wrap.append(
    el('div.sect', { text: t('sg.mySongs') }),
    list,
  );

  async function paint() {
    const songs = (await allSongs(ctx.lang())).sort((a, b) => b.createdAt - a.createdAt);
    clear(list);
    list.append(el('button.row', {
      onclick: () => openSongPrompt(ctx, { onDone: () => { paint(); onChanged?.(); } }),
    }, [
      el('div.grow', {}, [
        el('div.lab', { text: '＋ ' + t('sg.title'), style: { color: 'var(--accent)' } }),
        el('div.sub', { text: t('sg.noLyrics') }),
      ]),
    ]));

    for (const s of songs) {
      const n = (s.lesson?.vocabulary || []).length;
      list.append(el('button.row', {
        onclick: () => openLesson(ctx, s, { onDone: () => { paint(); onChanged?.(); } }),
      }, [
        el('div.grow', {}, [
          el('div.lab', { text: s.title }),
          el('div.sub', { text: `${s.artist} · ${n} ${t('sg.vocab').toLowerCase()}` }),
        ]),
        el('div.chev', { html: '›' }),
      ]));
    }
  }

  paint();
  return wrap;
}
