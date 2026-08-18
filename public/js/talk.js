// The talking tutor: a WebRTC session straight to OpenAI Realtime, opened with
// an ephemeral key the server mints so the real key never reaches the browser.
//
// This is deliberately NOT built on the Web Speech API. On iOS, speechSynthesis
// refuses to expose any of the good downloaded voices — so a native accent
// cannot be modelled at all — and three separate open WebKit bugs break the
// speak-then-listen loop outright. A realtime speech-to-speech session is the
// only route to a tutor that both sounds right and can be interrupted.
//
// The order of operations in connect() matters more than it looks. iOS drops
// audio started outside a user gesture, silently and with no error, and an
// <audio> sink attached after the network round trip loses the first utterance.
// So everything that touches audio happens synchronously inside the tap,
// before the first await.

import * as api from './api.js';
import * as store from './store.js';
import { t, uiLang } from './i18n.js';
import { LANGS } from './lang.js';
import { el, clear, toast, toastError, tap } from './ui.js';

const REALTIME_URL = 'https://api.openai.com/v1/realtime/calls';

export class TutorSession extends EventTarget {
  constructor() {
    super();
    this.state = 'idle';   // idle | connecting | listening | speaking | ended
    this.pc = null;
    this.dc = null;
    this.mic = null;
    this.audioEl = null;
    this.ctx = null;
    this.analyser = null;
    this.wakeLock = null;
    this.remoteStream = null;
    this.turns = [];       // {who:'me'|'tutor', text, partial}
    this.corrections = [];
    this.newWords = [];
    this.handsFree = true;
    this.levelRaf = null;
  }

  setState(s) {
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: s }));
  }

  emitTurns() { this.dispatchEvent(new Event('turns')); }

  /* ---------- connect ---------- */

  async connect({ lang, objective, glossary, dueWords, facts, level, correctionStyle, handsFree = true }) {
    if (this.state !== 'idle' && this.state !== 'ended') return;
    this.handsFree = handsFree;
    this.setState('connecting');

    // ── everything audio, synchronously, inside the gesture ──────────────
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ sampleRate: 24000 });
      this.ctx.resume();

      // A one-sample silent buffer is what actually marks the context as
      // user-started on iOS; resume() alone is not always enough.
      const buf = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start(0);

      // Without this the hardware ring/silent switch mutes everything the app
      // plays, which is the real cause of "it works on iPad but not iPhone".
      if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';

      // The sink element is created and started now, on a stream that is still
      // empty; the remote track is added into it later. Attaching the element
      // after the handshake is what makes realtime agents lose their first
      // sentence on iOS.
      this.remoteStream = new MediaStream();
      this.audioEl = document.createElement('audio');
      this.audioEl.autoplay = true;
      this.audioEl.playsInline = true;
      this.audioEl.srcObject = this.remoteStream;
      document.body.append(this.audioEl);
      this.audioEl.play().catch(() => { /* resumed again on first track */ });

      this.pc = new RTCPeerConnection();
      this.micPromise = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.setState('idle');
      throw e;
    }
    // ── from here on, awaiting is fine ───────────────────────────────────

    try {
      this.mic = await this.micPromise;
    } catch (e) {
      this.teardown();
      const err = new Error('mic_denied');
      err.code = 'mic_denied';
      throw err;
    }

    const track = this.mic.getAudioTracks()[0];
    this.pc.addTrack(track, this.mic);
    if (!this.handsFree) track.enabled = false;

    this.pc.ontrack = (e) => {
      for (const tr of e.streams[0].getAudioTracks()) {
        if (!this.remoteStream.getTracks().includes(tr)) this.remoteStream.addTrack(tr);
      }
      this.audioEl.play().catch(() => {});
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === 'failed' || s === 'disconnected') {
        this.dispatchEvent(new CustomEvent('lost'));
      }
    };

    this.dc = this.pc.createDataChannel('oai-events');
    this.dc.addEventListener('message', (e) => this._onEvent(JSON.parse(e.data)));
    this.dc.addEventListener('open', () => this._onOpen());

    // Ask the server for a session; it builds the instructions, injects the
    // glossary and returns a short-lived client secret.
    const session = await api.realtimeSession({
      lang, objective, glossary, dueWords, facts, level, correctionStyle, uiLang: uiLang(),
    });
    this.tools = session.tools || [];
    this.lang = lang;

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const res = await fetch(`${REALTIME_URL}?model=${encodeURIComponent(session.model)}`, {
      method: 'POST',
      body: offer.sdp,
      headers: {
        authorization: `Bearer ${session.clientSecret}`,
        'content-type': 'application/sdp',
      },
    });
    if (!res.ok) {
      this.teardown();
      const err = new Error('realtime_error');
      err.code = 'realtime_error';
      throw err;
    }
    await this.pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });

    this._startLevelMeter();
    this._acquireWakeLock();
    this.setState('listening');
  }

  _onOpen() {
    // Tools have to be declared over the data channel; push-to-talk turns the
    // server's own turn detection off so a release is what ends the turn.
    this.dc.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        tools: this.tools,
        tool_choice: 'auto',
        ...(this.handsFree ? {} : { audio: { input: { turn_detection: null } } }),
      },
    }));
    if (this.handsFree) this.dc.send(JSON.stringify({ type: 'response.create' }));
  }

  /* ---------- events ---------- */

  _onEvent(ev) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.setState('listening');
        break;

      case 'conversation.item.input_audio_transcription.delta':
        this._upsert('me', ev.delta, true);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this._upsert('me', ev.transcript, false, true);
        break;

      case 'response.output_audio_transcript.delta':
        this.setState('speaking');
        this._upsert('tutor', ev.delta, true);
        break;
      case 'response.output_audio_transcript.done':
        this._upsert('tutor', ev.transcript, false, true);
        break;

      case 'response.done':
        this.setState('listening');
        break;

      case 'response.function_call_arguments.done':
        this._onToolCall(ev);
        break;

      case 'error':
        console.warn('realtime error', ev.error);
        break;
      default:
        break;
    }
  }

  // Streaming deltas append to the open turn; a `completed` event replaces it
  // outright, because the final transcript is corrected relative to the deltas.
  _upsert(who, text, partial, replace = false) {
    if (!text) return;
    const last = this.turns[this.turns.length - 1];
    if (last && last.who === who && last.partial) {
      last.text = replace ? text : last.text + text;
      last.partial = partial;
    } else {
      this.turns.push({ who, text, partial });
    }
    this.emitTurns();
  }

  _onToolCall(ev) {
    let args = {};
    try { args = JSON.parse(ev.arguments || '{}'); } catch { /* malformed */ }

    if (ev.name === 'note_new_word' && args.term) {
      this.newWords.push(args);
      this.dispatchEvent(new CustomEvent('word', { detail: args }));
    } else if (ev.name === 'note_correction' && args.said) {
      this.corrections.push(args);
      this.dispatchEvent(new CustomEvent('correction', { detail: args }));
    }

    // The tools only record things, so an empty acknowledgement is the whole
    // response — but it has to be sent or the model waits for it.
    this.dc?.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: ev.call_id, output: '{"ok":true}' },
    }));
  }

  /* ---------- push to talk ---------- */

  startTalking() {
    if (this.handsFree || !this.dc || this.dc.readyState !== 'open') return;
    const track = this.mic?.getAudioTracks()[0];
    if (track) track.enabled = true;
    this.setState('listening');
  }

  stopTalking() {
    if (this.handsFree || !this.dc || this.dc.readyState !== 'open') return;
    const track = this.mic?.getAudioTracks()[0];
    if (track) track.enabled = false;
    this.dc.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.dc.send(JSON.stringify({ type: 'response.create' }));
    this.setState('speaking');
  }

  // Barge-in: cancel whatever the tutor is saying and drop the queued audio.
  interrupt() {
    if (this.dc?.readyState !== 'open') return;
    this.dc.send(JSON.stringify({ type: 'response.cancel' }));
    this.setState('listening');
  }

  /* ---------- level meter ---------- */

  _startLevelMeter() {
    // AnalyserNode rather than ScriptProcessor: onaudioprocess is not called at
    // all in Safari when an external microphone is attached.
    try {
      const src = this.ctx.createMediaStreamSource(this.mic);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.75;
      src.connect(this.analyser);
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      const loop = () => {
        this.analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
        this.level = Math.min(1, (peak / 128) * 2.4);
        this.dispatchEvent(new CustomEvent('level', { detail: this.level }));
        this.levelRaf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* meter is decoration; never fatal */ }
  }

  async _acquireWakeLock() {
    // Only honoured inside an installed web app from iPadOS 18.4 onwards, and
    // absent elsewhere — losing it just means the screen may sleep.
    try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* fine */ }
  }

  /* ---------- teardown ---------- */

  teardown() {
    cancelAnimationFrame(this.levelRaf);
    try { this.dc?.close(); } catch { /* already gone */ }
    try { this.pc?.close(); } catch { /* already gone */ }
    this.mic?.getTracks().forEach((tr) => tr.stop());
    this.audioEl?.remove();
    try { this.ctx?.close(); } catch { /* already gone */ }
    this.wakeLock?.release?.().catch(() => {});
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    this.pc = this.dc = this.mic = this.audioEl = this.ctx = this.wakeLock = null;
    this.setState('ended');
  }

  transcriptText() {
    return this.turns
      .filter((x) => x.text?.trim())
      .map((x) => `${x.who === 'me' ? 'LEARNER' : 'TUTOR'}: ${x.text.trim()}`)
      .join('\n');
  }
}

/* ═══ screen ═════════════════════════════════════════════════════════════ */

const TOPICS = {
  de: ['Mein Tag', 'Im Café bestellen', 'Reisen', 'Meine Arbeit', 'Ein Film, den ich mag'],
  ru: ['Мой день', 'В кафе', 'Путешествия', 'Моя работа', 'Любимый фильм'],
  it: ['La mia giornata', 'Al bar', 'Viaggiare', 'Il mio lavoro', 'Un film che mi piace'],
};

export function renderTalk(root, ctx) {
  clear(root);
  const lang = ctx.lang();
  const wrap = el('div.talk');

  const stage = el('div.stage');
  const orb = el('button.orb', { dataset: { state: 'idle' }, 'aria-label': t('talk.start') });
  orb.append(el('span.lvl'), el('span.label', { text: t('talk.start') }));
  const status = el('div.status');
  const glossHint = el('div.status');

  stage.append(orb, status, glossHint);

  const rail = el('div.rail');
  wrap.append(stage, rail);
  root.append(wrap);

  let session = null;
  let objective = '';

  const setLabel = (text) => { orb.querySelector('.label').textContent = text; };

  const paintTurns = () => {
    clear(rail);
    for (const turn of session.turns) {
      if (!turn.text?.trim()) continue;
      const node = el(`div.turn.${turn.who}${turn.partial ? '.partial' : ''}`);
      node.append(el('span.who', { text: turn.who === 'me' ? '·' : 'G' }));
      const txt = el('span.text', { text: turn.text });
      if (turn.who === 'tutor') {
        txt.lang = LANGS[lang].bcp47;
        txt.className = 'text l2';
        txt.style.fontSize = '17px';
      }
      node.append(txt);
      rail.append(node);
    }
    rail.scrollTop = rail.scrollHeight;
  };

  const showCorrection = (c) => {
    const node = el('div.fix');
    node.append(
      el('span.was', { text: c.said }),
      document.createTextNode('  →  '),
      el('span.now', { text: c.better }),
      c.why ? el('span.why', { text: c.why }) : null,
    );
    rail.append(node);
    rail.scrollTop = rail.scrollHeight;
  };

  async function begin() {
    tap(12);
    session = new TutorSession();

    session.addEventListener('state', (e) => {
      orb.dataset.state = e.detail;
      const map = {
        connecting: t('talk.connecting'),
        listening: session.handsFree ? t('talk.listening') : t('talk.hold'),
        speaking: t('talk.speaking'),
      };
      setLabel(map[e.detail] || t('talk.start'));
      status.textContent = e.detail === 'listening' && !session.handsFree ? t('talk.holdHint') : '';
    });
    session.addEventListener('turns', paintTurns);
    session.addEventListener('correction', (e) => showCorrection(e.detail));
    session.addEventListener('word', (e) => ctx.captureWord(e.detail, lang));
    session.addEventListener('level', (e) => orb.style.setProperty('--lvl', String(e.detail)));
    session.addEventListener('lost', () => {
      status.textContent = t('talk.micLost');
    });

    try {
      const glossary = await ctx.glossaryForTutor(lang);
      const due = await ctx.dueWordsForTutor(lang);
      const facts = await ctx.facts(lang);
      await session.connect({
        lang,
        objective,
        glossary,
        dueWords: due,
        facts,
        level: ctx.level(),
        correctionStyle: ctx.correctionStyle(),
        handsFree: ctx.handsFree(),
      });
      glossHint.textContent = glossary.length ? t('talk.usesGlossary', { n: glossary.length }) : '';
      renderRunning();
    } catch (e) {
      session.teardown();
      session = null;
      if (e.code === 'mic_denied') toast(t('talk.micDenied'), { bad: true, ms: 5000 });
      else toastError(e);
      setLabel(t('talk.start'));
      orb.dataset.state = 'idle';
    }
  }

  async function end() {
    if (!session) return;
    const transcript = session.transcriptText();
    const { corrections, newWords } = session;
    session.teardown();
    session = null;
    renderIdle();
    if (transcript.split('\n').length > 3) ctx.finishSession({ lang, transcript, corrections, newWords });
  }

  function renderRunning() {
    ctx.setTopAction({ label: t('talk.end'), onClick: end });
  }

  function renderIdle() {
    ctx.setTopAction(null);
    setLabel(t('talk.start'));
    orb.dataset.state = 'idle';
    status.textContent = '';
  }

  // Push-to-talk is the safer default on iOS: it sidesteps the autoplay policy,
  // the ducking bug and the speaker-reroute churn in one move. Hands-free is
  // offered in settings for anyone whose device behaves.
  orb.addEventListener('pointerdown', (e) => {
    if (!session) return;
    if (session.handsFree) {
      // Tapping while the tutor talks is a barge-in, which is the whole point
      // of a realtime session.
      if (session.state === 'speaking') session.interrupt();
      return;
    }
    e.preventDefault();
    orb.setPointerCapture?.(e.pointerId);
    session.startTalking();
  });
  const release = () => { if (session && !session.handsFree) session.stopTalking(); };
  orb.addEventListener('pointerup', release);
  orb.addEventListener('pointercancel', release);

  orb.addEventListener('click', () => { if (!session) begin(); });

  /* topic picker */
  const topics = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center', padding: '0 20px' } });
  topics.append(el('span.note', { text: t('talk.suggestTopics'), style: { width: '100%', textAlign: 'center', margin: '0 0 2px' } }));
  for (const topic of TOPICS[lang] || []) {
    topics.append(el('button.pill', {
      text: topic,
      lang: LANGS[lang].bcp47,
      onclick: (e) => {
        objective = objective === topic ? '' : topic;
        topics.querySelectorAll('.pill').forEach((p) => p.classList.toggle('ok', p.textContent === objective));
        tap();
      },
    }));
  }
  stage.append(topics);

  // A backgrounded iOS app has its WebRTC connection torn down; rebuilding is
  // the only reliable recovery, so the session is simply ended.
  const onVis = () => {
    if (document.visibilityState === 'hidden' && session) {
      status.textContent = '';
    }
  };
  document.addEventListener('visibilitychange', onVis);

  return () => {
    document.removeEventListener('visibilitychange', onVis);
    session?.teardown();
  };
}
