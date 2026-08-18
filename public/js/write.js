// The whiteboard, and the tutor that reads it.
//
// Grading is split in two on purpose. A handwriting recogniser is far better at
// reading ink than a vision model is, so it goes first and its answer is handed
// to the model as evidence. The model's job is then explanation — why the
// letter is wrong and how to fix it — which is what it is genuinely good at.
// A tutor that misreads the word before critiquing it is worse than no tutor.

import * as store from './store.js';
import * as api from './api.js';
import { InkSurface, INKS, TOOLS, makeScribbleWatcher } from './ink.js';
import { LANGS } from './lang.js';
import { allWords, glossaryForTutor } from './glossary.js';
import { dueWordsForTutor } from './review.js';
import { t, uiLang } from './i18n.js';
import { el, clear, sheet, toast, toastError, confirmAction, tap, debounce, isIPhone } from './ui.js';

const CRITIQUE_DELAY = 900;   // pen-up quiet before the tutor speaks up

export function renderWrite(root, ctx) {
  clear(root);
  const lang = ctx.lang();
  const L = LANGS[lang];

  const wrap = el('div.wb');

  /* ── toolbar ─────────────────────────────────────────────────────────── */
  const tools = el('div.tools');
  const canvasWrap = el('div.canvaswrap');

  const guides = el('canvas#wbGuides');
  const ghost = el('canvas#wbGhost');
  const dry = el('canvas#wbDry');
  const wet = el('canvas#wbWet');
  const promptBar = el('div.prompt');
  canvasWrap.append(guides, ghost, dry, wet, promptBar);

  wrap.append(tools, canvasWrap);
  root.append(wrap);

  let tutorOn = true;
  let target = null;          // the word the learner was asked to write
  let critiqueCard = null;
  let pageId = store.uid();

  // Coach mode: the tutor sets a task, reads what was written, and sets the
  // next one. Kept as a session, so each task is chosen in light of the last.
  let coach = null;           // { task, topic, recent[], struggles[] }
  let speaking = false;

  const surface = new InkSurface(
    { wrap: canvasWrap, dry, wet, guides, ghost },
    {
      guideStyle: 'fourline',
      penOnly: false,
      onStrokeEnd: (stroke) => { watchScribble(stroke); scheduleCritique(); },
      onChange: () => savePage(),
    },
  );

  const watchScribble = makeScribbleWatcher(() => {
    toast(t('wr.scribbleWarn'), { bad: true, ms: 6000 });
  });

  /* ── tools ───────────────────────────────────────────────────────────── */

  const toolBtn = (label, key, icon) => el('button.tool', {
    'aria-pressed': String(surface.tool === key && !surface.erasing),
    dataset: { tool: key },
    onclick: () => {
      surface.tool = key;
      surface.erasing = false;
      tap();
      refreshTools();
    },
  }, [icon ? el('span', { html: icon }).firstChild : null, label]);

  const penB = toolBtn(t('wr.pen'), 'pen');
  const fineB = toolBtn('·', 'fine');
  const markB = toolBtn('▬', 'marker');
  const eraseB = el('button.tool', {
    text: '⌫ ' + t('wr.eraser'),
    onclick: () => { surface.erasing = !surface.erasing; tap(); refreshTools(); },
  });

  const swatches = INKS.map((c) => el('button.swatch', {
    style: { background: c },
    'aria-pressed': String(surface.colour === c),
    onclick: () => { surface.colour = c; surface.erasing = false; refreshTools(); },
  }));

  const undoB = el('button.tool', { text: '↶', onclick: () => { surface.undo(); tap(); } });
  const clearB = el('button.tool', {
    text: '✕',
    onclick: async () => {
      if (surface.isEmpty()) return;
      if (await confirmAction({ title: t('act.clear'), message: t('wr.clearWarn'), confirmLabel: t('act.clear'), danger: true })) {
        surface.clearInk();
        hideCritique();
      }
    },
  });

  const guideB = el('button.tool', {
    text: '≡',
    title: t('wr.guides'),
    onclick: () => {
      const order = ['fourline', 'ruled', 'none'];
      const next = order[(order.indexOf(surface.guideStyle) + 1) % order.length];
      surface.setGuides(next);
      toast(t(next === 'none' ? 'wr.guideNone' : next === 'ruled' ? 'wr.guideRuled' : 'wr.guideFourLine'));
    },
  });

  const pencilB = el('button.tool', {
    text: '✎',
    title: t('wr.pencilOnly'),
    'aria-pressed': 'false',
    onclick: (e) => {
      surface.penOnly = !surface.penOnly;
      e.currentTarget.setAttribute('aria-pressed', String(surface.penOnly));
      toast(surface.penOnly ? t('wr.pencilOnly') : t('wr.pencilOnlyHint'));
    },
  });

  const tutorB = el('button.tool', {
    text: '👁',
    'aria-pressed': 'true',
    title: t('wr.tutorOn'),
    onclick: (e) => {
      tutorOn = !tutorOn;
      e.currentTarget.setAttribute('aria-pressed', String(tutorOn));
      toast(t(tutorOn ? 'wr.tutorOn' : 'wr.tutorOff'));
      if (!tutorOn) hideCritique();
    },
  });

  const practiceB = el('button.tool', {
    text: '✎ ' + t('wr.practiceWord'),
    onclick: pickPracticeWord,
  });

  const coachB = el('button.tool', {
    text: '◎ ' + t('wc.start'),
    'aria-pressed': 'false',
    onclick: () => (coach ? stopCoach() : startCoach()),
  });

  const topicB = el('button.tool', {
    text: '# ' + t('wc.topic'),
    onclick: setTopic,
  });

  const speakB = el('button.tool', {
    text: '🔊',
    'aria-pressed': 'true',
    title: t('wc.readAloud'),
    onclick: (e) => {
      speaking = !speaking;
      e.currentTarget.setAttribute('aria-pressed', String(speaking));
    },
  });

  tools.append(penB, fineB, markB, eraseB, ...swatches, undoB, clearB, guideB, pencilB, tutorB, coachB, topicB, speakB, practiceB);

  function refreshTools() {
    for (const b of [penB, fineB, markB]) {
      b.setAttribute('aria-pressed', String(!surface.erasing && surface.tool === b.dataset.tool));
    }
    eraseB.setAttribute('aria-pressed', String(surface.erasing));
    swatches.forEach((s, i) => s.setAttribute('aria-pressed', String(INKS[i] === surface.colour)));
  }

  /* ── the coach ───────────────────────────────────────────────────────── */
  //
  // A loop: it sets one thing to write, you write it, it reads the ink and
  // sets the next one based on what actually happened. The task and the
  // critique come back from a single call, so the next instruction arrives
  // with the feedback rather than a round trip later.

  async function startCoach() {
    coach = { task: null, topic: '', recent: [], struggles: [] };
    coachB.setAttribute('aria-pressed', 'true');
    coachB.textContent = '◎ ' + t('wc.stop');
    surface.clearInk();
    hideCritique();
    await nextTask();
  }

  function stopCoach() {
    coach = null;
    coachB.setAttribute('aria-pressed', 'false');
    coachB.textContent = '◎ ' + t('wc.start');
    setTarget(null);
    hideCritique();
  }

  function setTopic() {
    // A sheet rather than prompt(): an installed PWA on iOS renders the native
    // dialog badly and can suppress it outright.
    const input = el('input.input', {
      type: 'text',
      value: coach?.topic || '',
      placeholder: t('wc.topicPlaceholder'),
      autocapitalize: 'sentences',
    });
    const apply = async (topic) => {
      h.close();
      if (!coach) await startCoach();
      coach.topic = topic;
      // A new topic invalidates the tasks queued for the old one.
      coach.recent = [];
      coach.struggles = [];
      surface.clearInk();
      await nextTask();
    };
    const body = el('div', {}, [
      el('div.field', {}, [el('label', { text: t('wc.topic') }), input]),
      el('div.hint', { text: t('wc.topicPrompt') }),
      el('div.btnrow', {}, [
        el('button.btn.quiet', { text: t('wc.anything'), onclick: () => apply('') }),
        el('button.btn', { text: t('act.continue'), onclick: () => apply(input.value.trim()) }),
      ]),
    ]);
    const h = sheet({ title: t('wc.topic'), body });
    setTimeout(() => input.focus(), 340);
  }

  async function nextTask() {
    if (!coach) return;
    showTask({ pending: true });
    try {
      const [glossary, due] = await Promise.all([
        glossaryForTutor(lang, 60),
        dueWordsForTutor(lang, 20),
      ]);
      const task = await api.writingTask({
        lang,
        uiLang: uiLang(),
        level: ctx.level(),
        topic: coach.topic,
        glossary: glossary.map((g) => g.term),
        dueWords: due.map((d) => d.term),
        recent: coach.recent,
        struggles: coach.struggles,
      });
      applyTask(task);
    } catch (e) {
      showTask({ error: true });
      if (e.code !== 'offline') toastError(e);
    }
  }

  function applyTask(task) {
    if (!coach || !task?.task) return;
    coach.task = task;
    coach.recent.push(task.task);
    surface.clearInk();
    hideCritique();
    showTask({ task });
    if (speaking) speakTask(task);
  }

  // The instruction is in the learner's own language, so it goes through the
  // browser's built-in voice rather than the paid one. That voice is not good
  // enough to model a foreign accent — which is why it is never used for the
  // target language — but for hearing "write: I am going to the station" in
  // your own tongue it is perfectly adequate, free, offline, and instant.
  function speakTask(task) {
    const synth = window.speechSynthesis;
    if (!synth) return;
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(task.spoken || task.task);
      u.lang = uiLang() === 'pl' ? 'pl-PL' : 'en-GB';
      u.rate = 0.95;
      synth.speak(u);
    } catch { /* the task is on screen regardless */ }
  }

  function showTask({ task = null, pending = false, error = false }) {
    clear(promptBar);
    promptBar.style.pointerEvents = 'auto';
    if (pending) {
      promptBar.append(el('span.spinner.dark'), el('span', { text: ' ' + t('wc.thinking') }));
      return;
    }
    if (error) {
      promptBar.append(el('span', { text: t('err.generic') }));
      return;
    }
    if (!task) return;
    promptBar.append(
      el('span', {
        text: task.task,
        style: { color: 'var(--ink)', fontFamily: 'var(--ui)', fontSize: '14.5px', fontWeight: '600', textAlign: 'center' },
      }),
      task.hint
        ? el('button', {
          text: '?',
          style: { color: 'var(--faint)', padding: '0 8px', fontSize: '15px' },
          onclick: () => toast(task.hint, { ms: 6000 }),
        })
        : null,
      el('button', {
        text: '⤼',
        title: t('wc.skip'),
        style: { color: 'var(--faint)', padding: '0 6px' },
        onclick: () => nextTask(),
      }),
    );
  }

  /* ── prompted practice ───────────────────────────────────────────────── */

  async function pickPracticeWord() {
    const words = await allWords(lang);
    if (!words.length) { toast(t('gl.empty')); return; }
    const pick = words[Math.floor(Math.random() * words.length)];
    setTarget(pick.term);
  }

  function setTarget(word) {
    target = word || null;
    clear(promptBar);
    if (target) {
      promptBar.append(
        el('span', { text: t('wr.prompt') + ':' }),
        el('span.l2', { text: target, lang: L.bcp47, style: { color: 'var(--accent-deep)', fontSize: '19px' } }),
        el('button', {
          text: '✕',
          style: { pointerEvents: 'auto', color: 'var(--faint)', padding: '0 6px' },
          onclick: () => setTarget(null),
        }),
      );
      surface.clearInk();
      hideCritique();
    }
  }

  /* ── the tutor ───────────────────────────────────────────────────────── */

  function hideCritique() { critiqueCard?.remove(); critiqueCard = null; }

  function showCritique({ verdict, comment, reading, issues, spelling, pending }) {
    hideCritique();
    critiqueCard = el('div.tutorcard');
    const colours = { correct: 'var(--accent)', close: 'var(--amber)', wrong: 'var(--rose)', unreadable: 'var(--muted)' };
    const head = el('div.head');
    head.append(el('span.who', { text: 'G' }));
    if (pending) {
      head.append(el('span.spinner.dark'), el('span', { text: ' ' + t('wr.reading'), style: { fontSize: '13px', color: 'var(--muted)' } }));
    } else {
      head.append(el('span.verdict', {
        text: verdict === 'correct' ? '✓' : verdict === 'close' ? '≈' : verdict === 'wrong' ? '✕' : '?',
        style: { color: colours[verdict] || 'var(--muted)' },
      }));
      if (reading) {
        head.append(el('span', {
          text: `${t('wr.iRead')}: `,
          style: { fontSize: '12px', color: 'var(--faint)' },
        }), el('span.l2', { text: reading, lang: L.bcp47, style: { fontSize: '16px' } }));
      }
    }
    critiqueCard.append(head);

    if (!pending) {
      critiqueCard.append(el('div.body2', { text: comment || '' }));
      if (spelling) {
        critiqueCard.append(el('div.read', { text: spelling, lang: L.bcp47, style: { color: 'var(--accent-deep)' } }));
      }
      for (const issue of (issues || []).slice(0, 3)) {
        critiqueCard.append(el('div', {
          style: { marginTop: '6px', fontSize: '13.5px', color: 'var(--muted)' },
        }, [
          el('b', { text: issue.letter + ' ', lang: L.bcp47, style: { fontFamily: 'var(--serif)', fontSize: '16px', color: 'var(--ink)' } }),
          issue.problem + (issue.fix ? ` — ${issue.fix}` : ''),
        ]));
      }
    }
    canvasWrap.append(critiqueCard);
  }

  const scheduleCritique = debounce(async () => {
    if (!tutorOn || surface.isEmpty()) return;
    showCritique({ pending: true });

    try {
      const png = await surface.toCritiquePNG();
      if (!png) { hideCritique(); return; }

      // Recogniser first; it is allowed to fail silently, because the critique
      // is still useful without it.
      let candidates = [];
      try {
        const r = await api.recogniseInk({
          lang, ink: surface.toRecognitionInk(),
          width: Math.round(surface.w), height: Math.round(surface.h),
        });
        candidates = r.candidates || [];
      } catch { /* optional */ }

      const b64 = await blobToBase64(png);
      const glossary = coach ? (await glossaryForTutor(lang, 50)).map((g) => g.term) : [];
      const out = await api.critiqueHandwriting({
        lang, image: b64, target, uiLang: uiLang(),
        mode: coach?.task ? 'coach' : target ? 'prompt' : 'free',
        recognised: candidates,
        task: coach?.task || null,
        level: ctx.level(),
        glossary,
        recent: coach?.recent || [],
      });
      showCritique(out);
      ctx.noteHandwriting?.({ lang, target, result: out });

      // Coach mode: remember what went wrong so the next task can lean on it,
      // then hand over the instruction that came back with the feedback.
      if (coach) {
        for (const issue of (out.issues || []).slice(0, 2)) {
          coach.struggles.push(`${issue.letter}: ${issue.problem}`);
        }
        if (out.verdict === 'wrong' || out.matchedTask === false) {
          coach.struggles.push(`missed the task: ${coach.task?.task || ''}`);
        }
        coach.struggles = coach.struggles.slice(-8);

        if (out.nextTask?.task) {
          // Leave the feedback on screen long enough to read before the board
          // clears for the next one.
          setTimeout(() => { if (coach) applyTask(out.nextTask); }, 3200);
        } else {
          setTimeout(() => { if (coach) nextTask(); }, 3200);
        }
      }
    } catch (e) {
      hideCritique();
      if (e.code !== 'offline') toastError(e);
    }
  }, CRITIQUE_DELAY);

  /* ── persistence ─────────────────────────────────────────────────────── */

  const savePage = debounce(async () => {
    if (surface.isEmpty()) return;
    await store.put('page', pageId, {
      id: pageId, lang, target,
      ink: surface.toJSON(),
      updatedAt: Date.now(),
      createdAt: Date.now(),
    });
  }, 1500);

  /* ── phone caveat ────────────────────────────────────────────────────── */
  // Apple Pencil does not work on any iPhone, so the phone gets a finger-drawing
  // surface and is told why rather than being left to wonder.
  if (isIPhone()) {
    const note = el('div', {
      style: {
        position: 'absolute', left: '12px', right: '12px', top: '12px', zIndex: '4',
        background: 'var(--amber-wash)', color: 'var(--amber)', fontSize: '12.5px',
        padding: '9px 12px', borderRadius: '11px', lineHeight: '1.45', pointerEvents: 'auto',
      },
      text: t('wr.phoneNote'),
    });
    note.addEventListener('click', () => note.remove());
    canvasWrap.append(note);
    surface.setGuides('ruled');
  }

  refreshTools();
  ctx.setTopAction(null);

  return () => { surface.destroy(); scheduleCritique.cancel(); savePage.flush(); };
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
