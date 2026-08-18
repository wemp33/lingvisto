# Lingvisto

An AI language tutor you talk to, write for, and build a glossary with.
German, Russian and Italian, from English or Polish.

Installable to the iPhone and iPad home screen. Works offline; the account only
exists to carry your words between devices.

---

## What it does

**Talk** — a spoken conversation with a tutor that holds a native accent, over
OpenAI's Realtime API. It hears your actual audio rather than a transcript, so
it can coach pronunciation, and you can interrupt it mid-sentence. It knows the
words in your glossary and works them into the conversation. Words it catches
mid-conversation land in your glossary; corrections land in a report afterwards.

**Words** — your own glossary. Type a word and it is checked before it is
stored: normalised to dictionary form, with article and plural for German,
stress mark and aspect pair for Russian, gender and auxiliary for Italian, plus
IPA, translations and an example sentence. Nothing is saved until you have seen
what changed and agreed to it.

**Write** — a whiteboard built for Apple Pencil, with a tutor that reads what
you wrote and says what is wrong with it — letterform, spelling, and for
Russian whether you drew printed letters where cursive belongs.

**Songs** — give it a title and a band and it builds a vocabulary lesson from
that song: the words worth learning in dictionary form, the idioms it uses,
the grammar it practises, and what to listen for when a singer swallows half a
syllable. Everyday vocabulary is separated from the poetic and archaic usage
songs are full of, so nobody starts speaking in lyrics. Pick what you want and
it joins the same glossary and the same review queue, tagged with where it came
from.

**Type instead of talk** — the same tutor, in writing, on the same screen. It
runs on Claude rather than the realtime model, so it needs no microphone and no
OpenAI key, and it has the same tools: "add that word" works whether you say it
or type it. With a voice session live, what you type goes into it and is
answered aloud, so the two stay one conversation.

**Photos and files** — point the camera at a menu, a street sign, a page of a
book or a screenshot, pick an image or text file, or paste text straight in.
The words come back in dictionary form with translations, keeping the printed
form alongside so you can match an entry to what you were looking at. Anything
the model could not read confidently arrives flagged and unticked.

**A writing coach** — it sets one thing to write, reads what you wrote, and
sets the next one in light of what actually happened. Tasks come from your
glossary and what is due, on a topic you choose or one it picks. The
instruction can be read aloud in your own language, so you hear the task and
produce the target language by hand.

**Review** — spaced repetition over four separate skills per word: recognising
it, producing it, saying it, and writing it by hand.

---

## Running it

```bash
npm install
node server/index.js
```

Requires Node 22+ and these environment variables:

| Variable | Required | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres. Railway provides this when you add the plugin. |
| `OPENAI_API_KEY` | no | Fallback for the talking tutor and word audio. Each user can set their own in Settings instead. |
| `ANTHROPIC_API_KEY` | no | Fallback for word checking, handwriting and song lessons. |
| `APP_SECRET` | recommended | Encrypts user-supplied API keys at rest. Generated and stored in the database if unset. |
| `PORT` | no | Defaults to 3000. |
| `ALLOWED_NICKNAMES` | no | Comma-separated allowlist. Empty means anyone can register. |

Keys are normally entered in the app itself, under **Settings → AI keys**. They
are verified against the provider before being stored, encrypted with
AES-256-GCM, and never sent back to the browser — the settings screen only ever
shows the last four characters. The environment variables above are a fallback
for when you would rather one key serve everyone.

The app degrades rather than breaking: with no keys at all you can still add
words, write on the whiteboard and do reviews.

### Working on the interface

```bash
node tools/dev-static.mjs
```

Serves the client on <http://localhost:4173> with canned API responses — no
database, no keys, no network. The service worker deliberately does not
register on localhost, because serving assets cache-first makes every edit
appear to need two reloads.

### Deploying to Railway

Live at <https://lingvisto-production.up.railway.app> (project `glossa`,
service `lingvisto`).

Always pass `--service` and check `railway status` first: the CLI's linked
project can drift between commands, and an unqualified `railway add` will
happily create a service in whichever project it thinks it is pointing at.

1. `railway init` in this directory, then add a Postgres database to the project.
2. Set `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` as service variables.
   `DATABASE_URL` is injected by the Postgres plugin.
3. `railway up`.
4. Generate a domain, open it on the phone, and use **Share → Add to Home Screen**.

`railway.json` already sets the start command and a `/healthz` check.

### Tests

```bash
node tools/srs.test.mjs
```

Checks the FSRS-6 implementation against golden vectors generated from the
reference Python implementation. Regenerate them with `tools/gen-golden.py`
(needs `pip install fsrs`).

---

## How it is built

No framework and no build step. One dependency, `pg`. The client is plain ES
modules the browser loads directly.

```
server/     node:http, ~1 dependency
  auth.js       nickname + 6-digit code, scrypt, escalating lockout
  sync.js       last-write-wins record sync with a server-side cursor
  ai.js         OpenAI Realtime + TTS, Claude for everything written
  langdata.js   per-language prompt facts and the tutor's instructions
public/js/
  ink.js        the inking engine
  keyboard.js   in-app QWERTZ / ЙЦУКЕН / Italian keyboards
  srs.js        FSRS-6
  talk.js       the WebRTC session
  store.js      IndexedDB, offline-first, syncs when it can
```

---

## Decisions worth knowing about

These are the constraints that shaped the app. Most of them are not obvious and
cost real time to discover.

**iOS will not let a web page choose the keyboard.** There is no attribute, no
API, and no way even to *read* which keyboard is active — WebKit's
`FocusedElementInformation` carries no locale field at all. Asking the learner
to hit the globe key every time they type a German word is not a product, so
Lingvisto draws its own keyboards. They run on a real `<input>` with
`inputmode="none"`, which WebKit honours by keeping the system keyboard down
while the field keeps a genuine caret and native selection handles.
`autocorrect="off"` matters just as much: with an English keyboard active, iOS
will happily "fix" a foreign word and quietly corrupt the glossary.

**The Web Speech API cannot do this job on iOS.** Apple does not expose any of
the good downloaded voices to `speechSynthesis`, so a native accent cannot be
modelled with it at all, and separate open WebKit bugs break the
speak-then-listen loop outright. Hence a realtime WebRTC session instead.

**Audio must be started synchronously inside the tap.** iOS drops audio
initialised outside a user gesture with no error and no event, and an `<audio>`
sink attached after the network handshake loses the tutor's first sentence. So
the audio context, the silent unlock buffer, the audio session type, the sink
element and `getUserMedia` all happen before the first `await` in `connect()`.

**The tutor can act, not just talk.** Asking it out loud to save a word, drop
one, mark one as known, quiz you on what is due, or build a lesson from a song
all take effect immediately against the real glossary. Every action is additive
or reversible and shows an undo, because these fire on speech recognition and
speech recognition mishears. The tool result is fed back so the tutor confirms
what actually happened — if a word was not found it says so rather than
claiming it saved something.

**API keys live on the server, never in the browser.** They are encrypted at
rest, which protects against a database dump or a key in a log — not against
someone who already has the server and its secret. Keeping them off the client
is what preserves the ephemeral-token design: the real key never reaches a page
where injected script could read it.

**Read what is there, or admit you cannot.** Both the song and photo features
are told to answer "I could not read that" rather than produce a plausible
lesson, and to flag individual entries they are unsure of. A confident wrong
entry is the one failure that quietly poisons a glossary, because it is
indistinguishable from a correct one until you use it on a native speaker.
Photos are downscaled to 1568 px client-side — the model resizes above that
anyway, and on a phone connection the upload is most of the wait. The image is
sent to be read and never stored; only the words are kept.

**Songs teach vocabulary, not lyrics.** The song feature never reproduces the
words of a song — not a line, not a distinctive phrase. Vocabulary comes back
in dictionary form, idioms in their neutral form, and every example sentence is
one the model wrote about something else. That is partly because lyrics are not
ours to reproduce, but mostly because a lyric sheet is not a study artifact: you
cannot review a line of a song, whereas you can review `sich sehnen nach +
Dativ`. The model is also told to answer "I don't know this song" rather than
assemble a plausible lesson from the title, and to flag low confidence — a
fabricated lesson is worse than none.

**Never let the conversational model be the grader.** Audio models will assert
that plainly wrong articulation "closely matches a native speaker". The tutor
encourages; it does not score. Where the app cannot honestly grade something —
pronunciation — it plays the model audio and asks you to judge yourself rather
than inventing a number.

**Recognise handwriting first, critique second.** A vision model asked to read
ink and judge it in one step will critique a character it misread. A
handwriting recogniser goes first and its answer is handed to the model as
evidence.

**Apple Pencil does not work on any iPhone.** The whiteboard is iPad-first; the
phone gets a finger-drawing surface and is told why.

**What makes ink feel right**, in order: variable stroke width from real
pressure (a `lineTo` path is a constant-width noodle and no smoothing rescues
it); `getCoalescedEvents()`, because Pencil samples at 240 Hz while
`pointermove` fires at 60 and the rest is thrown away; a separate
`desynchronized` canvas for the wet stroke; and ignoring touch entirely once a
pen has been seen, because Safari will otherwise draw a line from your resting
palm to the pen tip.

**The schedule can be fitted to you.** After a few hundred reviews, *Settings →
Tune to my memory* refits the FSRS parameters to your own history by coordinate
descent on log loss, server-side. Three honesty rules make it worth trusting:
below 400 reviews it refuses and says how many more are needed, the tuned set is
only accepted if it beats the defaults on **held-out** cards, and if your
history already matches the standard schedule it says so rather than
manufacturing a change. On a synthetic learner who forgets faster than average
it recovers a 6.7% improvement in held-out predictions; on an average one it
leaves the defaults alone.

**Load is balanced, not just fuzzed.** Fuzz scatters due dates at random, which
still lets three cards land on a day that already has eighty. New due dates are
placed on the quietest day within a small window instead, which flattens the
daily load without moving anything far enough to matter to memory. A 200-card
day is what makes people quit.

**FSRS-6 is ported from the reference, not approximated.** The difficulty
mean-reversion target is computed *unclamped* and evaluates to −4.7716;
clamping it to [1, 10] is the standard porting mistake and diverges silently
over months. `tools/srs.test.mjs` checks the port against golden vectors from
`py-fsrs`.

**Four cards per word is a real cost.** Twenty new words a day is eighty new
cards a day, which becomes hundreds of daily reviews within a month. The
default is five words a day, and target retention is capped at 95% — above
that the workload multiplies faster than anyone expects and the deck gets
abandoned.

**Six digits is a million possibilities, so the lockout is the security, not
the code.** Four free guesses, then escalating freezes up to a day, counted per
account and per IP. Obvious PINs and straight runs are refused. Sign-in spends
the same scrypt time whether or not the nickname exists, so the endpoint cannot
be used to enumerate accounts.

**Server sync is a data-integrity requirement, not a convenience.** Safari
evicts IndexedDB for sites it judges unengaged, and `navigator.storage.persist()`
is unreliable on iOS. Losing the review log would mean losing the only record of
how you actually learn.

---

## Licence

Private project. FSRS-6 is reimplemented from
[py-fsrs](https://github.com/open-spaced-repetition/py-fsrs) (MIT).
