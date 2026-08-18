// Everything the app needs to know about a target language in one place: how it
// is spoken, how it is typed, how it is written by hand, and which grammatical
// facts a dictionary entry has to carry. Adding a fourth language means adding
// one object here.

export const LANGS = {
  de: {
    code: 'de',
    bcp47: 'de-DE',
    name: { en: 'German', pl: 'Niemiecki' },
    endonym: 'Deutsch',
    dir: 'ltr',
    // Voices that actually sound like a native speaker of the standard variety.
    voice: { openai: 'cedar', fallbackLangPrefix: 'de' },
    // Shown on the tutor screen so the learner knows what accent is being modelled.
    accent: { en: 'Standard German (Hochdeutsch)', pl: 'Niemiecki standardowy (Hochdeutsch)' },

    keyboard: {
      layout: 'qwertz',
      rows: [
        ['q', 'w', 'e', 'r', 't', 'z', 'u', 'i', 'o', 'p', 'ü'],
        ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ö', 'ä'],
        ['shift', 'y', 'x', 'c', 'v', 'b', 'n', 'm', 'backspace'],
      ],
      // Held down, these open a popover. ß has no capital in normal use, so
      // shift maps it to the uppercase ẞ only when the learner asks for it.
      accents: {
        s: ['ß', 'ẞ'],
        a: ['ä', 'à', 'á', 'â'],
        o: ['ö', 'ô', 'ó'],
        u: ['ü', 'ù', 'ú', 'û'],
        e: ['é', 'è', 'ê', 'ë'],
        c: ['ç'],
      },
      // Keys the learner will reach for constantly, promoted to the number row.
      quick: ['ä', 'ö', 'ü', 'ß'],
    },

    // Letters whose handwritten form the tutor should watch for.
    script: {
      kind: 'latin',
      extra: ['ä', 'ö', 'ü', 'ß'],
      handwritingNotes: {
        en: 'Umlaut dots must be clearly two separate dots, not a bar or a tilde. ß is a single letter — a long s joined to a z — not "B" and not "ss" written together. Capital letters begin every noun.',
        pl: 'Kropki umlautu muszą być wyraźnie dwiema kropkami, nie kreską ani tyldą. ß to jedna litera — długie s połączone z z — nie „B” ani „ss”. Każdy rzeczownik zaczyna się wielką literą.',
      },
    },

    // Fields the glossary asks the model to fill for this language.
    grammar: {
      pos: ['noun', 'verb', 'adjective', 'adverb', 'preposition', 'conjunction', 'pronoun', 'numeral', 'phrase'],
      fields: [
        { key: 'article', appliesTo: ['noun'], label: { en: 'Article', pl: 'Rodzajnik' }, hint: 'der / die / das' },
        { key: 'plural', appliesTo: ['noun'], label: { en: 'Plural', pl: 'Liczba mnoga' }, hint: 'die Häuser' },
        { key: 'genitive', appliesTo: ['noun'], label: { en: 'Genitive', pl: 'Dopełniacz' }, hint: 'des Hauses' },
        { key: 'principalParts', appliesTo: ['verb'], label: { en: 'Principal parts', pl: 'Formy podstawowe' }, hint: 'gehen — ging — ist gegangen' },
        { key: 'separable', appliesTo: ['verb'], label: { en: 'Separable prefix', pl: 'Rozdzielny przedrostek' }, hint: 'an|rufen' },
        { key: 'caseGoverned', appliesTo: ['verb', 'preposition'], label: { en: 'Takes case', pl: 'Wymaga przypadka' }, hint: 'mit + Dativ' },
        { key: 'comparative', appliesTo: ['adjective'], label: { en: 'Comparative', pl: 'Stopień wyższy' }, hint: 'gut — besser — am besten' },
      ],
      // Told to the model so it normalises to the form a dictionary would list.
      lemmaRule: 'Nouns: nominative singular, capitalised, with its definite article. Verbs: infinitive. Adjectives: uninflected base form.',
    },

    pronunciation: {
      focus: {
        en: ['ch in "ich" vs "Bach"', 'the uvular r', 'ö and ü rounding', 'final devoicing (Tag sounds like "Tak")', 'the glottal stop before initial vowels'],
        pl: ['ch w „ich” a „Bach”', 'r języczkowe', 'zaokrąglenie ö i ü', 'ubezdźwięcznienie w wygłosie (Tag brzmi „Tak”)', 'zwarcie krtaniowe przed samogłoską nagłosową'],
      },
      // Traps specific to a Polish speaker; the tutor is told to listen for these.
      l1Traps: {
        pl: 'A Polish speaker typically substitutes Polish [x] for both ch sounds, rolls the r on the tongue tip instead of the uvula, unrounds ü to i and ö to e, and misses the initial glottal stop so "ein Ei" runs together.',
        en: 'Speakers of Slavic languages typically use a single [x] for both ch sounds, trill the r, unround ü and ö, and omit the glottal stop before initial vowels.',
      },
    },
  },

  ru: {
    code: 'ru',
    bcp47: 'ru-RU',
    name: { en: 'Russian', pl: 'Rosyjski' },
    endonym: 'Русский',
    dir: 'ltr',
    voice: { openai: 'marin', fallbackLangPrefix: 'ru' },
    accent: { en: 'Standard Moscow Russian', pl: 'Rosyjski standardowy (moskiewski)' },

    keyboard: {
      layout: 'jcuken',
      rows: [
        ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х'],
        ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
        ['shift', 'я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', 'backspace'],
      ],
      accents: {
        е: ['ё'],
        ь: ['ъ'],
        // Stress marks are combining acutes; the glossary uses them constantly.
        а: ['а́'], о: ['о́'], и: ['и́'], у: ['у́'], ы: ['ы́'], э: ['э́'], ю: ['ю́'], я: ['я́'],
      },
      quick: ['ё', 'ъ', '́'],
      // Optional assist: type Latin, get Cyrillic. Longest keys first so that
      // "shch" beats "sh" beats "s".
      translit: {
        enabled: true,
        map: {
          shch: 'щ', sch: 'щ', yo: 'ё', zh: 'ж', kh: 'х', ts: 'ц', ch: 'ч', sh: 'ш',
          yu: 'ю', ya: 'я', ye: 'е', eh: 'э', "'": 'ь', '"': 'ъ',
          a: 'а', b: 'б', v: 'в', g: 'г', d: 'д', e: 'е', z: 'з', i: 'и', j: 'й',
          k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', r: 'р', s: 'с', t: 'т',
          u: 'у', f: 'ф', h: 'х', c: 'ц', y: 'ы', ',': ',', '.': '.', ' ': ' ',
        },
      },
    },

    script: {
      kind: 'cyrillic',
      // Cyrillic cursive is a different alphabet to learn, not a style of the
      // printed one, so the whiteboard teaches both forms explicitly.
      hasDistinctCursive: true,
      handwritingNotes: {
        en: 'Russian cursive is not printed Cyrillic joined up — several letters change shape entirely. Handwritten т looks like a Latin m, д like a Latin g or a looped d, и like a Latin u, and п like a Latin n. The sequence ишиш becomes a row of identical humps, which is why л and м start with a hook and ш is often underlined. Capital letters are largely their printed shapes.',
        pl: 'Rosyjska kursywa to nie połączone litery drukowane — kilka zmienia kształt całkowicie. Pisane т wygląda jak łacińskie m, д jak łacińskie g lub pętelkowe d, и jak łacińskie u, a п jak łacińskie n. Ciąg ишиш to rząd identycznych garbków — dlatego л i м zaczynają się haczykiem, a ш bywa podkreślane.',
      },
      // Letters a learner most often draws as the wrong shape.
      trickyCursive: ['т', 'д', 'и', 'п', 'ш', 'щ', 'л', 'м', 'з', 'э', 'ф'],
    },

    grammar: {
      pos: ['noun', 'verb', 'adjective', 'adverb', 'preposition', 'conjunction', 'pronoun', 'numeral', 'particle', 'phrase'],
      fields: [
        { key: 'stress', appliesTo: ['*'], label: { en: 'Stress', pl: 'Akcent' }, hint: 'молоко́' },
        { key: 'gender', appliesTo: ['noun'], label: { en: 'Gender', pl: 'Rodzaj' }, hint: 'м / ж / ср' },
        { key: 'genitiveSg', appliesTo: ['noun'], label: { en: 'Genitive sg.', pl: 'Dopełniacz lp.' }, hint: 'стола́' },
        { key: 'nominativePl', appliesTo: ['noun'], label: { en: 'Nominative pl.', pl: 'Mianownik lm.' }, hint: 'столы́' },
        { key: 'aspectPair', appliesTo: ['verb'], label: { en: 'Aspect pair', pl: 'Para aspektowa' }, hint: 'де́лать / сде́лать' },
        { key: 'conjugation', appliesTo: ['verb'], label: { en: 'Conjugation', pl: 'Koniugacja' }, hint: 'я делаю, ты делаешь' },
        { key: 'caseGoverned', appliesTo: ['verb', 'preposition'], label: { en: 'Takes case', pl: 'Wymaga przypadka' }, hint: 'с + твор.' },
      ],
      lemmaRule: 'Nouns: nominative singular. Verbs: infinitive, given as an imperfective/perfective pair. Adjectives: masculine nominative singular. Always mark the stressed vowel with a combining acute.',
    },

    pronunciation: {
      focus: {
        en: ['vowel reduction — unstressed о sounds like а', 'hard vs soft (palatalised) consonants', 'ы as distinct from и', 'the dark л', 'stress placement, which moves and changes meaning'],
        pl: ['redukcja samogłosek — nieakcentowane о brzmi jak а', 'spółgłoski twarde a miękkie (palatalizowane)', 'ы różne od и', 'twarde ł-owe л', 'ruchomy akcent zmieniający znaczenie'],
      },
      l1Traps: {
        pl: 'A Polish speaker usually pronounces every о as written instead of reducing it, transfers Polish fixed penultimate stress onto Russian words, reads ы as Polish y (which is close but not identical), and softens consonants in the Polish pattern rather than the Russian one. Polish ł is not Russian л.',
        en: 'Learners typically fail to reduce unstressed vowels, put the stress on the wrong syllable, merge ы with и, and use a light l instead of the dark л.',
      },
    },
  },

  it: {
    code: 'it',
    bcp47: 'it-IT',
    name: { en: 'Italian', pl: 'Włoski' },
    endonym: 'Italiano',
    dir: 'ltr',
    voice: { openai: 'alloy', fallbackLangPrefix: 'it' },
    accent: { en: 'Standard Italian', pl: 'Włoski standardowy' },

    keyboard: {
      layout: 'qwerty',
      rows: [
        ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
        ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
        ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'backspace'],
      ],
      accents: {
        a: ['à'],
        e: ['è', 'é'],
        i: ['ì', 'í'],
        o: ['ò', 'ó'],
        u: ['ù', 'ú'],
      },
      quick: ['à', 'è', 'é', 'ì', 'ò', 'ù'],
    },

    script: {
      kind: 'latin',
      extra: ['à', 'è', 'é', 'ì', 'ò', 'ù'],
      handwritingNotes: {
        en: 'Italian uses only grave accents on à ì ò ù, and both grave and acute on e — è (open, "is") versus é (closed, "perché"). The accent leans left; an acute where a grave belongs is a spelling error, not a slip of the pen.',
        pl: 'Włoski używa tylko akcentu grawis na à ì ò ù, a na e obu: è (otwarte, „jest”) i é (zamknięte, „perché”). Kreska pochyla się w lewo; akut zamiast grawisu to błąd ortograficzny, nie potknięcie pióra.',
      },
    },

    grammar: {
      pos: ['noun', 'verb', 'adjective', 'adverb', 'preposition', 'conjunction', 'pronoun', 'numeral', 'phrase'],
      fields: [
        { key: 'article', appliesTo: ['noun'], label: { en: 'Article', pl: 'Rodzajnik' }, hint: 'il / lo / la / l’' },
        { key: 'gender', appliesTo: ['noun', 'adjective'], label: { en: 'Gender', pl: 'Rodzaj' }, hint: 'm / f' },
        { key: 'plural', appliesTo: ['noun', 'adjective'], label: { en: 'Plural', pl: 'Liczba mnoga' }, hint: 'i libri' },
        { key: 'conjugation', appliesTo: ['verb'], label: { en: 'Conjugation', pl: 'Koniugacja' }, hint: '-are / -ere / -ire' },
        { key: 'irregular', appliesTo: ['verb'], label: { en: 'Irregular forms', pl: 'Formy nieregularne' }, hint: 'vado, vai, va…' },
        { key: 'auxiliary', appliesTo: ['verb'], label: { en: 'Auxiliary', pl: 'Czasownik posiłkowy' }, hint: 'essere / avere' },
        { key: 'pastParticiple', appliesTo: ['verb'], label: { en: 'Past participle', pl: 'Imiesłów przeszły' }, hint: 'fatto' },
      ],
      lemmaRule: 'Nouns: masculine or feminine singular with its definite article. Verbs: infinitive. Adjectives: masculine singular.',
    },

    pronunciation: {
      focus: {
        en: ['double consonants really are held longer — "nono" is not "nonno"', 'open vs closed e and o', 'gli and gn', 'c and g before e/i versus a/o/u', 'no aspiration on p, t, k', 'clean unreduced final vowels'],
        pl: ['podwojone spółgłoski naprawdę trwają dłużej — „nono” to nie „nonno”', 'otwarte i zamknięte e oraz o', 'gli i gn', 'c i g przed e/i a przed a/o/u', 'brak przydechu przy p, t, k', 'wyraźne, niezredukowane samogłoski w wygłosie'],
      },
      l1Traps: {
        pl: 'A Polish speaker usually shortens Italian double consonants to single ones, devoices final consonants, and reads gli as Polish "gli" rather than a palatal ly. Polish stress on the penultimate syllable happens to match Italian most of the time, which hides the words where it does not.',
        en: 'Learners typically shorten geminate consonants, aspirate p/t/k, and reduce unstressed final vowels to schwa.',
      },
    },
  },
};

export const LANG_CODES = Object.keys(LANGS);

export const getLang = (code) => LANGS[code] || LANGS.de;

// Interface languages, kept separate from the languages being learnt.
export const UI_LANGS = {
  en: { name: 'English', bcp47: 'en-GB' },
  pl: { name: 'Polski', bcp47: 'pl-PL' },
};

/* ---------- transliteration ---------- */

// Greedily rewrite a Latin string into the target script. Used only by the
// Russian keyboard's assist mode; returns the input unchanged for languages
// that have no map.
export function transliterate(code, text) {
  const t = LANGS[code]?.keyboard?.translit;
  if (!t?.enabled) return text;
  const keys = Object.keys(t.map).sort((a, b) => b.length - a.length);
  let out = '';
  let i = 0;
  outer: while (i < text.length) {
    for (const k of keys) {
      const slice = text.slice(i, i + k.length);
      if (slice.toLowerCase() === k) {
        const rep = t.map[k];
        // Preserve the case the learner typed.
        out += slice[0] === slice[0].toUpperCase() && slice[0] !== slice[0].toLowerCase()
          ? rep.charAt(0).toUpperCase() + rep.slice(1)
          : rep;
        i += k.length;
        continue outer;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/* ---------- text helpers ---------- */

const COMBINING_ACUTE = '́';

// Russian words are stored with stress marks so the tutor can show them, but
// they must never be sent to a dictionary lookup or compared against typed input.
export const stripStress = (s) => String(s || '').split(COMBINING_ACUTE).join('');

// Which syllable carries the stress, 0-indexed by vowel. -1 when unmarked.
export function stressIndex(word) {
  const vowels = 'аеёиоуыэюяaeiouäöüàèéìòù';
  let vi = -1;
  const chars = [...String(word || '')];
  for (let i = 0; i < chars.length; i++) {
    if (vowels.includes(chars[i].toLowerCase())) vi += 1;
    if (chars[i] === COMBINING_ACUTE) return vi;
  }
  return -1;
}

// Compare what the learner typed against the stored form, forgiving the things
// that are not the point of the exercise: stress marks, case, and stray spaces.
export function looseEqual(a, b) {
  const norm = (s) =>
    stripStress(String(s || ''))
      .normalize('NFC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[.,!?;:¡¿"“”„«»]/g, '')
      .trim();
  return norm(a) === norm(b);
}
