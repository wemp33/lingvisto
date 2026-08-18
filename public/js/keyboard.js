// Lingvisto's own keyboard.
//
// iOS gives a web page no way at all to choose which system keyboard appears —
// there is no attribute, no API, and no way even to read which one is active.
// So rather than nagging the learner to hit the globe key, the app brings its
// own QWERTZ / ЙЦУКЕН / Italian layouts.
//
// It drives a real <input> with inputmode="none": WebKit honours that and keeps
// the system keyboard down, while the field keeps a genuine caret, real
// selectionStart/End and the native selection handles. contenteditable with
// synthetic events would mean reimplementing all of that, on a platform with
// documented composition and selection bugs.

import { LANGS, transliterate } from './lang.js';
import { t } from './i18n.js';
import { el, clear, tap } from './ui.js';

const HOST = () => document.getElementById('kb');

let target = null;        // the focused input
let lang = 'de';
let shift = 0;            // 0 none, 1 one-shot, 2 locked
let plane = 'letters';    // letters | numbers | symbols
let translit = false;
let comp = null;          // { start, latin } while transliterating
let longPressTimer = null;
let popover = null;
let onHideCb = null;

const NUM_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['-', '/', ':', ';', '(', ')', '€', '&', '@', '"'],
  ['symbols', '.', ',', '?', '!', "'", 'backspace'],
];
const SYM_ROWS = [
  ['[', ']', '{', '}', '#', '%', '^', '*', '+', '='],
  ['_', '\\', '|', '~', '<', '>', '$', '£', '¥', '·'],
  ['numbers', '.', ',', '?', '!', "'", 'backspace'],
];

/* ---------- text insertion ---------- */

// setRangeText keeps the browser's own undo stack and selection behaviour,
// which hand-splicing .value does not.
function insert(str) {
  if (!target) return;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  target.setRangeText(str, start, end, 'end');
  target.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertText' }));
}

function replaceRange(start, end, str) {
  if (!target) return;
  target.setRangeText(str, start, end, 'end');
  target.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertText' }));
}

function backspace() {
  if (!target) return;
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? start;
  if (start !== end) {
    target.setRangeText('', start, end, 'end');
  } else if (start > 0) {
    // Step back over a whole grapheme. Russian words are stored with combining
    // acutes on the stressed vowel, so "мо́" is three code units and deleting
    // one of them would leave an orphaned mark. Spreading the string also
    // keeps surrogate pairs intact.
    const chars = [...target.value.slice(0, start)];
    const isMark = (c) => /^[̀-ͯ]$/.test(c);
    let cut = '';
    // Absorb any trailing combining marks...
    while (chars.length && isMark(chars[chars.length - 1])) cut = chars.pop() + cut;
    // ...then exactly one base character.
    if (chars.length) cut = chars.pop() + cut;
    if (cut) target.setRangeText('', start - cut.length, start, 'end');
  }
  target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
}

/* ---------- transliteration ---------- */
// Russian only. The learner types Latin, and the composed region is rewritten
// after every keystroke: "shch" has to beat "sh" has to beat "s", so the whole
// pending run is re-converted rather than mapped key by key.

function compKey(ch) {
  // The composed region is re-verified before every edit. If the field has
  // changed underneath us — the caret moved, the value was reset, the learner
  // came back to a different field — the old range no longer means anything,
  // and writing over it would scribble into the middle of their text.
  if (comp) {
    const here = target.value.slice(comp.start, comp.start + comp.out.length);
    if (here !== comp.out || (target.selectionStart ?? 0) !== comp.start + comp.out.length) comp = null;
  }
  if (!comp) comp = { start: target.selectionStart ?? 0, latin: '', out: '' };

  const prevOut = comp.out;
  comp.latin += ch;
  comp.out = transliterate(lang, comp.latin);
  replaceRange(comp.start, comp.start + prevOut.length, comp.out);
}

function compEnd() { comp = null; }

/* ---------- key handling ---------- */

function keyValue(k) {
  if (k.length !== 1) return k;
  return shift ? k.toUpperCase() : k;
}

function pressKey(raw) {
  tap(6);
  switch (raw) {
    case 'shift':
      shift = shift === 2 ? 0 : shift === 1 ? 2 : 1;
      render();
      return;
    case 'backspace':
      if (comp) {
        const prevOut = comp.out;
        comp.latin = comp.latin.slice(0, -1);
        comp.out = comp.latin ? transliterate(lang, comp.latin) : '';
        replaceRange(comp.start, comp.start + prevOut.length, comp.out);
        if (!comp.latin) compEnd();
        return;
      }
      backspace();
      return;
    case 'numbers': plane = 'numbers'; render(); return;
    case 'symbols': plane = 'symbols'; render(); return;
    case 'letters': plane = 'letters'; render(); return;
    case 'space':
      compEnd();
      insert(' ');
      if (shift === 1) { shift = 0; render(); }
      return;
    case 'return':
      compEnd();
      if (target?.tagName === 'TEXTAREA') insert('\n');
      else target?.form?.requestSubmit?.() ?? target?.dispatchEvent(new Event('kb-submit', { bubbles: true }));
      return;
    case 'hide':
      hide();
      return;
    default: break;
  }

  const ch = keyValue(raw);
  if (translit && plane === 'letters' && /^[a-z']$/i.test(ch)) compKey(ch);
  else { compEnd(); insert(ch); }

  if (shift === 1) { shift = 0; render(); }
}

/* ---------- long press for accents ---------- */

function openPopover(keyEl, options) {
  closePopover();
  popover = el('div.kpop');
  options.forEach((opt, i) => {
    popover.append(el('button', {
      text: shift ? opt.toUpperCase() : opt,
      'aria-selected': i === 0 ? 'true' : 'false',
      dataset: { v: opt },
    }));
  });
  keyEl.append(popover);
  keyEl.classList.add('down');
}

function closePopover() {
  popover?.parentElement?.classList.remove('down');
  popover?.remove();
  popover = null;
}

function popoverPick(clientX) {
  if (!popover) return null;
  let best = null;
  let bestDist = Infinity;
  for (const b of popover.children) {
    const r = b.getBoundingClientRect();
    const d = Math.abs(clientX - (r.left + r.width / 2));
    if (d < bestDist) { bestDist = d; best = b; }
  }
  for (const b of popover.children) b.setAttribute('aria-selected', b === best ? 'true' : 'false');
  return best;
}

/* ---------- rendering ---------- */

function layoutRows() {
  if (plane === 'numbers') return NUM_ROWS;
  if (plane === 'symbols') return SYM_ROWS;
  const cfg = LANGS[lang].keyboard;
  // In transliteration mode the learner types Latin, so show a Latin layout.
  if (translit) {
    return [
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
      ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'backspace'],
    ];
  }
  return cfg.rows;
}

function render() {
  const host = HOST();
  if (!host) return;
  clear(host);
  const cfg = LANGS[lang].keyboard;

  /* quick bar: the characters this language needs that a Latin keyboard hides */
  const bar = el('div.kbar');
  bar.append(el('span.khint', { text: LANGS[lang].endonym }));
  if (plane === 'letters') {
    for (const q of cfg.quick || []) {
      bar.append(el('button.kquick', {
        text: q === '́' ? '◌́' : q,
        title: q === '́' ? t('kb.stress') : q,
        dataset: { k: q },
      }));
    }
  }
  if (cfg.translit?.enabled) {
    bar.append(el('button.kquick', {
      text: 'ABC→' + LANGS[lang].endonym.slice(0, 3),
      'aria-pressed': String(translit),
      style: translit ? { background: 'var(--accent-wash)', borderColor: 'var(--accent)' } : {},
      dataset: { toggle: 'translit' },
    }));
  }
  bar.append(el('button.kdone', { text: t('act.done'), dataset: { k: 'hide' } }));
  host.append(bar);

  /* key rows */
  const rows = layoutRows();
  rows.forEach((row, ri) => {
    const r = el('div.krow');
    // Middle row on a 10-wide layout looks wrong flush; pad it in.
    const isMiddle = ri === 1 && rows[0].length > row.length && plane === 'letters';
    if (isMiddle) r.style.padding = '0 5%';
    for (const k of row) {
      let label = k;
      let cls = 'key';
      if (k === 'shift') { label = shift === 2 ? '⇪' : '⇧'; cls += ' wide'; }
      else if (k === 'backspace') { label = '⌫'; cls += ' wide'; }
      else if (k === 'numbers') { label = '123'; cls += ' wide'; }
      else if (k === 'symbols') { label = '#+='; cls += ' wide'; }
      else if (k === 'letters') { label = 'ABC'; cls += ' wide'; }
      else label = keyValue(k);

      const more = plane === 'letters' && !translit ? cfg.accents?.[k] : null;
      if (more) cls += ' has-more';
      if (shift === 2 && k === 'shift') cls += ' accent';

      r.append(el(`button.${cls.split(' ').join('.')}`, {
        text: label,
        dataset: { k, ...(more ? { more: more.join(' ') } : {}) },
        'aria-label': k,
      }));
    }
    host.append(r);
  });

  /* bottom row */
  const last = el('div.krow');
  last.append(el('button.key.wide', { text: plane === 'letters' ? '123' : 'ABC', dataset: { k: plane === 'letters' ? 'numbers' : 'letters' } }));
  last.append(el('button.key.space', { text: LANGS[lang].endonym, dataset: { k: 'space' }, style: { fontSize: '13px', color: 'var(--muted)' } }));
  last.append(el('button.key.wide', { text: '⏎', dataset: { k: 'return' } }));
  host.append(last);
}

/* ---------- pointer wiring ---------- */
// One delegated set of handlers on the host. pointerdown is prevented so the
// input never loses focus and the caret stays where the learner put it.

function wire() {
  const host = HOST();
  if (!host || host.dataset.wired) return;
  host.dataset.wired = '1';

  host.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('button');
    e.preventDefault();
    if (!btn) return;
    // Throws outright if the pointer is no longer active, which would abort
    // the rest of this handler and swallow the keypress. Capture is only a
    // convenience here, so losing it is fine.
    try { btn.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }

    if (btn.dataset.toggle === 'translit') { translit = !translit; comp = null; render(); return; }
    const k = btn.dataset.k;
    if (k == null) return;

    btn.classList.add('down');
    if (btn.dataset.more) {
      longPressTimer = setTimeout(() => {
        openPopover(btn, [k, ...btn.dataset.more.split(' ')]);
      }, 320);
    }
  });

  host.addEventListener('pointermove', (e) => {
    if (popover) popoverPick(e.clientX);
  });

  const end = (e) => {
    clearTimeout(longPressTimer);
    const btn = e.target.closest('button') || document.querySelector('#kb .key.down');
    if (popover) {
      const picked = popoverPick(e.clientX);
      const v = picked?.dataset.v;
      closePopover();
      btn?.classList.remove('down');
      if (v) { compEnd(); insert(shift ? v.toUpperCase() : v); if (shift === 1) { shift = 0; render(); } }
      return;
    }
    btn?.classList.remove('down');
    if (!btn) return;
    const k = btn.dataset.k;
    if (k != null) pressKey(k);
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', () => {
    clearTimeout(longPressTimer);
    closePopover();
    document.querySelectorAll('#kb .key.down').forEach((n) => n.classList.remove('down'));
  });

  // Repeat on a held backspace, the way a real keyboard does.
  let repeat = null;
  host.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('button');
    if (btn?.dataset.k !== 'backspace') return;
    repeat = setTimeout(function again() {
      pressKey('backspace');
      repeat = setTimeout(again, 70);
    }, 420);
  });
  const stopRepeat = () => { clearTimeout(repeat); repeat = null; };
  host.addEventListener('pointerup', stopRepeat);
  host.addEventListener('pointercancel', stopRepeat);
}

/* ---------- public ---------- */

export function show(input, langCode, { onHide = null } = {}) {
  target = input;
  lang = LANGS[langCode] ? langCode : 'de';
  translit = false;
  comp = null;
  shift = 0;
  plane = 'letters';
  onHideCb = onHide;

  // The two things WebKit really does forward to UIKit. autocorrect in
  // particular matters: with an English keyboard active iOS will happily
  // "fix" a German word into an English one and corrupt the glossary.
  input.setAttribute('inputmode', 'none');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('lang', LANGS[lang].bcp47);

  wire();
  render();
  const host = HOST();
  host.hidden = false;
  // Reading offsetHeight forces a synchronous layout, which gives the
  // transition a start value to animate from. requestAnimationFrame would do
  // the same only while the page is compositing — in a backgrounded tab the
  // callback is throttled and the keyboard would stay parked off-screen.
  const h = host.offsetHeight;
  host.classList.add('on');
  document.body.style.setProperty('--kb-h', `${h}px`);
  return h;
}

export function hide() {
  const host = HOST();
  if (!host) return;
  closePopover();
  host.classList.remove('on');
  setTimeout(() => { if (!host.classList.contains('on')) host.hidden = true; }, 260);
  document.body.style.setProperty('--kb-h', '0px');
  target = null;
  comp = null;
  const cb = onHideCb;
  onHideCb = null;
  cb?.();
}

export const isOpen = () => !!target;
export const height = () => (HOST()?.classList.contains('on') ? HOST().offsetHeight : 0);

// Wire an input so tapping it opens the Lingvisto keyboard. `getLang` is a
// function so a field can follow whichever language the screen is showing.
export function bind(input, getLang, opts = {}) {
  input.addEventListener('focus', () => show(input, typeof getLang === 'function' ? getLang() : getLang, opts));
  input.addEventListener('blur', (e) => {
    // Tapping a key blurs nothing (pointerdown is prevented), so a real blur
    // means the learner moved on.
    if (e.relatedTarget?.closest?.('#kb')) return;
    if (target === input) hide();
  });
  // A physical keyboard on an iPad should just work; let those events through
  // and keep our own keyboard out of the way.
  input.addEventListener('keydown', (e) => {
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter') {
      if (isOpen()) hide();
    }
  });
  return input;
}
