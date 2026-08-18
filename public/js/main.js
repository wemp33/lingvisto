// Bootstrap, routing, account gate and settings.

import * as store from './store.js';
import * as api from './api.js';
import * as kb from './keyboard.js';
import { initI18n, t, uiLang, setUiLang, applyStatic, relativeTime, formatDate } from './i18n.js';
import { LANGS, LANG_CODES, UI_LANGS } from './lang.js';
import { el, clear, sheet, toast, toastError, confirmAction, tap, paintMark, isStandalone } from './ui.js';
import { renderTalk } from './talk.js';
import { renderWords, glossaryForTutor, saveWord, allWords, deleteWord, openAddWord } from './glossary.js';
import { renderWrite } from './write.js';
import { renderReview, dueCount, dueWordsForTutor } from './review.js';
import { workloadMultiplier } from './srs.js';

const DEFAULT_PREFS = {
  langs: ['de', 'ru', 'it'],
  active: 'de',
  level: 'B1',
  newPerDay: 5,
  maxReviews: 120,
  retention: 0.9,
  correctionStyle: 'gentle',
  handsFree: false,
};

let prefs = { ...DEFAULT_PREFS };
let currentTab = 'talk';
let teardown = null;

const $ = (id) => document.getElementById(id);

/* ═══ prefs ═════════════════════════════════════════════════════════════ */

async function loadPrefs() {
  const saved = await store.get('pref', 'settings');
  prefs = { ...DEFAULT_PREFS, ...(saved || {}) };
  if (!LANGS[prefs.active]) prefs.active = prefs.langs[0] || 'de';
}

async function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  await store.put('pref', 'settings', prefs);
  return prefs;
}

/* ═══ context handed to every screen ════════════════════════════════════ */

const ctx = {
  lang: () => prefs.active,
  prefs: () => prefs,
  level: () => prefs.level,
  correctionStyle: () => prefs.correctionStyle,
  handsFree: () => prefs.handsFree,

  glossaryForTutor,
  dueWordsForTutor,

  // Durable notes about the learner, gathered from past sessions so session
  // six knows what session one learnt. This is the fix for AI tutors that
  // start every conversation from nothing and go stale within a week.
  async facts(lang) {
    const convos = await store.all('convo');
    return convos
      .filter((c) => c.lang === lang)
      .flatMap((c) => c.facts || [])
      .slice(-40);
  },

  setTopAction(action) {
    const bar = document.querySelector('.topbar');
    bar.querySelector('.act')?.remove();
    if (action) {
      bar.insertBefore(
        el('button.act', { text: action.label, onclick: action.onClick }),
        $('btnSettings'),
      );
    }
  },

  // A word the tutor flagged mid-conversation. Saved straight away but marked
  // unchecked, so it shows up with a "?" until it has been through validation.
  async captureWord(detail, lang) {
    const words = await allWords(lang);
    const norm = (s) => String(s || '').toLowerCase().trim();
    if (words.some((w) => norm(w.term) === norm(detail.term))) return;
    await saveWord({
      lang,
      term: detail.term,
      asWritten: detail.term,
      translations: { [uiLang()]: detail.gloss ? [detail.gloss] : [] },
      example: detail.context ? { text: detail.context } : null,
      source: 'talk',
      unchecked: true,
    });
    toast(`＋ ${detail.term}`);
    refreshDue();
  },

  async finishSession({ lang, transcript, corrections, newWords }) {
    const id = store.uid();
    await store.put('convo', id, {
      id, lang, at: Date.now(), corrections, newWords, facts: [],
    });
    try {
      const report = await api.sessionReport({ lang, transcript, uiLang: uiLang() });
      await store.put('convo', id, {
        id, lang, at: Date.now(),
        corrections: report.corrections?.length ? report.corrections : corrections,
        newWords: report.newWords || newWords,
        facts: report.facts || [],
        summary: report.summary,
        level: report.level,
      });
      openReport(report, lang);
    } catch (e) {
      // The session still happened; a missing report is not worth an error.
      if (e.code !== 'offline' && e.code !== 'no_key') console.warn(e);
    }
  },

  // What the tutor can actually do to the glossary mid-conversation.
  //
  // Every one of these fires on a speech-recognition result, so every one is
  // either additive or shows an undo. The tutor is told to confirm out loud,
  // and the return value is what it confirms from — so if something failed it
  // says so instead of claiming a word was saved.
  tutorActions(lang, setStatus = () => {}) {
    const norm = (s) => String(s || '').toLowerCase().trim();

    const findWord = async (term) => {
      const words = await allWords(lang);
      const target = norm(term);
      return words.find((w) => norm(w.term) === target || norm(w.asWritten) === target)
        || words.find((w) => norm(w.term).startsWith(target) && target.length > 2)
        || null;
    };

    return {
      async add_word(args) {
        if (!args.term) return { ok: false, error: 'no_term' };
        const existing = await findWord(args.term);
        if (existing) return { ok: true, already: true, term: existing.term };

        const saved = await saveWord({
          lang,
          term: args.term,
          asWritten: args.term,
          translations: { [uiLang()]: args.gloss ? [args.gloss] : [] },
          example: args.context ? { text: args.context } : null,
          source: 'talk',
          unchecked: true,
        });
        refreshDue();
        undoToast(`＋ ${saved.term}`, async () => {
          await deleteWord(saved.id);
          refreshDue();
        });
        return { ok: true, term: saved.term, cards: 4 };
      },

      async remove_word(args) {
        const w = await findWord(args.term);
        if (!w) return { ok: false, error: 'not_in_glossary', term: args.term };
        // Keep a copy so undo can put it back with its history intact.
        const snapshot = { ...w };
        await deleteWord(w.id);
        refreshDue();
        undoToast(`− ${w.term}`, async () => {
          await saveWord(snapshot);
          refreshDue();
        });
        return { ok: true, term: w.term };
      },

      async mark_word(args) {
        const w = await findWord(args.term);
        if (!w) return { ok: false, error: 'not_in_glossary', term: args.term };
        const cards = (await store.all('card')).filter((c) => c.wordId === w.id);
        const now = Date.now();
        const DAY = 86_400_000;
        // "Known" pushes every card of that word out a month; "hard" brings
        // them all back to today. Neither touches stability — this is a
        // scheduling nudge from the learner, not evidence about their memory.
        const writes = cards.map((c) => ({
          kind: 'card',
          id: c.id,
          updatedAt: now,
          data: { ...c, due: args.status === 'known' ? now + 30 * DAY : now },
        }));
        await store.putMany(writes);
        refreshDue();
        return { ok: true, term: w.term, status: args.status, cards: writes.length };
      },

      async learn_song(args) {
        if (!args.title || !args.artist) return { ok: false, error: 'need_title_and_artist' };
        setStatus(t('sg.analysing'));
        try {
          const lesson = await api.analyseSong({
            lang, title: args.title, artist: args.artist, uiLang: uiLang(), level: prefs.level,
          });
          if (!lesson.found || !(lesson.vocabulary || []).length) {
            setStatus('');
            return { ok: false, error: 'song_not_known' };
          }

          const song = await store.put('song', store.uid(), {
            id: store.uid(), lang,
            title: lesson.title || args.title,
            artist: lesson.artist || args.artist,
            lesson, createdAt: Date.now(),
          });

          // Unless they asked for everything, add only the everyday words —
          // songs are full of archaic and poetic usage nobody should be drilled on.
          const picks = (lesson.vocabulary || []).filter((v) => args.addAll || v.core !== false);
          const existing = await allWords(lang);
          let added = 0;
          for (const v of picks) {
            if (existing.some((w) => norm(w.term) === norm(v.lemma))) continue;
            await saveWord({
              lang, term: v.lemma, asWritten: v.lemma, pos: v.pos,
              translations: v.translations || {}, ipa: v.ipa, grammar: v.grammar || {},
              example: v.example || null, notes: v.note,
              source: 'song', songId: song.data?.id, poetic: v.core === false,
              songTitle: `${lesson.title || args.title} — ${lesson.artist || args.artist}`,
            });
            existing.push({ term: v.lemma });
            added += 1;
          }
          setStatus('');
          refreshDue();
          toast(t('sg.added', { n: added }));
          return {
            ok: true, added, title: lesson.title, artist: lesson.artist,
            skipped: (lesson.vocabulary || []).length - picks.length,
          };
        } catch (e) {
          setStatus('');
          return { ok: false, error: String(e?.code || 'failed') };
        }
      },

      async get_due_words(args) {
        const due = await dueWordsForTutor(lang, Math.min(args?.limit || 15, 30));
        return { ok: true, words: due.map((w) => w.term) };
      },
    };
  },

  refreshDue: () => refreshDue(),
};

// A toast that can be taken back. Used for anything the tutor did on its own
// reading of speech, so a misheard word costs one tap rather than a silent
// corruption of the glossary.
function undoToast(message, undo) {
  const node = toast(message, { ms: 7000 });
  node.style.pointerEvents = 'auto';
  node.append(el('button', {
    text: '  ' + t('act.undo'),
    style: { color: '#8FD3AE', fontWeight: '700', marginLeft: '10px' },
    onclick: async () => {
      node.remove();
      await undo();
      toast(t('act.undo'));
    },
  }));
}

function openReport(report, lang) {
  const L = LANGS[lang];
  const body = el('div');
  body.append(el('p', { text: report.summary || '', style: { marginTop: '0', fontSize: '15.5px', lineHeight: '1.55' } }));

  if (report.corrections?.length) {
    body.append(el('div.sect', { text: t('talk.corrections') }));
    for (const c of report.corrections.slice(0, 12)) {
      body.append(el('div.fix', {}, [
        el('span.was', { text: c.said }),
        document.createTextNode('  →  '),
        el('span.now', { text: c.better, lang: L.bcp47 }),
        c.why ? el('span.why', { text: c.why }) : null,
      ]));
    }
  }

  if (report.newWords?.length) {
    body.append(el('div.sect', { text: t('talk.newWords') }));
    const rows = el('div.rows');
    for (const w of report.newWords.slice(0, 20)) {
      rows.append(el('div.row', {}, [
        el('div.grow', {}, [
          el('div.lab', { text: w.term, lang: L.bcp47, style: { fontFamily: 'var(--serif)' } }),
          el('div.sub', { text: w.gloss || '' }),
        ]),
        el('button.btn.sm.quiet', {
          text: '＋',
          onclick: async (e) => {
            await ctx.captureWord(w, lang);
            e.currentTarget.textContent = '✓';
            e.currentTarget.disabled = true;
          },
        }),
      ]));
    }
    body.append(rows);
  }

  sheet({ title: t('talk.report'), body });
}

/* ═══ tabs ══════════════════════════════════════════════════════════════ */

const SCREENS = {
  talk: { node: 'scTalk', render: renderTalk, title: 'talk.title' },
  words: { node: 'scWords', render: renderWords, title: 'gl.title' },
  write: { node: 'scWrite', render: renderWrite, title: 'wr.title' },
  review: { node: 'scReview', render: renderReview, title: 'rv.title' },
};

function show(tab) {
  if (!SCREENS[tab]) tab = 'talk';
  teardown?.();
  teardown = null;
  kb.hide();
  ctx.setTopAction(null);

  currentTab = tab;
  for (const [key, s] of Object.entries(SCREENS)) {
    $(s.node).classList.toggle('on', key === tab);
  }
  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });

  $('topTitle').textContent = t(SCREENS[tab].title);
  $('langChip').hidden = prefs.langs.length < 2;
  $('langChipText').textContent = LANGS[prefs.active].endonym.slice(0, 3).toUpperCase();

  teardown = SCREENS[tab].render($(SCREENS[tab].node), ctx) || null;
  history.replaceState(null, '', `#${tab}`);
}

async function refreshDue() {
  const n = await dueCount(prefs.active, prefs);
  const badge = $('dueBadge');
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
}

/* ═══ language switcher ═════════════════════════════════════════════════ */

function openLangSwitch() {
  const body = el('div.rows');
  for (const code of prefs.langs) {
    const L = LANGS[code];
    body.append(el('button.row', {
      onclick: async () => {
        await savePrefs({ active: code });
        h.close();
        show(currentTab);
        refreshDue();
        tap();
      },
    }, [
      el('div.grow', {}, [
        el('div.lab', { text: L.endonym }),
        el('div.sub', { text: L.name[uiLang()] }),
      ]),
      code === prefs.active ? el('div.val', { text: '✓', style: { color: 'var(--accent)' } }) : null,
    ]));
  }
  const h = sheet({ title: t('lang.switch'), body });
}

/* ═══ settings ══════════════════════════════════════════════════════════ */

function openSettings() {
  const body = el('div');

  /* account */
  body.append(el('div.sect', { text: t('set.account') }));
  const user = api.currentUser();
  const acct = el('div.rows');
  acct.append(el('div.row', {}, [
    el('div.grow', {}, [
      el('div.sub', { text: t('acct.signedInAs') }),
      el('div.lab', { text: user?.nickname || '—' }),
    ]),
  ]));
  const syncRow = el('div.row', {}, [
    el('div.grow', {}, [el('div.lab', { text: t('acct.syncNow') })]),
    el('div.val', { text: '…' }),
  ]);
  store.getMeta('lastSync', 0).then((ts) => {
    syncRow.querySelector('.val').textContent = ts ? relativeTime(Date.now() - ts) : t('acct.never');
  });
  syncRow.addEventListener('click', async () => {
    syncRow.querySelector('.val').textContent = '…';
    const r = await store.sync(api).catch(() => null);
    syncRow.querySelector('.val').textContent = r ? relativeTime(0) : t('err.offline');
    refreshDue();
  });
  acct.append(syncRow);
  acct.append(el('button.row', {
    onclick: () => openChangeCode(),
  }, [el('div.grow', {}, [el('div.lab', { text: t('acct.changeCode') })])]));
  acct.append(el('button.row.danger', {
    onclick: async () => {
      if (await confirmAction({ title: t('acct.signOut'), message: t('acct.signOutWarn'), confirmLabel: t('acct.signOut'), danger: true })) {
        await store.sync(api).catch(() => {});
        await api.logout();
        location.reload();
      }
    },
  }, [el('div.grow', {}, [el('div.lab', { text: t('acct.signOut') })])]));
  body.append(acct, el('div.note', { text: t('acct.offlineNote') }));

  /* AI keys */
  body.append(el('div.sect', { text: t('key.title') }));
  const keyRows = el('div.rows');
  body.append(keyRows, el('div.note', { text: t('key.hint') }));
  paintKeys(keyRows);

  /* languages */
  body.append(el('div.sect', { text: t('set.learning') }));
  const langs = el('div.rows');
  for (const code of LANG_CODES) {
    const L = LANGS[code];
    const on = prefs.langs.includes(code);
    langs.append(el('button.row', {
      onclick: async (e) => {
        const next = prefs.langs.includes(code)
          ? prefs.langs.filter((c) => c !== code)
          : [...prefs.langs, code];
        if (!next.length) return;
        await savePrefs({ langs: next, active: next.includes(prefs.active) ? prefs.active : next[0] });
        e.currentTarget.querySelector('.val').textContent = next.includes(code) ? '✓' : '';
        show(currentTab);
        refreshDue();
      },
    }, [
      el('div.grow', {}, [el('div.lab', { text: L.endonym }), el('div.sub', { text: L.accent[uiLang()] })]),
      el('div.val', { text: on ? '✓' : '', style: { color: 'var(--accent)' } }),
    ]));
  }
  body.append(langs);

  /* interface */
  body.append(el('div.sect', { text: t('set.interface') }));
  const ui = el('div.seg');
  for (const [code, meta] of Object.entries(UI_LANGS)) {
    ui.append(el('button', {
      text: meta.name,
      'aria-pressed': String(uiLang() === code),
      onclick: async () => { await setUiLang(code); h.close(); applyStatic(); show(currentTab); },
    }));
  }
  body.append(ui);

  /* study */
  body.append(el('div.sect', { text: t('set.study') }));
  const study = el('div.rows');

  const stepper = (label, sub, key, min, max, step) => {
    const val = el('div.val', { text: String(prefs[key]) });
    return el('div.row', {}, [
      el('div.grow', {}, [el('div.lab', { text: label }), sub ? el('div.sub', { text: sub }) : null]),
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
        el('button.btn.sm.quiet', {
          text: '−',
          onclick: async () => { await savePrefs({ [key]: Math.max(min, prefs[key] - step) }); val.textContent = String(prefs[key]); },
        }),
        val,
        el('button.btn.sm.quiet', {
          text: '+',
          onclick: async () => { await savePrefs({ [key]: Math.min(max, prefs[key] + step) }); val.textContent = String(prefs[key]); },
        }),
      ]),
    ]);
  };

  // Four cards per word means the new-words number is really four times bigger
  // in review load, which is why the ceiling here is low.
  study.append(stepper(t('set.newPerDay'), `× 4 = ${prefs.newPerDay * 4} cards`, 'newPerDay', 1, 20, 1));
  study.append(stepper(t('set.maxReviews'), null, 'maxReviews', 20, 400, 20));

  const retVal = el('div.val', { text: `${Math.round(prefs.retention * 100)}%` });
  const retHint = el('div.note');
  const paintRet = () => {
    retVal.textContent = `${Math.round(prefs.retention * 100)}%`;
    retHint.textContent = t('set.retentionHint', { x: workloadMultiplier(prefs.retention) });
  };
  study.append(el('div.row', {}, [
    el('div.grow', {}, [el('div.lab', { text: t('set.retention') })]),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
      el('button.btn.sm.quiet', {
        text: '−',
        onclick: async () => { await savePrefs({ retention: Math.max(0.8, Math.round((prefs.retention - 0.01) * 100) / 100) }); paintRet(); },
      }),
      retVal,
      el('button.btn.sm.quiet', {
        text: '+',
        // Hard-capped at 0.95: above that the daily load multiplies fast enough
        // to bury the learner, and the deck gets abandoned.
        onclick: async () => { await savePrefs({ retention: Math.min(0.95, Math.round((prefs.retention + 0.01) * 100) / 100) }); paintRet(); },
      }),
    ]),
  ]));
  paintRet();

  study.append(el('button.row', {
    onclick: async (e) => {
      const next = prefs.correctionStyle === 'gentle' ? 'strict' : 'gentle';
      await savePrefs({ correctionStyle: next });
      e.currentTarget.querySelector('.val').textContent = next;
    },
  }, [
    el('div.grow', {}, [el('div.lab', { text: t('talk.corrections') })]),
    el('div.val', { text: prefs.correctionStyle }),
  ]));

  study.append(el('button.row', {
    onclick: async (e) => {
      await savePrefs({ handsFree: !prefs.handsFree });
      e.currentTarget.querySelector('.val').textContent = prefs.handsFree ? t('talk.handsFree') : t('talk.pushToTalk');
    },
  }, [
    el('div.grow', {}, [
      el('div.lab', { text: t('talk.title') }),
      el('div.sub', { text: t('talk.holdHint') }),
    ]),
    el('div.val', { text: prefs.handsFree ? t('talk.handsFree') : t('talk.pushToTalk') }),
  ]));

  // Tuning the scheduler to this learner.
  const tuneVal = el('div.val', {
    text: prefs.fsrsParams ? t('tune.tuned') : t('tune.default'),
    style: prefs.fsrsParams ? { color: 'var(--accent)' } : {},
  });
  study.append(el('button.row', {
    onclick: async (e) => {
      const row = e.currentTarget;
      tuneVal.textContent = '…';
      try {
        const r = await api.optimiseSrs({ lang: prefs.active });
        if (!r.enough) {
          tuneVal.textContent = `${r.reviews}/${r.needed}`;
          toast(t('tune.notEnough', { n: r.needed - r.reviews }), { ms: 5000 });
          return;
        }
        if (!r.improved) {
          tuneVal.textContent = t('tune.alreadyGood');
          toast(t('tune.noGain'), { ms: 5000 });
          return;
        }
        await savePrefs({ fsrsParams: r.params, fsrsTunedAt: Date.now(), fsrsGain: r.gain });
        tuneVal.textContent = t('tune.tuned');
        tuneVal.style.color = 'var(--accent)';
        toast(t('tune.improved', { x: r.gain, n: r.reviews }), { ms: 6000 });
      } catch (err) {
        tuneVal.textContent = t('tune.default');
        toastError(err);
      }
    },
  }, [
    el('div.grow', {}, [
      el('div.lab', { text: t('tune.title') }),
      el('div.sub', { text: t('tune.sub') }),
    ]),
    tuneVal,
  ]));

  if (prefs.fsrsParams) {
    study.append(el('button.row', {
      onclick: async (e) => {
        await savePrefs({ fsrsParams: null, fsrsTunedAt: null, fsrsGain: null });
        e.currentTarget.remove();
        tuneVal.textContent = t('tune.default');
        tuneVal.style.color = '';
      },
    }, [el('div.grow', {}, [el('div.lab', { text: t('tune.reset'), style: { color: 'var(--muted)' } })])]));
  }

  body.append(study, retHint);

  /* data */
  body.append(el('div.sect', { text: t('set.data') }));
  const data = el('div.rows');
  data.append(el('button.row', {
    onclick: async () => {
      const payload = await store.exportAll();
      const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `lingvisto-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    },
  }, [el('div.grow', {}, [el('div.lab', { text: t('set.export') }), el('div.sub', { text: t('set.exportHint') })])]));

  data.append(el('button.row', {
    onclick: () => {
      const input = el('input', { type: 'file', accept: 'application/json', style: { display: 'none' } });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const n = await store.importAll(JSON.parse(await file.text()));
          toast(`${n}`);
          await store.sync(api).catch(() => {});
          show(currentTab);
          refreshDue();
        } catch { toast(t('err.generic'), { bad: true }); }
      });
      document.body.append(input);
      input.click();
      setTimeout(() => input.remove(), 60_000);
    },
  }, [el('div.grow', {}, [el('div.lab', { text: t('set.import') })])]));

  data.append(el('button.row', { onclick: openDiagnostics }, [
    el('div.grow', {}, [el('div.lab', { text: t('set.diagnostics') }), el('div.sub', { text: t('set.diagnosticsHint') })]),
  ]));

  data.append(el('button.row.danger', {
    onclick: async () => {
      if (await confirmAction({ title: t('set.reset'), message: t('set.resetWarn'), confirmLabel: t('act.delete'), danger: true })) {
        await store.clearLocal();
        location.reload();
      }
    },
  }, [el('div.grow', {}, [el('div.lab', { text: t('set.reset') })])]));
  body.append(data);

  body.append(el('div.note', {
    text: `Lingvisto · ${t('set.version')} 1.0.0${isStandalone() ? '' : ' · ' + t('install.hint')}`,
    style: { textAlign: 'center', marginTop: '22px' },
  }));

  const h = sheet({ title: t('set.title'), body });
}

/* ═══ AI keys ═══════════════════════════════════════════════════════════ */

const PROVIDERS = [
  { id: 'openai', label: 'key.openai', what: 'key.openaiWhat', where: 'key.getOpenai' },
  { id: 'anthropic', label: 'key.anthropic', what: 'key.anthropicWhat', where: 'key.getAnthropic' },
];

async function paintKeys(host) {
  clear(host);
  let status = {};
  try {
    status = await api.keyStatus();
  } catch {
    host.append(el('div.row', {}, [el('div.grow', {}, [el('div.sub', { text: t('err.offline') })])]));
    return;
  }

  for (const p of PROVIDERS) {
    const st = status[p.id] || {};
    const value = st.set
      ? `··· ${st.last4}`
      : st.fromServer ? t('key.fromServer') : t('key.none');
    host.append(el('button.row', {
      onclick: () => openKeyEntry(p, () => paintKeys(host)),
    }, [
      el('div.grow', {}, [
        el('div.lab', { text: t(p.label) }),
        el('div.sub', { text: t(p.what) }),
      ]),
      el('div.val', {
        text: value,
        style: st.set ? { color: 'var(--accent)' } : {},
      }),
    ]));
  }
}

// The learner types their own key here. It is sent once, verified against the
// provider before being stored, and never comes back — the row above can only
// ever show its last four characters.
function openKeyEntry(provider, onDone) {
  const body = el('div');
  const input = el('input.input', {
    type: 'password',
    placeholder: t('key.paste'),
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    autocomplete: 'off',
    style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '14px' },
  });
  const err = el('div.errline', { hidden: true });
  const save = el('button.btn', { text: t('act.save') });

  body.append(
    el('div.field', {}, [
      el('label', { text: t(provider.label) }),
      input,
      el('div.hint', { text: t(provider.where) }),
    ]),
    err,
    save,
    el('div.note', { text: t('key.hint') }),
  );

  const remove = el('button.btn.quiet', {
    text: t('key.remove'),
    style: { color: 'var(--rose)', marginTop: '10px' },
    onclick: async () => {
      await api.clearKey(provider.id).catch(() => {});
      h.close();
      onDone();
    },
  });
  body.append(remove);

  save.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) return;
    err.hidden = true;
    save.disabled = true;
    clear(save).append(el('span.spinner'), document.createTextNode(' ' + t('key.checking')));
    try {
      await api.setKey(provider.id, key);
      // Do not leave the key sitting in a DOM node once it has been accepted.
      input.value = '';
      h.close();
      toast(t('key.saved'));
      onDone();
    } catch (e) {
      save.disabled = false;
      clear(save).append(document.createTextNode(t('act.save')));
      err.hidden = false;
      const k = `err.${e.code}`;
      err.textContent = t(k) === k ? t('err.generic') : t(k);
    }
  });

  const h = sheet({ title: t(provider.label), body, onClose: () => { input.value = ''; } });
  setTimeout(() => input.focus(), 340);
}

// Mic capture, recording formats and speech support have all broken in iOS
// point releases within the last year, and Lockdown Mode removes the Web Speech
// API with no signal. Without this screen those turn into bug reports that
// cannot be reproduced.
function openDiagnostics() {
  const rows = el('div.rows');
  const line = (k, v) => rows.append(el('div.row', {}, [
    el('div.grow', {}, [el('div.lab', { text: k })]),
    el('div.val', { text: String(v) }),
  ]));

  line('Standalone PWA', isStandalone());
  line('User agent', navigator.userAgent.slice(0, 42) + '…');
  line('Pointer: coalesced', typeof PointerEvent !== 'undefined' && 'getCoalescedEvents' in PointerEvent.prototype);
  line('Pointer: predicted', typeof PointerEvent !== 'undefined' && 'getPredictedEvents' in PointerEvent.prototype);
  line('audioSession', !!navigator.audioSession);
  line('WebRTC', typeof RTCPeerConnection !== 'undefined');
  line('getUserMedia', !!navigator.mediaDevices?.getUserMedia);
  line('Wake lock', !!navigator.wakeLock);
  line('Speech voices', window.speechSynthesis?.getVoices?.().length ?? 0);
  line('Storage persisted', '…');
  navigator.storage?.persisted?.().then((p) => {
    rows.querySelectorAll('.row').forEach((r) => {
      if (r.querySelector('.lab')?.textContent === 'Storage persisted') r.querySelector('.val').textContent = String(p);
    });
  });
  if (window.MediaRecorder) {
    line('webm/opus', MediaRecorder.isTypeSupported('audio/webm;codecs=opus'));
    line('mp4', MediaRecorder.isTypeSupported('audio/mp4'));
  }
  api.health().then((h2) => {
    line('Server AI: OpenAI', h2.ai.openai);
    line('Server AI: Claude', h2.ai.anthropic);
  }).catch(() => line('Server', 'unreachable'));

  sheet({ title: t('set.diagnostics'), body: rows });
}

/* ═══ account gate ══════════════════════════════════════════════════════ */

// Six digits entered on a keypad the app draws itself, so the field never
// depends on which keyboard iOS happens to show.
function codeField(onComplete) {
  let value = '';
  const boxes = el('div.codebox');
  const paint = () => {
    clear(boxes);
    for (let i = 0; i < 6; i++) {
      boxes.append(el(`i${i < value.length ? '.filled' : ''}${i === value.length ? '.cursor' : ''}`, {
        text: i < value.length ? '•' : '',
      }));
    }
  };
  const pad = el('div.pad');
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del']) {
    pad.append(el(`button${k === 'clear' || k === 'del' ? '.fn' : ''}`, {
      text: k === 'clear' ? t('act.clear') : k === 'del' ? '⌫' : k,
      onclick: () => {
        tap();
        if (k === 'clear') value = '';
        else if (k === 'del') value = value.slice(0, -1);
        else if (value.length < 6) value += k;
        paint();
        if (value.length === 6) onComplete(value);
      },
    }));
  }
  paint();
  return { boxes, pad, get: () => value, reset: () => { value = ''; paint(); } };
}

function renderGate() {
  const gate = $('gate');
  clear(gate);
  gate.style.cssText = 'position:fixed;inset:0;background:var(--bg);z-index:80;overflow-y:auto;'
    + 'padding:calc(var(--safe-t) + 32px) 24px calc(var(--safe-b) + 32px);';

  let mode = 'create';   // create | signin
  let nickname = '';
  let firstCode = '';
  let step = 'nick';     // nick | code | confirm

  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mark.setAttribute('viewBox', '0 0 100 100');
  mark.style.cssText = 'width:56px;height:56px;display:block;margin:0 auto 18px';
  paintMark(mark, { id: 'gateMark' });

  const wrapEl = el('div', { style: { maxWidth: '380px', margin: '0 auto' } });
  const title = el('h1.title', { style: { textAlign: 'center', fontSize: '30px' } });
  const blurb = el('p.subtitle', { style: { textAlign: 'center' } });
  const holder = el('div');
  const err = el('div.errline', { style: { textAlign: 'center' }, hidden: true });
  const swap = el('button', {
    style: { display: 'block', margin: '26px auto 0', color: 'var(--accent)', fontSize: '15px', fontWeight: '600' },
  });

  wrapEl.append(mark, title, blurb, holder, err, swap);
  gate.append(wrapEl);

  const showErr = (msg) => { err.hidden = false; err.textContent = msg; };

  function paint() {
    clear(holder);
    err.hidden = true;
    title.textContent = mode === 'create' ? t('acct.welcome') : t('acct.signIn');
    blurb.textContent = mode === 'create' ? t('acct.blurb') : t('acct.codeHint');
    swap.textContent = mode === 'create' ? t('acct.haveAccount') : t('acct.newAccount');

    if (step === 'nick') {
      const input = el('input.input', {
        type: 'text', value: nickname, placeholder: t('acct.nickname'),
        autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
        style: { textAlign: 'center', fontSize: '20px' },
      });
      const go = el('button.btn', {
        text: t('act.continue'),
        style: { marginTop: '16px' },
        onclick: () => {
          nickname = input.value.trim();
          if (nickname.length < 2) return showErr(t('err.nickname_short'));
          step = 'code';
          paint();
        },
      });
      holder.append(el('div.field', {}, [el('label', { text: t('acct.nickname') }), input]), go);
      setTimeout(() => input.focus(), 120);
      return;
    }

    const label = el('div', {
      style: { textAlign: 'center', fontSize: '13px', fontWeight: '600', color: 'var(--muted)', marginBottom: '10px' },
      text: step === 'confirm' ? t('acct.codeAgain') : t('acct.code'),
    });
    const field = codeField(async (code) => {
      if (mode === 'create' && step === 'code') {
        firstCode = code;
        step = 'confirm';
        paint();
        return;
      }
      if (mode === 'create' && step === 'confirm') {
        if (code !== firstCode) {
          showErr(t('err.code_mismatch'));
          step = 'code';
          firstCode = '';
          setTimeout(paint, 700);
          return;
        }
      }
      await submit(code);
    });

    holder.append(label, field.boxes, field.pad);
    holder.append(el('div.hint', { text: t('acct.codeHint'), style: { textAlign: 'center', marginTop: '16px' } }));
    holder.append(el('button', {
      text: `← ${nickname}`,
      style: { display: 'block', margin: '14px auto 0', color: 'var(--muted)', fontSize: '14px' },
      onclick: () => { step = 'nick'; firstCode = ''; paint(); },
    }));

    async function submit(code) {
      holder.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        if (mode === 'create') await api.register(nickname, code);
        else await api.login(nickname, code);
        // A second device starts with an empty cursor and pulls the whole
        // account; a first device pushes whatever it already has.
        await store.resetCursor();
        await store.markAllDirty();
        gate.remove();
        await boot();
      } catch (e) {
        holder.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        field.reset();
        const key = `err.${e.code}`;
        let msg = t(key);
        if (msg === key) msg = t('err.generic');
        if (e.code === 'locked' && e.retryAfter) {
          msg = t('err.locked', { n: relativeTime(e.retryAfter * 1000) });
        }
        showErr(msg);
        if (e.code === 'nickname_taken') { step = 'nick'; setTimeout(paint, 900); }
      }
    }
  }

  swap.addEventListener('click', () => {
    mode = mode === 'create' ? 'signin' : 'create';
    step = 'nick';
    firstCode = '';
    paint();
  });

  paint();
}

function openChangeCode() {
  const body = el('div');
  let current = '';
  const label = el('div', { style: { textAlign: 'center', fontSize: '13px', color: 'var(--muted)', marginBottom: '8px' }, text: t('acct.currentCode') });
  const field = codeField(async (code) => {
    if (!current) {
      current = code;
      label.textContent = t('acct.newCode');
      field.reset();
      return;
    }
    try {
      await api.changeCode(current, code);
      h.close();
      toast(t('act.done'));
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      field.reset();
      current = '';
      label.textContent = t('acct.currentCode');
      toastError(e);
    }
  });
  body.append(label, field.boxes, field.pad);
  const h = sheet({ title: t('acct.changeCode'), body });
}

/* ═══ boot ══════════════════════════════════════════════════════════════ */

async function boot() {
  await loadPrefs();
  $('app').hidden = false;
  paintMark($('topMark'));
  applyStatic();

  $('btnSettings').addEventListener('click', openSettings);
  $('langChip').addEventListener('click', openLangSwitch);
  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.addEventListener('click', () => { tap(); show(b.dataset.tab); });
  });

  show((location.hash || '#talk').slice(1));
  refreshDue();

  // Sync on load, whenever the app comes back to the foreground, and every few
  // minutes while it is open.
  store.sync(api).then(() => { show(currentTab); refreshDue(); }).catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') store.sync(api).then(refreshDue).catch(() => {});
  });
  setInterval(() => store.sync(api).catch(() => {}), 5 * 60_000);

  const paintOnline = () => { $('offline').hidden = navigator.onLine; };
  window.addEventListener('online', () => { paintOnline(); store.sync(api).catch(() => {}); });
  window.addEventListener('offline', paintOnline);
  paintOnline();
}

async function start() {
  await initI18n();
  api.setUnauthorizedHandler(() => {
    $('app').hidden = true;
    renderGate();
  });

  if (!api.hasSession()) renderGate();
  else await boot();

  // Not on localhost: the worker serves assets cache-first and refreshes behind
  // the page, so during development it hands you the previous build while
  // quietly caching the new one — every edit appears to take two reloads.
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if ('serviceWorker' in navigator && !isLocal) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  } else if (isLocal && 'serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => {});
  }
}

// Exported so the action table can be exercised directly; main.js is the entry
// point, so nothing else imports this.
export { ctx };

start().catch((e) => {
  console.error(e);
  document.body.innerHTML = '<p style="padding:32px;font-family:Georgia,serif">Lingvisto failed to start.</p>';
});
