// Typing to the tutor.
//
// The same tutor as the voice session — same persona, same glossary, same
// tools — so "add that word" works whether you say it or type it. It runs on
// Claude rather than the realtime model, which means it works with no
// microphone, in a quiet room, on a bad connection, and without an OpenAI key.
//
// Tools execute here on the device, not on the server: the glossary lives in
// IndexedDB. The server returns the calls, this runs them, and the results go
// back in the next turn — so the tutor's confirmation describes what actually
// happened rather than what it intended.

import * as api from './api.js';
import { LANGS } from './lang.js';
import { t, uiLang } from './i18n.js';
import { el, clear, toastError, tap } from './ui.js';

const MAX_TOOL_ROUNDS = 4;   // a tool loop should converge; this stops a spin

export class TextChat {
  constructor(ctx, lang) {
    this.ctx = ctx;
    this.lang = lang;
    this.messages = [];     // Anthropic-shaped, kept verbatim for the next turn
    this.turns = [];        // {who, text} for display
    this.busy = false;
    this.onUpdate = () => {};
  }

  async send(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || this.busy) return;
    this.busy = true;

    this.messages.push({ role: 'user', content: [{ type: 'text', text: trimmed }] });
    this.turns.push({ who: 'me', text: trimmed });
    this.onUpdate();

    try {
      const [glossary, dueWords, facts] = await Promise.all([
        this.ctx.glossaryForTutor(this.lang),
        this.ctx.dueWordsForTutor(this.lang),
        this.ctx.facts(this.lang),
      ]);
      const actions = this.ctx.tutorActions(this.lang);

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await api.chat({
          lang: this.lang,
          messages: this.messages,
          glossary,
          dueWords,
          facts,
          level: this.ctx.level(),
          correctionStyle: this.ctx.correctionStyle(),
          uiLang: uiLang(),
        });

        if (res.text) {
          this.turns.push({ who: 'tutor', text: res.text });
          this.onUpdate();
        }
        // Push the assistant turn back verbatim, tool_use blocks included —
        // the API rejects a tool_result that does not follow its own call.
        this.messages.push({ role: 'assistant', content: res.raw });

        if (!res.toolCalls?.length) break;

        const results = [];
        for (const call of res.toolCalls) {
          let output = { ok: false, error: 'unknown_tool' };
          try {
            const run = actions[call.name];
            if (run) output = (await run(call.input || {})) || { ok: true };
          } catch (e) {
            output = { ok: false, error: String(e?.code || e?.message || 'failed') };
          }
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(output),
          });
        }
        this.messages.push({ role: 'user', content: results });
      }
    } catch (e) {
      toastError(e);
      // Drop the turn that failed, so a retry does not send it twice.
      this.messages = this.messages.filter((m) => m.role !== 'assistant' || m.content?.length);
    } finally {
      this.busy = false;
      this.onUpdate();
    }
  }
}

/* ---------- the composer, mounted on the Talk screen ---------- */

// `sendVoice` is supplied when a live voice session is running: typed text is
// injected into that session instead, so the tutor answers out loud and the
// conversation stays one thread rather than two.
export function mountComposer(host, ctx, { lang, onTurns, sendVoice = null }) {
  const chat = new TextChat(ctx, lang);
  chat.onUpdate = () => onTurns(chat.turns, chat.busy);

  const input = el('input.input', {
    type: 'text',
    placeholder: t('chat.placeholder'),
    autocapitalize: 'sentences',
    autocorrect: 'on',
    enterkeyhint: 'send',
    style: { flex: '1', minHeight: '44px', fontSize: '16px' },
  });
  const send = el('button.btn.sm', { text: '↑', style: { minWidth: '44px', minHeight: '44px' } });

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    tap();
    if (sendVoice?.()) {
      // A live session is running: let it answer aloud.
      sendVoice()(text);
      onTurns([...chat.turns, { who: 'me', text }], false);
      return;
    }
    await chat.send(text);
  };

  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  const row = el('div', {
    style: {
      display: 'flex', gap: '8px', alignItems: 'center',
      padding: '10px 16px calc(var(--safe-b) + 10px)',
      borderTop: '1px solid var(--line-soft)', background: 'var(--bg)', flex: '0 0 auto',
    },
  }, [input, send]);

  host.append(row);
  return { chat, input, focus: () => input.focus() };
}
