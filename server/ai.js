// All model calls live here so the keys never leave the server.
//
// Two providers, each doing what it is actually good at:
//   * OpenAI Realtime holds the spoken conversation. It hears the learner's
//     real audio rather than a transcript, which is the only way an accent can
//     be coached at all, and it can be interrupted mid-sentence.
//   * Claude does the written work — validating a glossary entry, reading
//     handwriting, writing the end-of-session report — where careful,
//     structured, checkable output matters more than latency.
//
// The conversational model is never asked to be the grader. Audio models
// hallucinate pronunciation verdicts with great confidence, including telling
// a learner that plainly wrong articulation "closely matches a native
// speaker". Praise from the tutor is encouragement; it is not a score.

import { LANG_PROMPTS } from './langdata.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI = 'https://api.openai.com/v1';

const MODEL_FAST = process.env.CLAUDE_FAST_MODEL || 'claude-haiku-4-5-20251001';
const MODEL_GOOD = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';

export const hasAnthropic = () => !!process.env.ANTHROPIC_API_KEY;
export const hasOpenAI = () => !!process.env.OPENAI_API_KEY;

class AiError extends Error {
  constructor(code, status = 502, detail = '') {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/* ═══ Claude ═════════════════════════════════════════════════════════════ */

// Structured output via a forced tool call. This is the stable way to get JSON
// out of the model — assistant-turn prefills are rejected by current models.
async function claudeJson({ system, content, tool, model = MODEL_GOOD, maxTokens = 2000, apiKey }) {
  if (!apiKey) throw new AiError('no_key', 503);

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AiError('model_error', res.status === 429 ? 429 : 502, text.slice(0, 400));
  }
  const data = await res.json();
  const use = data.content?.find((c) => c.type === 'tool_use');
  if (!use) throw new AiError('model_no_output', 502);
  return { result: use.input, usage: data.usage };
}

/* ---- glossary validation ---- */

const WORD_TOOL = {
  name: 'record_word',
  description: 'Record the checked and completed dictionary entry.',
  input_schema: {
    type: 'object',
    required: ['status', 'lemma', 'pos', 'translations'],
    properties: {
      status: {
        type: 'string',
        enum: ['ok', 'corrected', 'not_a_word', 'wrong_language'],
        description:
          'ok = exactly as the learner wrote it. corrected = real word but misspelled or not in dictionary form. '
          + 'not_a_word = no such word in this language. wrong_language = it is a word, but of another language.',
      },
      lemma: { type: 'string', description: 'The dictionary form, exactly as a dictionary would print it.' },
      asWritten: { type: 'string', description: 'What the learner typed, echoed back.' },
      correctionNote: { type: 'string', description: 'One short sentence saying what was wrong. Empty when status is ok.' },
      pos: { type: 'string' },
      translations: {
        type: 'object',
        required: ['pl', 'en'],
        properties: {
          pl: { type: 'array', items: { type: 'string' }, description: '1-3 Polish translations, best first.' },
          en: { type: 'array', items: { type: 'string' }, description: '1-3 English translations, best first.' },
        },
      },
      ipa: { type: 'string', description: 'IPA for the lemma, no slashes.' },
      grammar: {
        type: 'object',
        description: 'Only the fields that apply to this part of speech and language.',
        additionalProperties: { type: 'string' },
      },
      example: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'One natural sentence using the word, at the learner\'s level.' },
          pl: { type: 'string' },
          en: { type: 'string' },
        },
      },
      register: { type: 'string', description: 'neutral, formal, colloquial, vulgar, archaic, regional...' },
      falseFriend: {
        type: 'string',
        description: 'Fill only if this word looks like a Polish or English word but means something else. Otherwise empty.',
      },
      difficulty: { type: 'integer', minimum: 1, maximum: 5 },
    },
  },
};

export async function validateWord({ lang, term, meaning, uiLang = 'en', level = 'B1', apiKey }) {
  const L = LANG_PROMPTS[lang];
  if (!L) throw new AiError('bad_language', 400);

  const system = [
    `You are a meticulous ${L.name} lexicographer preparing an entry for a learner whose languages are Polish and English.`,
    `The learner is around CEFR ${level}.`,
    '',
    'Rules:',
    `- Normalise to the dictionary form. ${L.lemmaRule}`,
    '- If the learner misspelled a real word, set status "corrected" and put the correct form in lemma.',
    '- If no such word exists, set status "not_a_word". Do not invent a plausible word.',
    '- If the word belongs to a different language, set status "wrong_language".',
    `- ${L.grammarInstruction}`,
    '- The example sentence must be natural, short, and use the word in its ordinary sense.',
    '- Be honest about register. A learner who writes a vulgar word should be told so.',
    '- Fill falseFriend only when there is a genuine trap for a Polish or English speaker.',
  ].join('\n');

  const content = [
    { type: 'text', text: `Language being learnt: ${L.name}\nThe learner typed: ${term}` },
  ];
  if (meaning) {
    content.push({
      type: 'text',
      text: `They said it means: ${meaning}\nIf that meaning is wrong or only one of several, say so in correctionNote and give the correct translations anyway.`,
    });
  }

  const { result } = await claudeJson({ system, content, tool: WORD_TOOL, maxTokens: 1500, apiKey });
  return result;
}

/* ---- handwriting critique ---- */

const HAND_TOOL = {
  name: 'critique_handwriting',
  description: 'Report on what the learner wrote by hand.',
  input_schema: {
    type: 'object',
    required: ['reading', 'verdict', 'comment'],
    properties: {
      reading: { type: 'string', description: 'What the handwriting actually says, transcribed literally, including any misspelling.' },
      legible: { type: 'boolean' },
      verdict: { type: 'string', enum: ['correct', 'close', 'wrong', 'unreadable'] },
      comment: { type: 'string', description: 'Two sentences at most, addressed to the learner, in their interface language.' },
      issues: {
        type: 'array',
        description: 'Specific, concrete problems. Empty when the writing is good.',
        items: {
          type: 'object',
          required: ['letter', 'problem'],
          properties: {
            letter: { type: 'string' },
            problem: { type: 'string' },
            fix: { type: 'string' },
          },
        },
      },
      spelling: { type: 'string', description: 'The correct spelling when the reading is misspelled; empty otherwise.' },
      matchedTask: {
        type: 'boolean',
        description: 'Coach mode only: did they write what the task actually asked for? Legible writing of the wrong thing is false.',
      },
      nextTask: {
        type: 'object',
        description: 'Coach mode only. The next thing to write, chosen in light of what just happened.',
        required: ['task', 'expect'],
        properties: {
          task: { type: 'string', description: 'The instruction, in the interface language.' },
          spoken: { type: 'string', description: 'The same instruction phrased for reading aloud.' },
          expect: { type: 'string' },
          mode: { type: 'string', enum: ['letter', 'word', 'phrase', 'sentence'] },
          hint: { type: 'string' },
          why: { type: 'string', description: 'One clause on why this follows from what they just did.' },
        },
      },
    },
  },
};

export async function critiqueHandwriting({ lang, imageBase64, target, uiLang = 'en', mode = 'free', recognised = null, apiKey, task = null, level = 'B1', glossary = [], recent = [] }) {
  const L = LANG_PROMPTS[lang];
  if (!L) throw new AiError('bad_language', 400);

  const system = [
    `You are a ${L.name} handwriting tutor looking at a photo of what a learner just wrote.`,
    `Reply to the learner in ${uiLang === 'pl' ? 'Polish' : 'English'}.`,
    '',
    'How to judge the writing:',
    L.handwritingNotes,
    '',
    'Rules:',
    '- First read what is actually on the page, letter by letter. Transcribe it literally, including mistakes. Do not read what you expect to see.',
    '- If the ink is genuinely ambiguous or too faint, set verdict "unreadable" rather than guessing.',
    '- Judge letterform and spelling separately: beautiful writing of the wrong word is still the wrong word.',
    '- Be specific. "Your а is not closed at the top" is useful; "work on your letters" is not.',
    '- Be brief and warm. Two sentences of comment, maximum.',
  ].join('\n');

  // Anthropic reads an image better when it comes before the text that asks
  // about it, so the picture leads.
  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
  ];
  const facts = [];
  if (mode === 'coach' && task) {
    facts.push(`The task you set was: ${task.task}`);
    facts.push(`A correct answer would be: ${task.expect}`);
    if (task.alternatives?.length) facts.push(`Also acceptable: ${task.alternatives.join(', ')}`);
    facts.push(`They are around CEFR ${level}.`);
    if (glossary.length) facts.push(`Words in their glossary you may draw on: ${glossary.slice(0, 50).join(', ')}`);
    if (recent.length) facts.push(`Tasks already set this session, do not repeat: ${recent.slice(-6).join(' | ')}`);
  } else if (mode === 'prompt' && target) {
    facts.push(`The learner was asked to write: ${target}`);
  } else {
    facts.push('The learner is writing freely; there is no target word.');
  }
  // A separate recogniser is more reliable at reading ink than a vision model
  // is, so when it has an opinion it is handed over as evidence rather than
  // asking the model to work alone.
  if (recognised?.length) {
    facts.push(`An independent handwriting recogniser read this as, most likely first: ${recognised.slice(0, 3).join(', ')}. Weigh that against what you see.`);
  }
  content.push({ type: 'text', text: facts.join('\n') });

  const { result } = await claudeJson({
    system, content, tool: HAND_TOOL,
    model: mode === 'prompt' ? MODEL_FAST : MODEL_GOOD,
    maxTokens: mode === 'coach' ? 1400 : 900, apiKey,
  });
  return result;
}

/* ---- learning from a song ---- */

// Deliberately a vocabulary builder, not a lyrics viewer. The model is asked
// for the words a song teaches — in dictionary form, with its own example
// sentences — and is explicitly forbidden from reproducing the lyrics
// themselves. That is both the legally clean design and the more useful one:
// a line of a song is not a study item, but "sich sehnen nach + Dativ" is.
const SONG_TOOL = {
  name: 'record_song_lesson',
  description: 'Record a vocabulary lesson built from a song.',
  input_schema: {
    type: 'object',
    required: ['found', 'confidence', 'vocabulary'],
    properties: {
      found: {
        type: 'boolean',
        description: 'False if you do not actually know this song. Never guess — a fabricated lesson is worse than none.',
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      title: { type: 'string', description: 'The song title as properly spelled.' },
      artist: { type: 'string' },
      language: { type: 'string', description: 'Two-letter code of the language the song is actually sung in.' },
      year: { type: 'string' },
      genre: { type: 'string' },
      about: {
        type: 'string',
        description: 'Two or three sentences on what the song is about and its mood, in your own words. Never quote it.',
      },
      difficulty: { type: 'integer', minimum: 1, maximum: 5, description: 'How hard the language is, 1 easy to 5 hard.' },
      register: { type: 'string', description: 'e.g. everyday, poetic, slang-heavy, archaic, regional dialect.' },
      vocabulary: {
        type: 'array',
        description: '10-25 words worth learning from this song, most useful first. Dictionary form only.',
        items: {
          type: 'object',
          required: ['lemma', 'translations'],
          properties: {
            lemma: { type: 'string', description: 'The dictionary form, exactly as a dictionary would print it.' },
            pos: { type: 'string' },
            translations: {
              type: 'object',
              required: ['pl', 'en'],
              properties: {
                pl: { type: 'array', items: { type: 'string' } },
                en: { type: 'array', items: { type: 'string' } },
              },
            },
            ipa: { type: 'string' },
            grammar: { type: 'object', additionalProperties: { type: 'string' } },
            example: {
              type: 'object',
              description: 'A sentence YOU write to show the word. Never a line from the song.',
              required: ['text'],
              properties: { text: { type: 'string' }, pl: { type: 'string' }, en: { type: 'string' } },
            },
            note: { type: 'string', description: 'Why it matters in this song, or a nuance worth knowing. No quoting.' },
            core: { type: 'boolean', description: 'True if this is everyday vocabulary rather than poetic or song-specific.' },
          },
        },
      },
      expressions: {
        type: 'array',
        description: 'Idioms and fixed collocations the song uses, given in their neutral dictionary form — not as they are sung.',
        items: {
          type: 'object',
          required: ['expression', 'meaning'],
          properties: {
            expression: { type: 'string' },
            meaning: { type: 'string' },
            literal: { type: 'string', description: 'The word-for-word reading, when it differs amusingly from the sense.' },
          },
        },
      },
      grammarPoints: {
        type: 'array',
        description: 'Grammar this song is good practice for.',
        items: {
          type: 'object',
          required: ['point', 'explain'],
          properties: { point: { type: 'string' }, explain: { type: 'string' } },
        },
      },
      culturalNotes: { type: 'array', items: { type: 'string' } },
      listeningTips: {
        type: 'array',
        description: 'What to listen for: elisions, dialect, sounds that get swallowed when sung.',
        items: { type: 'string' },
      },
    },
  },
};

export async function analyseSong({ lang, title, artist, uiLang = 'en', level = 'B1', apiKey }) {
  const L = LANG_PROMPTS[lang];
  if (!L) throw new AiError('bad_language', 400);

  const system = [
    `You build ${L.name} vocabulary lessons from songs, for a learner at around CEFR ${level} whose own languages are Polish and English.`,
    `Write all explanations in ${uiLang === 'pl' ? 'Polish' : 'English'}.`,
    '',
    'HARD RULE — do not reproduce the lyrics.',
    '- Never output a line, a couplet, or a distinctive phrase as it appears in the song.',
    '- Vocabulary must be single words in dictionary form. Expressions must be given in their neutral dictionary form, not as they are sung.',
    '- Every example sentence must be one you wrote yourself, about something else entirely.',
    '- Describe what the song is about in your own words. Do not paraphrase it line by line.',
    'This is not a formality: the learner wants a glossary they can study, and a lyrics dump would be both useless and not yours to give.',
    '',
    'HONESTY',
    '- If you do not genuinely know this song, set found to false. Do not assemble a plausible-looking lesson from the title.',
    '- If you know it only vaguely, set confidence to low and include only vocabulary you are sure of.',
    `- If the song is not actually in ${L.name}, say so in the "about" field and set the language field to what it really is.`,
    '',
    'WHAT MAKES A GOOD LESSON',
    '- Lead with words the learner will meet again outside this song; mark those core: true.',
    '- Songs are full of poetic and archaic usage. Include it, but flag it, so nobody starts speaking in lyrics.',
    `- ${L.grammarInstruction}`,
    '- Listening tips matter more here than anywhere else: singers elide, stretch and swallow sounds, and a learner who cannot hear the words will assume their vocabulary is at fault.',
  ].join('\n');

  const { result } = await claudeJson({
    system,
    content: [{
      type: 'text',
      text: `Song: ${title}\nArtist / band: ${artist}\nLanguage the learner is studying: ${L.name}`,
    }],
    tool: SONG_TOOL,
    maxTokens: 6000,
    model: MODEL_GOOD, apiKey,
  });
  return result;
}

/* ---- vocabulary from a photo, a file, or pasted text ---- */

// A photo of a menu, a street sign, a page of a book, a screenshot. The model
// reads it, pulls out what is worth learning, and normalises everything to
// dictionary form — a sign says "AUSFAHRT", the glossary should say "die
// Ausfahrt". Anything it cannot actually read is left out rather than guessed
// at: a half-legible word turned into a confident wrong entry is the one
// failure that would quietly poison the glossary.
const EXTRACT_TOOL = {
  name: 'record_extraction',
  input_schema: {
    type: 'object',
    required: ['readable', 'vocabulary'],
    properties: {
      readable: { type: 'boolean', description: 'False if the image is too blurred, dark or cropped to read.' },
      kind: { type: 'string', description: 'What this appears to be: menu, street sign, book page, screenshot, worksheet, packaging...' },
      language: { type: 'string', description: 'Two-letter code of the language actually on the page.' },
      summary: { type: 'string', description: 'One sentence on what it is and what it says, in the interface language.' },
      transcript: {
        type: 'string',
        description: 'The text you can actually read, transcribed plainly. Short items only — do not transcribe a whole page of a book.',
      },
      vocabulary: {
        type: 'array',
        description: 'Up to 30 words and phrases worth learning, most useful first, in dictionary form.',
        items: {
          type: 'object',
          required: ['lemma', 'translations'],
          properties: {
            lemma: { type: 'string', description: 'Dictionary form, not the inflected form printed on the page.' },
            asSeen: { type: 'string', description: 'How it actually appeared, when that differs from the lemma.' },
            pos: { type: 'string' },
            translations: {
              type: 'object',
              required: ['pl', 'en'],
              properties: {
                pl: { type: 'array', items: { type: 'string' } },
                en: { type: 'array', items: { type: 'string' } },
              },
            },
            ipa: { type: 'string' },
            grammar: { type: 'object', additionalProperties: { type: 'string' } },
            example: {
              type: 'object',
              required: ['text'],
              properties: { text: { type: 'string' }, pl: { type: 'string' }, en: { type: 'string' } },
            },
            note: { type: 'string' },
            core: { type: 'boolean', description: 'True for everyday vocabulary, false for jargon specific to this context.' },
            uncertain: { type: 'boolean', description: 'True if you are not fully sure you read this correctly.' },
          },
        },
      },
      expressions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['expression', 'meaning'],
          properties: { expression: { type: 'string' }, meaning: { type: 'string' } },
        },
      },
      notes: { type: 'array', items: { type: 'string' }, description: 'Cultural or practical notes — how a menu is laid out, what a sign is telling you to do.' },
    },
  },
};

export async function extractVocabulary({ lang, images = [], text = '', uiLang = 'en', level = 'B1', apiKey }) {
  const L = LANG_PROMPTS[lang];
  if (!L) throw new AiError('bad_language', 400);
  if (!images.length && !text.trim()) throw new AiError('nothing_to_read', 400);

  const system = [
    `You pull ${L.name} vocabulary out of whatever the learner puts in front of you — a photo of a menu, a sign, a page, a screenshot, or plain text.`,
    `They are around CEFR ${level}. Write all explanations in ${uiLang === 'pl' ? 'Polish' : 'English'}.`,
    '',
    'Rules:',
    '- Read only what is actually there. If a word is blurred, cropped or ambiguous, either leave it out or set uncertain: true. Never fill a gap with a plausible guess.',
    '- If you cannot read the image at all, set readable to false and stop. Do not invent a lesson.',
    `- Normalise every entry to dictionary form. ${L.lemmaRule}`,
    '- Keep the printed form in asSeen when it differs, so the learner can match the entry to what they were looking at.',
    `- ${L.grammarInstruction}`,
    '- Skip proper nouns, prices, phone numbers and brand names unless they teach something.',
    `- If the text is not in ${L.name}, say so in summary and set language to what it really is. Extract it anyway if it is close enough to be useful.`,
    '- Example sentences are yours to write. Do not copy long runs of text off the page.',
  ].join('\n');

  // Images before text: Anthropic reads an image better when the question
  // follows it. Capped well under the point where per-image limits tighten.
  const content = images.slice(0, 4).map((data) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data },
  }));
  content.push({
    type: 'text',
    text: text.trim()
      ? `Text the learner supplied:\n\n${text.slice(0, 12_000)}`
      : 'Read the image or images above.',
  });

  const { result } = await claudeJson({
    system, content, tool: EXTRACT_TOOL, maxTokens: 6000, model: MODEL_GOOD, apiKey,
  });
  return result;
}

/* ---- end-of-session report ---- */

const REPORT_TOOL = {
  name: 'write_report',
  description: 'Summarise a spoken practice session.',
  input_schema: {
    type: 'object',
    required: ['summary', 'corrections', 'newWords'],
    properties: {
      summary: { type: 'string', description: 'Three sentences: what was practised, what went well, what to work on.' },
      level: { type: 'string', description: 'Rough CEFR impression from this session alone.' },
      corrections: {
        type: 'array',
        items: {
          type: 'object',
          required: ['said', 'better', 'why'],
          properties: {
            said: { type: 'string' },
            better: { type: 'string' },
            why: { type: 'string' },
          },
        },
      },
      newWords: {
        type: 'array',
        description: 'Words worth adding to the glossary, in dictionary form.',
        items: {
          type: 'object',
          required: ['term', 'gloss'],
          properties: { term: { type: 'string' }, gloss: { type: 'string' } },
        },
      },
      facts: {
        type: 'array',
        description: 'Durable things learnt about this person (job, city, interests) to remember for later sessions.',
        items: { type: 'string' },
      },
    },
  },
};

export async function sessionReport({ lang, transcript, uiLang = 'en', apiKey }) {
  const L = LANG_PROMPTS[lang];
  if (!L) throw new AiError('bad_language', 400);
  const system = [
    `You are reviewing a transcript of a spoken ${L.name} practice session.`,
    `Write to the learner in ${uiLang === 'pl' ? 'Polish' : 'English'}.`,
    'Only report mistakes that are actually in the transcript. Do not invent errors to seem thorough,',
    'and do not correct things that are simply informal speech.',
    'The transcript comes from speech recognition, so ignore obvious mis-transcriptions and punctuation.',
    'Never comment on pronunciation: you are reading text and cannot hear it.',
  ].join('\n');

  const { result } = await claudeJson({
    system,
    content: [{ type: 'text', text: transcript.slice(0, 40_000) }],
    tool: REPORT_TOOL,
    maxTokens: 2000, apiKey,
  });
  return result;
}

/* ═══ OpenAI ═════════════════════════════════════════════════════════════ */

// A short-lived client secret, so the browser can open the WebRTC session
// directly without ever holding the real key.
export async function realtimeSession({ lang, instructions, voice, tools, apiKey }) {
  if (!apiKey) throw new AiError('no_key', 503);

  const res = await fetch(`${OPENAI}/realtime/client_secrets`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'realtime',
        model: REALTIME_MODEL,
        instructions,
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe', language: lang },
            turn_detection: { type: 'semantic_vad', create_response: true, interrupt_response: true },
          },
          output: { voice: voice || 'cedar', speed: 1.0 },
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AiError('realtime_error', 502, text.slice(0, 400));
  }
  const data = await res.json();
  return { clientSecret: data.value || data.client_secret?.value, expiresAt: data.expires_at, model: REALTIME_MODEL };
}

// Single-word playback for the glossary. Separate from the conversation: it
// has to be able to say a word slowly and syllable by syllable for drilling,
// which a conversational voice will not do on request.
export async function speak({ lang, text, slow = false, voice, apiKey }) {
  if (!apiKey) throw new AiError('no_key', 503);
  const L = LANG_PROMPTS[lang];
  if (!L) throw new AiError('bad_language', 400);

  const instructions = slow
    ? `Speak in ${L.name} with a flawless native ${L.accent} accent. Say it slowly and very clearly, separating the syllables, as a teacher demonstrating pronunciation to a beginner. Do not sound robotic — keep it natural, just deliberate.`
    : `Speak in ${L.name} with a flawless native ${L.accent} accent, at a natural conversational pace.`;

  const res = await fetch(`${OPENAI}/audio/speech`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: voice || L.voice,
      input: String(text).slice(0, 600),
      instructions,
      response_format: 'mp3',
      speed: slow ? 0.75 : 1.0,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new AiError('tts_error', 502, t.slice(0, 300));
  }
  return Buffer.from(await res.arrayBuffer());
}

/* ═══ handwriting recognition ════════════════════════════════════════════
   Google's Input Tools ink endpoint is undocumented but free, keyless, fast
   and covers every script here. It is deliberately behind this one function so
   it can be swapped out without the whiteboard noticing — it has no contract
   and could disappear. Called from the server so a failure is invisible to the
   client and so its absence never blocks the Claude critique.                */

export async function recogniseInk({ lang, ink, width, height }) {
  const body = {
    options: 'enable_pre_space',
    requests: [{
      writing_guide: { writing_area_width: width, writing_area_height: height },
      ink,
      language: lang,
    }],
  };
  try {
    const res = await fetch('https://inputtools.google.com/request?itc=' +
      encodeURIComponent(`${lang}-t-i0-handwrit`) + '&app=lingvisto', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    // Shape is ["SUCCESS", [[id, [candidates...], ...]]]. An unreadable
    // scribble returns SUCCESS with an empty candidate list, and a bad
    // language code returns ["INVALID_INPUT_METHOD_NAME"] with HTTP 200 —
    // so the arrays are checked, never the status string.
    if (!Array.isArray(data) || data[0] !== 'SUCCESS') return [];
    const candidates = data[1]?.[0]?.[1];
    return Array.isArray(candidates) ? candidates.slice(0, 5) : [];
  } catch {
    return [];
  }
}

export { AiError };

/* ---- text chat with the same tutor ---- */

// The written half of the tutor. Same persona and the same glossary awareness
// as the spoken one, and the same tools — so "add that word" works whether it
// is said out loud or typed. Tools execute on the client, so this returns the
// calls rather than running them, and the client posts the results back.
export async function chat({ lang, messages, system, tools = [], apiKey, model = MODEL_GOOD }) {
  if (!apiKey) throw new AiError('no_key', 503);
  if (!LANG_PROMPTS[lang]) throw new AiError('bad_language', 400);

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      system,
      messages,
      ...(tools.length ? { tools } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AiError('model_error', res.status === 429 ? 429 : 502, text.slice(0, 400));
  }
  const data = await res.json();
  return {
    text: (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim(),
    toolCalls: (data.content || [])
      .filter((c) => c.type === 'tool_use')
      .map((c) => ({ id: c.id, name: c.name, input: c.input })),
    stopReason: data.stop_reason,
    raw: data.content || [],
  };
}

/* ---- what to write next ---- */

const TASK_TOOL = {
  name: 'set_writing_task',
  description: 'Give the learner one concrete thing to write by hand.',
  input_schema: {
    type: 'object',
    required: ['task', 'expect', 'mode'],
    properties: {
      task: {
        type: 'string',
        description: 'The instruction, in the interface language. One sentence, concrete and unambiguous.',
      },
      spoken: {
        type: 'string',
        description: 'The same instruction phrased for reading aloud — no parentheses or punctuation tricks.',
      },
      expect: {
        type: 'string',
        description: 'What a correct answer looks like, in the target language. If several are right, give the most natural.',
      },
      alternatives: { type: 'array', items: { type: 'string' }, description: 'Other fully correct answers.' },
      mode: { type: 'string', enum: ['letter', 'word', 'phrase', 'sentence'] },
      hint: { type: 'string', description: 'One nudge, shown only if they ask.' },
      targetWords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glossary words this task is meant to exercise.',
      },
      why: { type: 'string', description: 'One clause on why this task now — what it is practising.' },
    },
  },
};

export async function writingTask({
  lang, uiLang = 'en', level = 'B1', topic = '', glossary = [], dueWords = [],
  recent = [], struggles = [], apiKey,
}) {
  const L = LANG_PROMPTS[lang];
  if (!L) throw new AiError('bad_language', 400);

  const system = [
    `You set handwriting exercises for someone learning ${L.name} at around CEFR ${level}.`,
    `Write the instruction in ${uiLang === 'pl' ? 'Polish' : 'English'}; what they write will be in ${L.name}.`,
    '',
    'What makes a good task here:',
    '- It must be writable by hand in under a minute. One word, a phrase, or one short sentence — never a paragraph.',
    '- It must have a checkable answer. "Write something about your day" cannot be marked; "Write: I am going to the station" can.',
    '- Prefer words already in their glossary, and especially ones due for review — writing a word is the strongest way to fix it.',
    '- Vary the shape. Do not set five translation tasks in a row; mix translating, completing, answering a question, and writing from a description.',
    `- ${L.handwritingNotes}`,
    '- Build on what they just got wrong. If they mangled a letterform or missed an accent, set something that needs it again — but do not make it obvious you are drilling them.',
    '- Never repeat a task they have just done.',
  ].join('\n');

  const facts = [];
  if (topic) facts.push(`They want to work on: ${topic}. Keep the task within that.`);
  if (dueWords.length) facts.push(`Due for review today: ${dueWords.slice(0, 20).join(', ')}`);
  if (glossary.length) facts.push(`In their glossary: ${glossary.slice(0, 60).join(', ')}`);
  if (recent.length) facts.push(`Already set this session, do not repeat: ${recent.slice(-6).join(' | ')}`);
  if (struggles.length) facts.push(`They have just had trouble with: ${struggles.slice(-5).join('; ')}`);
  if (!glossary.length && !topic) {
    facts.push('Their glossary is empty, so use common everyday vocabulary at their level.');
  }

  const { result } = await claudeJson({
    system,
    content: [{ type: 'text', text: facts.join('\n') || 'Set an opening task.' }],
    tool: TASK_TOOL,
    maxTokens: 900,
    model: MODEL_FAST,
    apiKey,
  });
  return result;
}
