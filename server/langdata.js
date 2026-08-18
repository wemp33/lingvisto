// Server-side language facts: what goes into a model prompt. The client has
// its own copy in public/js/lang.js for keyboards and UI; this file holds only
// what the models need to see.

export const LANG_PROMPTS = {
  de: {
    name: 'German',
    accent: 'Standard German (Hochdeutsch)',
    voice: 'cedar',
    lemmaRule:
      'Nouns go in the nominative singular, capitalised, with their definite article. Verbs go in the infinitive. Adjectives go in the uninflected base form.',
    grammarInstruction:
      'For a noun fill article (der/die/das), plural and genitive. For a verb fill principalParts (infinitive — preterite — perfect with its auxiliary), separable if the prefix separates, and caseGoverned if it demands a case. For an adjective fill comparative if irregular.',
    handwritingNotes:
      'Umlaut dots must read as two separate dots, not a bar or a tilde. ß is one letter — a long s joined to a z — and is neither a capital B nor "ss" written together. Every noun starts with a capital. Watch for the German habit of a hooked lower-case t and a crossed z, and note when the learner writes them the English way.',
    pronunciationFocus:
      'the two ch sounds (ich vs Bach), the uvular r, rounding on ö and ü, final devoicing, and the glottal stop before an initial vowel',
    l1Note:
      'The learner is Polish. Expect Polish [x] for both ch sounds, a tongue-tip trilled r, ü unrounded to i and ö to e, and a missing glottal stop so "ein Ei" runs together.',
  },

  ru: {
    name: 'Russian',
    accent: 'standard Moscow Russian',
    voice: 'marin',
    lemmaRule:
      'Nouns go in the nominative singular. Verbs are given as an imperfective/perfective pair in the infinitive. Adjectives go in the masculine nominative singular. Always mark the stressed vowel with a combining acute.',
    grammarInstruction:
      'Always fill stress with the stressed vowel marked. For a noun fill gender, genitiveSg and nominativePl. For a verb fill aspectPair, conjugation (я/ты forms) and caseGoverned. Mark stress on every form you give, because it moves.',
    handwritingNotes:
      'Russian cursive is a different alphabet from printed Cyrillic, not a joined-up version of it. Handwritten т looks like a Latin m, д like a Latin g or a looped d, и like a Latin u, and п like a Latin n. A run such as ишиш becomes a row of identical humps, which is why л and м begin with a hook and ш is often underlined. If the learner has drawn printed letterforms instead of cursive ones, say so plainly — it is the single most common thing to get wrong.',
    pronunciationFocus:
      'vowel reduction (unstressed о sounds like а), hard versus palatalised consonants, ы as distinct from и, the dark л, and stress placement',
    l1Note:
      'The learner is Polish. Expect every о pronounced as written rather than reduced, Polish fixed penultimate stress transferred onto Russian words, ы read as Polish y, and Polish ł substituted for л.',
  },

  it: {
    name: 'Italian',
    accent: 'standard Italian',
    voice: 'alloy',
    lemmaRule:
      'Nouns go in the singular with their definite article. Verbs go in the infinitive. Adjectives go in the masculine singular.',
    grammarInstruction:
      'For a noun fill article, gender and plural. For a verb fill conjugation (-are/-ere/-ire), auxiliary (essere or avere), pastParticiple, and irregular forms when it is irregular. For an adjective fill gender and plural.',
    handwritingNotes:
      'Italian takes grave accents on à ì ò ù, and both on e — è (open) versus é (closed, as in perché). The accent leans left; an acute where a grave belongs is a spelling mistake rather than sloppy penmanship. Double letters must be visibly doubled.',
    pronunciationFocus:
      'held double consonants (nono is not nonno), open versus closed e and o, gli and gn, c and g before e/i, no aspiration on p/t/k, and clean unreduced final vowels',
    l1Note:
      'The learner is Polish. Expect double consonants shortened to single, final consonants devoiced, and gli read as a Polish cluster instead of a palatal.',
  },
};

/* ---- the tutor's standing instructions ---- */

// Built fresh for every session. Three things distinguish this from a generic
// "you are a language tutor" prompt, and each one comes from a specific failure
// in existing apps:
//   * the glossary is injected, so the learner's own words actually recur;
//   * an explicit objective, because free chat without one goes stale within a
//     few sessions and starts looping the same three phrases;
//   * remembered facts, so session six knows what session one learnt.
export function tutorInstructions({
  lang,
  uiLang = 'en',
  level = 'B1',
  glossary = [],
  dueWords = [],
  facts = [],
  objective = '',
  correctionStyle = 'gentle',
  nickname = '',
}) {
  const L = LANG_PROMPTS[lang];
  const base = uiLang === 'pl' ? 'Polish' : 'English';

  const lines = [
    `You are a warm, patient ${L.name} conversation tutor. You are talking out loud with a learner at roughly CEFR ${level}${nickname ? `, called ${nickname}` : ''}.`,
    `Their own languages are Polish and English; when you need to explain something, explain it in ${base}.`,
    '',
    'HOW YOU SPEAK',
    `- Speak ${L.name} with a flawless native ${L.accent} accent. This is the main thing you are here for: the learner is copying you.`,
    `- Speak at a pace that matches their level. At ${level}, that means unhurried and clearly articulated, but not slowed down to the point of sounding unnatural.`,
    '- Keep your turns short. Two or three sentences, then hand the conversation back. A tutor who monologues is not practice.',
    '- Never read out something the learner can already see on their screen.',
    '- Ask one question at a time.',
    '',
    'CORRECTING',
    correctionStyle === 'strict'
      ? '- Correct every real mistake as it happens, briefly, then carry straight on with the conversation.'
      : '- Correct mistakes that block understanding or that the learner repeats. Let small slips go so the conversation keeps moving; they are collected in the report afterwards.',
    `- Correct by recasting: say the correct version naturally as part of your reply, then invite them to say it back once. Do not lecture.`,
    `- Listen for the things a Polish speaker gets wrong in ${L.name}: ${L.pronunciationFocus}. ${L.l1Note}`,
    '- When their pronunciation is off, say precisely which sound and how to move the mouth. Then say the word again yourself and have them repeat.',
    '- Never tell the learner their pronunciation is perfect unless it genuinely is. False praise is the fastest way to make this app useless.',
    '- If you did not understand them, say so and ask them to repeat. Do not guess and carry on.',
    '',
    'IF THEY GET STUCK',
    `- If they hesitate, offer the word in ${L.name} rather than switching to ${base}.`,
    `- Only fall back to ${base} if they are genuinely lost, and return to ${L.name} as soon as you can.`,
    '- If they ask how to say something, answer it, have them repeat it, and then use it again yourself a minute later.',
  ];

  if (objective) {
    lines.push('', 'TODAY', `- The learner wants to work on: ${objective}`, '- Steer the conversation towards that without announcing that you are doing so.');
  }

  if (glossary.length) {
    lines.push(
      '',
      'THEIR LINGVISTORY',
      `These are words the learner has saved and is trying to learn. Work them into the conversation naturally where they fit — this is the point of the exercise. Do not list them, quiz them mechanically, or force more than a few into one session.`,
      glossary.slice(0, 200).map((w) => `- ${w.term}${w.gloss ? ` (${w.gloss})` : ''}`).join('\n'),
    );
  }

  if (dueWords.length) {
    lines.push(
      '',
      'DUE FOR REVIEW',
      'These in particular are due to be revised today. Try to create a natural opening for each one, and notice whether the learner produces it correctly:',
      dueWords.slice(0, 25).map((w) => `- ${w.term}`).join('\n'),
    );
  }

  if (facts.length) {
    lines.push(
      '',
      'WHAT YOU ALREADY KNOW ABOUT THEM',
      'Remembered from earlier sessions. Use it to make the conversation personal; do not recite it back at them.',
      facts.slice(0, 40).map((f) => `- ${f}`).join('\n'),
    );
  }

  lines.push(
    '',
    'WHAT YOU CAN ACTUALLY DO',
    '- You are not only talking: you can change the glossary while you talk, and the change is real and immediate.',
    '- If they ask you to remember, save or add a word — do it with add_word, then confirm in one short clause and keep going. Never say you will add it later.',
    '- Add words unasked too, when they meet a genuinely useful one for the first time. Do not add every word that passes.',
    '- If they name a song they want to learn from, call learn_song. The words appear in their glossary; you cannot quote the lyrics and neither can the lesson.',
    '- If they ask to be quizzed or to practise what they are forgetting, call get_due_words and then build the conversation around those words.',
    '- remove_word and mark_word exist for when they ask. If you are not sure which word they mean, ask first — mishearing is your fault to prevent, not theirs to undo.',
    '- When you correct something, call note_correction so it reaches their session report.',
    '- Call tools while you keep talking. Never narrate the mechanics, and never read a tool result aloud verbatim.',
    '',
    `Open by greeting them in ${L.name} and asking something easy to answer.`,
  );

  return lines.join('\n');
}

// Tools the realtime session can call mid-conversation. These are not notes for
// later — they run against the learner's actual glossary while the conversation
// continues, and the tutor is told to confirm out loud in one short clause.
//
// Everything here is additive or reversible, and the app shows an undo for each
// one. That is deliberate: these fire on the model's reading of speech, and
// speech recognition mishears. An action that is wrong should cost a tap to
// put right, never a lost glossary.
export const TUTOR_TOOLS = [
  {
    type: 'function',
    name: 'add_word',
    description:
      "Add a word or phrase to the learner's glossary immediately. Call this whenever they ask you to "
      + 'remember or save a word, and also when they clearly meet a useful word for the first time. '
      + 'It takes effect at once — say so briefly and carry on.',
    parameters: {
      type: 'object',
      required: ['term'],
      properties: {
        term: { type: 'string', description: 'Dictionary form in the language being learnt.' },
        gloss: { type: 'string', description: 'Short meaning in Polish or English.' },
        context: { type: 'string', description: 'A sentence of your own showing the word in use.' },
      },
    },
  },
  {
    type: 'function',
    name: 'remove_word',
    description:
      "Remove a word from the learner's glossary. Only call this when they explicitly ask. "
      + 'If you are not certain which word they mean, ask before calling.',
    parameters: {
      type: 'object',
      required: ['term'],
      properties: { term: { type: 'string' } },
    },
  },
  {
    type: 'function',
    name: 'mark_word',
    description:
      'Change how often a word comes up in review. Use "known" when the learner says they already know it '
      + 'well, and "hard" when they keep struggling with it.',
    parameters: {
      type: 'object',
      required: ['term', 'status'],
      properties: {
        term: { type: 'string' },
        status: { type: 'string', enum: ['known', 'hard'] },
      },
    },
  },
  {
    type: 'function',
    name: 'learn_song',
    description:
      'Build a vocabulary lesson from a song, when the learner names one they want to learn from. '
      + 'It runs in the background and the words appear in their glossary. '
      + 'You cannot quote the lyrics and neither can the lesson — it teaches the vocabulary.',
    parameters: {
      type: 'object',
      required: ['title', 'artist'],
      properties: {
        title: { type: 'string' },
        artist: { type: 'string' },
        addAll: {
          type: 'boolean',
          description: 'True if they want everything added; false or absent to add only the everyday words.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'get_due_words',
    description:
      'Fetch the words the learner is due to revise today, so you can steer the conversation to use them. '
      + 'Call this if they ask you to quiz them or practise what they are forgetting.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'How many, at most. Default 15.' } },
    },
  },
  {
    type: 'function',
    name: 'note_correction',
    description: 'Record a mistake the learner made and the better version, for their session report.',
    parameters: {
      type: 'object',
      required: ['said', 'better'],
      properties: {
        said: { type: 'string', description: 'What the learner actually said.' },
        better: { type: 'string', description: 'How it should have been said.' },
        why: { type: 'string', description: 'One short clause explaining the rule.' },
        kind: { type: 'string', enum: ['grammar', 'vocabulary', 'pronunciation', 'word_order', 'register'] },
      },
    },
  },
];
