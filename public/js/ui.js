// Small DOM and chrome helpers shared by every screen.
import { t } from './i18n.js';

/* ---------- element building ---------- */

// el('div.card', {onclick}, [children]) — terse enough to build a screen inline
// without a template language.
export function el(spec, props = null, children = null) {
  const [tagAndId, ...classes] = String(spec).split('.');
  const [tag, id] = tagAndId.split('#');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k in node && k !== 'list' && typeof v !== 'boolean') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  if (children != null) {
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }
  return node;
}

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

export const svg = (viewBox, inner, cls = '') =>
  el('span', { class: cls, html: `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>` }).firstChild;

/* ---------- haptics ---------- */
// iOS Safari ignores navigator.vibrate entirely; this is a no-op there and a
// real tap on anything else. Kept because it costs nothing and helps on iPad
// running in a browser that does support it.
export const tap = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };

/* ---------- toast ---------- */

let toastTimer = null;

export function toast(message, { bad = false, ms = 2600 } = {}) {
  const host = document.getElementById('toasts');
  const node = el('div.toast' + (bad ? '.bad' : ''), { text: message });
  host.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.style.transition = 'opacity .2s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
  return node;
}

// Error codes come back from the server as machine strings; render whichever
// has a translation and fall back to something honest rather than blank.
export function toastError(e) {
  const code = e?.code || e?.message || 'generic';
  const key = `err.${code}`;
  let msg = t(key);
  if (msg === key) msg = t('err.generic');
  if (code === 'locked' && e.retryAfter) {
    const m = Math.ceil(e.retryAfter / 60);
    msg = t('err.locked', { n: m > 1 ? t('time.min', { n: m }) : t('time.min', { n: 1 }) });
  }
  return toast(msg, { bad: true });
}

/* ---------- sheet ---------- */

const sheetStack = [];

export function sheet({ title, body, actions = null, onClose = null, dismissible = true }) {
  const scrim = el('div.scrim');
  const panel = el('div.sheet', { role: 'dialog', 'aria-modal': 'true' });
  const bodyWrap = el('div.body');

  const close = (result) => {
    const i = sheetStack.indexOf(handle);
    if (i >= 0) sheetStack.splice(i, 1);
    panel.classList.remove('on');
    scrim.classList.remove('on');
    setTimeout(() => { panel.remove(); scrim.remove(); }, 300);
    onClose?.(result);
  };

  panel.append(el('div.grip'));
  panel.append(el('header', {}, [
    el('h2', { text: title || '' }),
    actions || (dismissible
      ? el('button.act', { text: t('act.done'), onclick: () => close(null) })
      : null),
  ]));
  bodyWrap.append(body);
  panel.append(bodyWrap);

  if (dismissible) scrim.addEventListener('click', () => close(null));

  // Drag the grip down to dismiss — the gesture people expect from a sheet.
  let dragY = null;
  panel.addEventListener('pointerdown', (e) => {
    if (!dismissible) return;
    if (!e.target.closest('.grip') && !e.target.closest('header')) return;
    dragY = e.clientY;
    panel.style.transition = 'none';
  });
  panel.addEventListener('pointermove', (e) => {
    if (dragY == null) return;
    const dy = Math.max(0, e.clientY - dragY);
    panel.style.transform = `translateY(${dy}px)`;
  });
  const endDrag = (e) => {
    if (dragY == null) return;
    const dy = Math.max(0, (e.clientY ?? dragY) - dragY);
    dragY = null;
    panel.style.transition = '';
    panel.style.transform = '';
    if (dy > 110) close(null);
  };
  panel.addEventListener('pointerup', endDrag);
  panel.addEventListener('pointercancel', endDrag);

  document.body.append(scrim, panel);
  // Forced reflow rather than requestAnimationFrame: rAF is throttled when the
  // page is not compositing, which would leave the sheet parked off-screen.
  void panel.offsetHeight;
  scrim.classList.add('on');
  panel.classList.add('on');

  const handle = { close, panel, body: bodyWrap };
  sheetStack.push(handle);
  return handle;
}

export const topSheet = () => sheetStack[sheetStack.length - 1] || null;

/* ---------- confirm ---------- */

export function confirmAction({ title, message, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const body = el('div', {}, [
      message ? el('p.note', { text: message, style: { marginTop: '0', fontSize: '15px' } }) : null,
      el('div.btnrow', {}, [
        el('button.btn.quiet', {
          text: t('act.cancel'),
          onclick: () => { done(false); h.close(); },
        }),
        el('button.btn' + (danger ? '.danger' : ''), {
          text: confirmLabel || t('act.continue'),
          onclick: () => { done(true); h.close(); },
        }),
      ]),
    ]);
    const h = sheet({ title, body, actions: el('span'), onClose: () => done(false) });
  });
}

/* ---------- the mark ---------- */
// Same geometry as tools/gen-icons.mjs, inlined so the header never waits on a
// network fetch and the gradient can pick up the page's own tokens.
export function paintMark(svgEl, { id = 'gm' } = {}) {
  svgEl.innerHTML = `
    <defs><linearGradient id="${id}" x1="0" y1="8" x2="0" y2="92" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#4F8F6E"/><stop offset=".52" stop-color="#2E7550"/><stop offset="1" stop-color="#0E3A23"/>
    </linearGradient></defs>
    <path fill="url(#${id})" d="${MARK_BOWL}"/>
    <path fill="url(#${id})" d="${MARK_BAR}"/>`;
}

// Precomputed from the generator's constants (R=42, centre 50, y down).
const MARK_BOWL = (() => {
  const R = 42, C = 50, STEPS = 96;
  const W_MAX = 0.300, W_MIN = 0.112;
  const GAP_FROM = (-34 * Math.PI) / 180, GAP_TO = 0;
  const strokeAt = (th) => W_MIN + (W_MAX - W_MIN) * Math.cos(th) ** 2;
  const span = Math.PI * 2 - (GAP_TO - GAP_FROM);
  const outer = [], inner = [];
  for (let i = 0; i <= STEPS; i++) {
    const th = GAP_TO + (span * i) / STEPS;
    outer.push(`${(C + R * Math.cos(th)).toFixed(2)} ${(C + R * Math.sin(th)).toFixed(2)}`);
    const ri = R * (1 - strokeAt(th));
    inner.push(`${(C + ri * Math.cos(th)).toFixed(2)} ${(C + ri * Math.sin(th)).toFixed(2)}`);
  }
  return `M ${outer.join(' L ')} L ${inner.reverse().join(' L ')} Z`;
})();

const MARK_BAR = (() => {
  const R = 42, C = 50, BAR_HALF = 0.079, X0 = 0.255, X1 = 1.0;
  const y0 = (C - R * BAR_HALF).toFixed(2), y1 = (C + R * BAR_HALF).toFixed(2);
  const x0 = (C + R * X0).toFixed(2), x1 = (C + R * X1).toFixed(2);
  return `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`;
})();

/* ---------- misc ---------- */

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const isIPad = () =>
  /iPad/.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

export const isIPhone = () => /iPhone|iPod/.test(navigator.userAgent);

export const debounce = (fn, ms) => {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
};

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
