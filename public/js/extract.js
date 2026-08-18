// Vocabulary from a photo, a file, or pasted text.
//
// Point the camera at a menu, a street sign, a page of a book, a screenshot —
// or paste text straight in — and the words come back in dictionary form with
// translations, ready for the glossary.
//
// Two things matter more than they look. Images are downscaled here rather than
// uploaded whole: a modern phone camera produces something far larger than the
// model will look at, it gets resized server-side anyway, and on a phone
// connection the upload is most of the wait. And anything the model could not
// read confidently comes back flagged rather than guessed at — a half-legible
// word turned into a confident wrong entry is the one failure that would
// quietly poison the glossary.

import * as store from './store.js';
import * as api from './api.js';
import { LANGS } from './lang.js';
import { allWords, saveWord } from './glossary.js';
import { t, uiLang } from './i18n.js';
import { el, clear, sheet, toast, toastError, confirmAction, tap } from './ui.js';

const MAX_EDGE = 1568;   // above this the model downscales anyway
const MAX_IMAGES = 4;

/* ---------- image preparation ---------- */

// Draw through a canvas: it fixes the size, normalises whatever the phone
// produced (HEIC included, since Safari can decode it) to JPEG, and strips the
// EXIF metadata — which on a phone photo includes where it was taken.
function prepareImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      // White underneath, so a transparent PNG screenshot does not become
      // black-on-black once the alpha is flattened into JPEG.
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      // 0.92 keeps small print legible; heavier compression smears letterforms
      // and the model starts misreading them.
      resolve({
        dataUrl: canvas.toDataURL('image/jpeg', 0.92),
        w,
        h,
        name: file.name || 'photo.jpg',
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable_image'));
    };
    img.src = url;
  });
}

const isImage = (file) => file.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name || '');
const isText = (file) => file.type.startsWith('text/') || /\.(txt|md|csv|srt|vtt)$/i.test(file.name || '');

/* ---------- the capture sheet ---------- */

export function openExtract(ctx, { onDone = null } = {}) {
  const lang = ctx.lang();
  const L = LANGS[lang];
  const body = el('div');

  let images = [];   // { dataUrl, w, h, name }
  let pastedText = '';

  const preview = el('div', {
    style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '4px 0 14px' },
  });
  const go = el('button.btn', { text: t('ex.extract'), disabled: true });
  const status = el('div.hint', { style: { textAlign: 'center', marginTop: '10px' } });

  const paintPreview = () => {
    clear(preview);
    for (const [i, im] of images.entries()) {
      const thumb = el('div', {
        style: {
          position: 'relative', width: '86px', height: '86px', borderRadius: '12px',
          overflow: 'hidden', border: '1px solid var(--line)',
          background: `center/cover no-repeat url(${im.dataUrl})`,
        },
      });
      thumb.append(el('button', {
        text: '✕',
        style: {
          position: 'absolute', top: '2px', right: '2px', width: '22px', height: '22px',
          borderRadius: '50%', background: 'rgba(22,33,27,.72)', color: '#fff', fontSize: '12px',
        },
        onclick: () => { images.splice(i, 1); paintPreview(); },
      }));
      preview.append(thumb);
    }
    if (pastedText) {
      preview.append(el('div', {
        style: {
          padding: '10px 12px', borderRadius: '12px', background: 'var(--wash)',
          border: '1px solid var(--line)', fontSize: '12.5px', color: 'var(--muted)', maxWidth: '100%',
        },
        text: `${pastedText.trim().split(/\s+/).length} ${t('ex.words')}`,
      }));
    }
    go.disabled = !images.length && !pastedText.trim();
  };

  // Two separate inputs. `capture` opens the camera straight away, which is
  // what "take a photo" should do; without it iOS shows its own action sheet
  // where the library and Files are one tap away.
  const camInput = el('input', {
    type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' },
  });
  const fileInput = el('input', {
    type: 'file', accept: 'image/*,text/plain,.txt,.md,.csv', multiple: true, style: { display: 'none' },
  });

  async function takeFiles(list) {
    const files = [...list].slice(0, MAX_IMAGES + 2);
    for (const file of files) {
      try {
        if (isImage(file)) {
          if (images.length >= MAX_IMAGES) { toast(t('ex.maxImages', { n: MAX_IMAGES })); break; }
          images.push(await prepareImage(file));
        } else if (isText(file)) {
          pastedText = `${pastedText}\n${await file.text()}`.trim().slice(0, 12_000);
        } else {
          toast(t('ex.unsupported'), { bad: true });
        }
      } catch {
        toast(t('ex.unreadable'), { bad: true });
      }
    }
    paintPreview();
  }

  camInput.addEventListener('change', () => { takeFiles(camInput.files || []); camInput.value = ''; });
  fileInput.addEventListener('change', () => { takeFiles(fileInput.files || []); fileInput.value = ''; });

  const textArea = el('textarea.input', {
    placeholder: t('ex.pastePlaceholder'),
    rows: 3,
    oninput: (e) => { pastedText = e.target.value; paintPreview(); },
  });

  body.append(
    el('div', { style: { display: 'flex', gap: '9px', marginBottom: '12px' } }, [
      el('button.btn.quiet', { text: '📷  ' + t('ex.takePhoto'), onclick: () => { tap(); camInput.click(); } }),
      el('button.btn.quiet', { text: '🖿  ' + t('ex.chooseFile'), onclick: () => { tap(); fileInput.click(); } }),
    ]),
    preview,
    el('div.field', {}, [el('label', { text: t('ex.orPaste') }), textArea]),
    camInput, fileInput,
    go,
    status,
    el('div.note', { text: t('ex.privacy') }),
  );

  const h = sheet({ title: t('ex.title'), body });

  go.addEventListener('click', async () => {
    go.disabled = true;
    clear(go).append(el('span.spinner'), document.createTextNode(' ' + t('ex.reading')));
    status.textContent = '';
    try {
      const result = await api.extractVocabulary({
        lang,
        images: images.map((i) => i.dataUrl),
        text: pastedText,
        uiLang: uiLang(),
        level: ctx.level(),
      });

      if (!result.readable || !(result.vocabulary || []).length) {
        go.disabled = false;
        clear(go).append(document.createTextNode(t('ex.extract')));
        status.innerHTML = '';
        status.append(
          el('div', { text: t('ex.cannotRead'), style: { color: 'var(--rose)', fontWeight: '600' } }),
          el('div', { text: t('ex.cannotReadHint'), style: { marginTop: '4px' } }),
        );
        return;
      }

      // The capture itself is kept, minus the image: the words are the point,
      // and a few megabytes of photo per capture would dominate the sync.
      const id = store.uid();
      const capture = {
        id, lang,
        kind: result.kind || '',
        summary: result.summary || '',
        transcript: result.transcript || '',
        count: (result.vocabulary || []).length,
        createdAt: Date.now(),
        result,
      };
      await store.put('capture', id, capture);
      h.close();
      openResult(ctx, capture, { onDone });
    } catch (e) {
      go.disabled = false;
      clear(go).append(document.createTextNode(t('ex.extract')));
      toastError(e);
    }
  });
}

/* ---------- results ---------- */

export function openResult(ctx, capture, { onDone = null } = {}) {
  const result = capture.result || {};
  const lang = capture.lang;
  const L = LANGS[lang];
  const body = el('div');

  const chips = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } });
  if (result.kind) chips.append(el('span.pill', { text: result.kind }));
  if (result.language && result.language !== lang) {
    chips.append(el('span.pill.warn', { text: t('ex.wrongLang', { lang: L.name[uiLang()] }) }));
  }
  body.append(chips);

  if (result.summary) {
    body.append(el('div.card', {}, [el('div.card-body', {}, [
      el('p', { text: result.summary, style: { margin: '0', fontSize: '15px', lineHeight: '1.55' } }),
    ])]));
  }

  const vocab = result.vocabulary || [];
  // Anything the model flagged as uncertain starts unticked. The learner can
  // still add it, but not without noticing.
  const picked = new Set(vocab.map((v, i) => (v.uncertain ? null : i)).filter((i) => i !== null));

  body.append(el('div.sect', { text: `${t('ex.found')} · ${vocab.length}` }));
  const rows = el('div.rows');

  vocab.forEach((v, i) => {
    const check = el('div.val', {
      text: '✓',
      style: { color: 'var(--accent)', fontSize: '18px', opacity: picked.has(i) ? '1' : '.16' },
    });
    rows.append(el('button.wordrow', {
      onclick: () => {
        if (picked.has(i)) { picked.delete(i); check.style.opacity = '.16'; }
        else { picked.add(i); check.style.opacity = '1'; }
        tap();
        paintAdd();
      },
    }, [
      el('span.grow', {}, [
        el('span.term', { text: v.lemma, lang: L.bcp47 }),
        el('span.gloss', { text: (v.translations?.[uiLang()] || v.translations?.en || []).join(', ') }),
        v.asSeen && v.asSeen !== v.lemma
          ? el('span.gloss', { text: `${t('ex.asSeen')}: ${v.asSeen}`, style: { color: 'var(--faint)' } })
          : null,
      ]),
      el('span.meta', {}, [
        check,
        v.uncertain ? el('span.pill.warn', { text: '?' }) : null,
      ]),
    ]));
  });
  body.append(rows);

  const addBtn = el('button.btn', { style: { marginTop: '14px' } });
  const paintAdd = () => {
    clear(addBtn).append(document.createTextNode(t('ex.addN', { n: picked.size })));
    addBtn.disabled = picked.size === 0;
  };
  paintAdd();

  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    const existing = await allWords(lang);
    const norm = (s) => String(s || '').toLowerCase().trim();
    let added = 0;
    for (const i of picked) {
      const v = vocab[i];
      if (existing.some((w) => norm(w.term) === norm(v.lemma))) continue;
      await saveWord({
        lang,
        term: v.lemma,
        asWritten: v.asSeen || v.lemma,
        pos: v.pos,
        translations: v.translations || {},
        ipa: v.ipa,
        grammar: v.grammar || {},
        example: v.example || null,
        notes: v.note,
        source: 'capture',
        captureId: capture.id,
        // A flagged reading stays flagged in the glossary, so it shows a "?"
        // until it has been through the normal word check.
        unchecked: !!v.uncertain,
      });
      existing.push({ term: v.lemma });
      added += 1;
    }
    toast(t('sg.added', { n: added }));
    tap(10);
    ctx.refreshDue?.();
    onDone?.();
    h.close();
  });
  body.append(addBtn);

  if (result.expressions?.length) {
    body.append(el('div.sect', { text: t('sg.expressions') }));
    const card = el('div.rows');
    for (const x of result.expressions) {
      card.append(el('div.row', {}, [
        el('div.grow', {}, [
          el('div.lab', { text: x.expression, lang: L.bcp47, style: { fontFamily: 'var(--serif)' } }),
          el('div.sub', { text: x.meaning }),
        ]),
      ]));
    }
    body.append(card);
  }

  if (result.notes?.length) {
    body.append(el('div.sect', { text: t('sg.culture') }));
    const card = el('div.rows');
    for (const n of result.notes) {
      card.append(el('div.row', {}, [
        el('div.grow', {}, [el('div.sub', { text: n, style: { fontSize: '14px', color: 'var(--ink)' } })]),
      ]));
    }
    body.append(card);
  }

  body.append(el('div', { style: { marginTop: '16px' } }, [
    el('button.btn.quiet', {
      text: t('act.delete'),
      style: { color: 'var(--rose)' },
      onclick: async () => {
        if (await confirmAction({ title: t('act.delete'), message: t('ex.deleteWarn'), confirmLabel: t('act.delete'), danger: true })) {
          await store.remove('capture', capture.id);
          h.close();
          onDone?.();
        }
      },
    }),
  ]));

  const h = sheet({ title: '', body });
}

/* ---------- the list, shown inside Words ---------- */

export function capturesSection(ctx, onChanged) {
  const wrap = el('div');
  const list = el('div.rows');
  wrap.append(el('div.sect', { text: t('ex.myCaptures') }), list);

  async function paint() {
    const all = (await store.all('capture'))
      .filter((c) => c.lang === ctx.lang())
      .sort((a, b) => b.createdAt - a.createdAt);
    clear(list);
    list.append(el('button.row', {
      onclick: () => openExtract(ctx, { onDone: () => { paint(); onChanged?.(); } }),
    }, [
      el('div.grow', {}, [
        el('div.lab', { text: '＋ ' + t('ex.title'), style: { color: 'var(--accent)' } }),
        el('div.sub', { text: t('ex.subtitle') }),
      ]),
    ]));

    for (const c of all) {
      list.append(el('button.row', {
        onclick: () => openResult(ctx, c, { onDone: () => { paint(); onChanged?.(); } }),
      }, [
        el('div.grow', {}, [
          el('div.lab', { text: c.kind || t('ex.title') }),
          el('div.sub', { text: `${c.summary || ''}`.slice(0, 70) }),
        ]),
        el('div.val', { text: String(c.count || 0) }),
      ]));
    }
  }

  paint();
  return wrap;
}
