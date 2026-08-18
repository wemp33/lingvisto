// Thin wrapper over the Railway backend. The session token lives in
// localStorage rather than an httpOnly cookie so the service worker and the
// installed PWA both see it without a cookie round trip.

const TOKEN_KEY = 'lingvisto.token';
const USER_KEY = 'lingvisto.user';

let token = localStorage.getItem(TOKEN_KEY) || null;
let user = JSON.parse(localStorage.getItem(USER_KEY) || 'null');

export const hasSession = () => !!token;
export const currentUser = () => user;

function setSession(t, u) {
  token = t;
  user = u;
  if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
  if (u) localStorage.setItem(USER_KEY, JSON.stringify(u)); else localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  constructor(code, status, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function req(path, { method = 'GET', body, timeout = 30_000, raw = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new ApiError(e.name === 'AbortError' ? 'timeout' : 'offline', 0);
  }
  clearTimeout(timer);

  if (res.status === 401) {
    setSession(null, null);
    onUnauthorized();
    throw new ApiError('unauthorized', 401);
  }
  if (raw) {
    if (!res.ok) throw new ApiError('http_error', res.status);
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new ApiError(data.error || 'http_error', res.status, data);
  }
  return data;
}

/* ---------- account ---------- */

const deviceLabel = () => {
  const ua = navigator.userAgent;
  const kind = /iPad/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua))
    ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone' : 'Computer';
  return `${kind} · ${new Date().toLocaleDateString()}`;
};

export async function register(nickname, code) {
  const d = await req('/auth/register', { method: 'POST', body: { nickname, code, device: deviceLabel() } });
  setSession(d.token, d.user);
  return d.user;
}

export async function login(nickname, code) {
  const d = await req('/auth/login', { method: 'POST', body: { nickname, code, device: deviceLabel() } });
  setSession(d.token, d.user);
  return d.user;
}

export async function logout() {
  try { await req('/auth/logout', { method: 'POST' }); } catch { /* leaving anyway */ }
  setSession(null, null);
}

export const changeCode = (currentCode, newCode) =>
  req('/auth/code', { method: 'POST', body: { currentCode, newCode } });

/* ---------- sync ---------- */

export async function push(records) {
  if (!token) return null;
  try {
    return await req('/sync/push', { method: 'POST', body: { records }, timeout: 60_000 });
  } catch (e) {
    if (e.code === 'offline' || e.code === 'timeout') return null;
    throw e;
  }
}

export async function pull(cursor) {
  if (!token) return null;
  try {
    return await req(`/sync/pull?since=${encodeURIComponent(cursor || 0)}`, { timeout: 60_000 });
  } catch (e) {
    if (e.code === 'offline' || e.code === 'timeout') return null;
    throw e;
  }
}

/* ---------- api keys ---------- */
// The key itself is write-only from the client's point of view: it goes up
// once and only its last four characters ever come back.
export const keyStatus = () => req('/keys');
export const setKey = (provider, key) =>
  req('/keys', { method: 'POST', body: { provider, key }, timeout: 30_000 });
export const clearKey = (provider) =>
  req(`/keys?provider=${encodeURIComponent(provider)}`, { method: 'DELETE' });

/* ---------- ai ---------- */

// Ephemeral client secret for the OpenAI Realtime session. Short-lived and
// scoped, so the real key never reaches the browser.
export const realtimeSession = (payload) =>
  req('/ai/realtime-session', { method: 'POST', body: payload, timeout: 20_000 });

export const validateWord = (payload) =>
  req('/ai/word', { method: 'POST', body: payload, timeout: 60_000 });

export const critiqueHandwriting = (payload) =>
  req('/ai/handwriting', { method: 'POST', body: payload, timeout: 60_000 });

export const recogniseInk = (payload) =>
  req('/ai/ink', { method: 'POST', body: payload, timeout: 30_000 });

// Fetched as a blob rather than pointed at with <audio src>, so the session
// token stays in a header instead of a URL that would end up in access logs.
// Results are cached per (text, lang, speed): the same word is tapped a lot.
const speechCache = new Map();

export async function speak(text, lang, { slow = false } = {}) {
  const k = `${lang}|${slow ? 's' : 'n'}|${text}`;
  if (speechCache.has(k)) return speechCache.get(k);
  const res = await req('/ai/speak', {
    method: 'POST',
    body: { text, lang, slow },
    timeout: 30_000,
    raw: true,
  });
  const url = URL.createObjectURL(await res.blob());
  if (speechCache.size > 120) {
    const oldest = speechCache.keys().next().value;
    URL.revokeObjectURL(speechCache.get(oldest));
    speechCache.delete(oldest);
  }
  speechCache.set(k, url);
  return url;
}

// Song analysis is a long call — it builds a whole lesson in one shot.
export const analyseSong = (payload) =>
  req('/ai/song', { method: 'POST', body: payload, timeout: 120_000 });

// Images are already downscaled client-side; this is still the largest
// request the app makes, so it gets a long ceiling.
export const extractVocabulary = (payload) =>
  req('/ai/extract', { method: 'POST', body: payload, timeout: 180_000 });

export const sessionReport = (payload) =>
  req('/ai/report', { method: 'POST', body: payload, timeout: 60_000 });

export const health = () => req('/health', { timeout: 8000 });
