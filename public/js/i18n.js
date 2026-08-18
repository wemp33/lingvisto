// Interface strings. English and Polish are the learner's base languages —
// German, Russian and Italian are what is being learnt and never appear here.
import * as store from './store.js';

const STRINGS = {
  en: {
    'app.name': 'Lingvisto',
    'app.tagline': 'Talk, write, remember.',

    'tab.talk': 'Talk', 'tab.words': 'Words', 'tab.write': 'Write', 'tab.review': 'Review',

    'act.done': 'Done', 'act.cancel': 'Cancel', 'act.save': 'Save', 'act.delete': 'Delete',
    'act.close': 'Close', 'act.back': 'Back', 'act.next': 'Next', 'act.retry': 'Try again',
    'act.add': 'Add', 'act.edit': 'Edit', 'act.settings': 'Settings', 'act.continue': 'Continue',
    'act.skip': 'Skip', 'act.clear': 'Clear', 'act.undo': 'Undo', 'act.check': 'Check',

    'lang.learning': 'Learning', 'lang.switch': 'Switch language',

    /* onboarding + account */
    'acct.welcome': 'Welcome to Lingvisto',
    'acct.blurb': 'A tutor you talk to, a page you write on, and a glossary that remembers for you.',
    'acct.nickname': 'Nickname', 'acct.code': '6-digit code',
    'acct.signIn': 'Sign in', 'acct.create': 'Create account',
    'acct.haveAccount': 'I already have an account', 'acct.newAccount': 'I am new here',
    'acct.codeHint': 'Six digits. This plus your nickname is how the same glossary reaches your other device.',
    'acct.codeAgain': 'Repeat the code',
    'acct.signedInAs': 'Signed in as', 'acct.signOut': 'Sign out',
    'acct.changeCode': 'Change code', 'acct.currentCode': 'Current code', 'acct.newCode': 'New code',
    'acct.offlineNote': 'Everything works offline. The account only carries your words between devices.',
    'acct.syncNow': 'Sync now', 'acct.lastSync': 'Last synced', 'acct.never': 'never',
    'acct.signOutWarn': 'Sign out? Anything not yet synced stays on this device only.',

    'err.nickname_short': 'That nickname is too short.',
    'err.nickname_long': 'That nickname is too long.',
    'err.nickname_chars': 'Letters, numbers, spaces, dots, dashes and underscores only.',
    'err.nickname_taken': 'That nickname is taken.',
    'err.nickname_not_allowed': 'That nickname cannot register on this server.',
    'err.code_format': 'The code must be exactly six digits.',
    'err.code_weak': 'Too easy to guess. Avoid runs and repeated digits.',
    'err.code_mismatch': 'The two codes do not match.',
    'err.bad_credentials': 'Wrong nickname or code.',
    'err.locked': 'Too many wrong codes. Try again in {n}.',
    'err.too_many_attempts': 'Too many attempts from this network. Wait a few minutes.',
    'err.offline': 'No connection.',
    'err.timeout': 'That took too long.',
    'err.unauthorized': 'Session expired — sign in again.',
    'err.generic': 'Something went wrong.',
    'err.no_key': 'The server has no AI key configured.',

    /* talk */
    'talk.title': 'Talk',
    'talk.start': 'Start talking', 'talk.end': 'End',
    'talk.connecting': 'Connecting…', 'talk.listening': 'Listening', 'talk.speaking': 'Speaking',
    'talk.hold': 'Hold to speak', 'talk.holdHint': 'Hold the circle while you speak, release when you are done.',
    'talk.handsFree': 'Hands-free', 'talk.pushToTalk': 'Hold to talk',
    'talk.accent': 'Accent',
    'talk.topic': 'Today', 'talk.topicHint': 'What do you want to talk about?',
    'talk.objective': 'Aim for this session',
    'talk.corrections': 'Corrections', 'talk.newWords': 'New words',
    'talk.noCorrections': 'Nothing to correct yet.',
    'talk.report': 'Session report', 'talk.reportWait': 'Writing your report…',
    'talk.saveWord': 'Add to glossary',
    'talk.micDenied': 'Lingvisto needs the microphone. Allow it in Settings → Lingvisto → Microphone.',
    'talk.micLost': 'The microphone stopped responding. Tap to reconnect.',
    'talk.usesGlossary': 'Your tutor knows your {n} saved words and will work them in.',
    'talk.transcript': 'Transcript',
    'talk.suggestTopics': 'Or pick one',

    /* glossary */
    'gl.title': 'Words', 'gl.empty': 'No words yet.',
    'gl.emptyHint': 'Add one by hand, or let the tutor catch them while you talk.',
    'gl.add': 'Add a word', 'gl.search': 'Search',
    'gl.term': 'Word or phrase', 'gl.termHint': 'Type it in {lang} — the tutor will check and complete it.',
    'gl.meaning': 'What it means', 'gl.meaningOptional': 'Leave blank and it will be filled in.',
    'gl.checking': 'Checking…',
    'gl.review': 'Check this before saving',
    'gl.accept': 'Save it', 'gl.acceptAnyway': 'Save as I wrote it',
    'gl.corrected': 'Corrected', 'gl.youWrote': 'You wrote',
    'gl.notAWord': 'This does not look like a real {lang} word.',
    'gl.duplicate': 'Already in your glossary.', 'gl.openExisting': 'Open it',
    'gl.example': 'Example', 'gl.notes': 'Notes', 'gl.grammar': 'Grammar',
    'gl.addedOn': 'Added', 'gl.fromTalk': 'from a conversation', 'gl.byHand': 'by hand',
    'gl.strength': 'Strength', 'gl.nextDue': 'Next review',
    'gl.deleteWarn': 'Delete this word and its review history?',
    'gl.all': 'All', 'gl.new': 'New', 'gl.learning': 'Learning', 'gl.known': 'Known',
    'gl.count': '{n} words',
    'gl.listen': 'Listen', 'gl.listenSlow': 'Slowly',
    'gl.confidence': 'Confidence',

    /* keyboard */
    'kb.title': 'Keyboard', 'kb.hint': 'iOS will not let a web app switch your system keyboard, so Lingvisto brings its own.',
    'kb.system': 'Use the system keyboard', 'kb.lingvisto': 'Use the Lingvisto keyboard',
    'kb.translit': 'Type in Latin letters', 'kb.translitHint': 'privet → привет',
    'kb.stress': 'Stress mark',

    /* write */
    'wr.title': 'Write', 'wr.newPage': 'New page', 'wr.pages': 'Pages',
    'wr.pen': 'Pen', 'wr.eraser': 'Eraser', 'wr.tutorOn': 'Tutor on', 'wr.tutorOff': 'Tutor off',
    'wr.prompt': 'Write this', 'wr.freeWrite': 'Free writing',
    'wr.reading': 'Reading your writing…',
    'wr.looksGood': 'That reads correctly.',
    'wr.pencilOnly': 'Apple Pencil only',
    'wr.pencilOnlyHint': 'Ignore fingers and palm while writing.',
    'wr.phoneNote': 'Apple Pencil does not work on iPhone — this page is finger-drawing here. Open Lingvisto on your iPad for proper handwriting practice.',
    'wr.guides': 'Guide lines', 'wr.guideNone': 'Blank', 'wr.guideRuled': 'Ruled', 'wr.guideFourLine': 'Four-line',
    'wr.cursive': 'Cursive', 'wr.print': 'Print',
    'wr.iRead': 'I read', 'wr.target': 'Target',
    'wr.scribbleWarn': 'Strokes going missing? Turn off Settings → Apple Pencil → Scribble.',
    'wr.saved': 'Saved', 'wr.clearWarn': 'Clear the whole page?',
    'wr.practiceLetters': 'Practise the alphabet',
    'wr.practiceWord': 'Practise a word',

    /* review */
    'rv.title': 'Review', 'rv.due': '{n} due', 'rv.allDone': 'Nothing due right now.',
    'rv.allDoneHint': 'Come back later, or add a few words.',
    'rv.again': 'Again', 'rv.hard': 'Hard', 'rv.good': 'Good', 'rv.easy': 'Easy',
    'rv.show': 'Show answer',
    'rv.skill.recognise': 'What does this mean?',
    'rv.skill.produce': 'How do you say this?',
    'rv.skill.pronounce': 'Say it aloud',
    'rv.skill.write': 'Write it by hand',
    'rv.typeAnswer': 'Type it', 'rv.correct': 'Correct', 'rv.notQuite': 'Not quite',
    'rv.expected': 'Expected',
    'rv.tapToSpeak': 'Hold and say it',
    'rv.progressToday': '{done} of {total} today',
    'rv.streak': '{n}-day streak',

    /* songs */
    'sg.title': 'Learn from a song', 'sg.short': 'Songs',
    'sg.song': 'Song title', 'sg.artist': 'Band or artist',
    'sg.analyse': 'Build the lesson', 'sg.analysing': 'Listening through it…',
    'sg.notFound': 'I do not know that song well enough to teach from it.',
    'sg.notFoundHint': 'Check the spelling, or try a better-known song by the same artist. I will not invent a lesson.',
    'sg.lowConfidence': 'I only half-know this one — check anything that looks odd.',
    'sg.wrongLang': 'This song does not seem to be in {lang}.',
    'sg.noLyrics': 'Vocabulary only — Lingvisto does not show lyrics.',
    'sg.about': 'What it is about', 'sg.vocab': 'Vocabulary', 'sg.expressions': 'Expressions',
    'sg.grammar': 'Grammar it practises', 'sg.culture': 'Worth knowing', 'sg.listening': 'Listen out for',
    'sg.addAll': 'Add all {n}', 'sg.addCore': 'Add the {n} everyday ones', 'sg.added': 'Added {n} words',
    'sg.core': 'everyday', 'sg.poetic': 'poetic',
    'sg.difficulty': 'Difficulty', 'sg.register': 'Register',
    'sg.mySongs': 'Your songs', 'sg.noSongs': 'No songs yet.',
    'sg.reopen': 'Open', 'sg.fromSong': 'from a song',
    'sg.deleteWarn': 'Remove this song? Words you already added stay in your glossary.',

    /* settings */
    'set.title': 'Settings',
    'set.interface': 'Interface language', 'set.learning': 'Languages I am learning',
    'set.account': 'Account', 'set.study': 'Study', 'set.data': 'Data', 'set.about': 'About',
    'set.newPerDay': 'New words per day', 'set.maxReviews': 'Maximum reviews per day',
    'set.retention': 'Target retention',
    'set.retentionHint': 'Higher means you forget less and review far more. {x}× the daily load of 90%.',
    'set.export': 'Export a backup', 'set.import': 'Restore from a backup',
    'set.exportHint': 'A JSON file with every word, card and page.',
    'set.diagnostics': 'Diagnostics', 'set.diagnosticsHint': 'What this device supports.',
    'set.voiceSpeed': 'Tutor speaking speed',
    'set.reset': 'Delete everything on this device',
    'set.resetWarn': 'This wipes the local copy. If you are signed in, it comes back on the next sync.',
    'set.version': 'Version',

    /* misc */
    'time.now': 'now', 'time.min': '{n} min', 'time.hour': '{n} h', 'time.day': '{n} d',
    'time.month': '{n} mo', 'time.year': '{n} yr',
    'offline.banner': 'Offline — changes are saved here and will sync later.',
    'install.hint': 'Add Lingvisto to your Home Screen for the full-screen version.',
  },

  pl: {
    'app.name': 'Lingvisto',
    'app.tagline': 'Mów, pisz, pamiętaj.',

    'tab.talk': 'Rozmowa', 'tab.words': 'Słowa', 'tab.write': 'Pismo', 'tab.review': 'Powtórki',

    'act.done': 'Gotowe', 'act.cancel': 'Anuluj', 'act.save': 'Zapisz', 'act.delete': 'Usuń',
    'act.close': 'Zamknij', 'act.back': 'Wstecz', 'act.next': 'Dalej', 'act.retry': 'Spróbuj ponownie',
    'act.add': 'Dodaj', 'act.edit': 'Edytuj', 'act.settings': 'Ustawienia', 'act.continue': 'Dalej',
    'act.skip': 'Pomiń', 'act.clear': 'Wyczyść', 'act.undo': 'Cofnij', 'act.check': 'Sprawdź',

    'lang.learning': 'Uczę się', 'lang.switch': 'Zmień język',

    'acct.welcome': 'Witaj w Lingvisto',
    'acct.blurb': 'Nauczyciel, z którym rozmawiasz, kartka, na której piszesz, i słownik, który pamięta za ciebie.',
    'acct.nickname': 'Pseudonim', 'acct.code': 'Kod 6-cyfrowy',
    'acct.signIn': 'Zaloguj się', 'acct.create': 'Załóż konto',
    'acct.haveAccount': 'Mam już konto', 'acct.newAccount': 'Jestem tu nowy',
    'acct.codeHint': 'Sześć cyfr. To razem z pseudonimem sprawia, że ten sam słownik trafia na twoje drugie urządzenie.',
    'acct.codeAgain': 'Powtórz kod',
    'acct.signedInAs': 'Zalogowano jako', 'acct.signOut': 'Wyloguj',
    'acct.changeCode': 'Zmień kod', 'acct.currentCode': 'Obecny kod', 'acct.newCode': 'Nowy kod',
    'acct.offlineNote': 'Wszystko działa offline. Konto tylko przenosi twoje słowa między urządzeniami.',
    'acct.syncNow': 'Synchronizuj teraz', 'acct.lastSync': 'Ostatnia synchronizacja', 'acct.never': 'nigdy',
    'acct.signOutWarn': 'Wylogować? To, co nie zostało zsynchronizowane, zostanie tylko na tym urządzeniu.',

    'err.nickname_short': 'Ten pseudonim jest za krótki.',
    'err.nickname_long': 'Ten pseudonim jest za długi.',
    'err.nickname_chars': 'Tylko litery, cyfry, spacje, kropki, myślniki i podkreślenia.',
    'err.nickname_taken': 'Ten pseudonim jest zajęty.',
    'err.nickname_not_allowed': 'Ten pseudonim nie może się tu zarejestrować.',
    'err.code_format': 'Kod musi mieć dokładnie sześć cyfr.',
    'err.code_weak': 'Zbyt łatwy do odgadnięcia. Unikaj ciągów i powtórzeń.',
    'err.code_mismatch': 'Kody nie są takie same.',
    'err.bad_credentials': 'Zły pseudonim lub kod.',
    'err.locked': 'Za dużo błędnych kodów. Spróbuj za {n}.',
    'err.too_many_attempts': 'Za dużo prób z tej sieci. Odczekaj kilka minut.',
    'err.offline': 'Brak połączenia.',
    'err.timeout': 'To trwało za długo.',
    'err.unauthorized': 'Sesja wygasła — zaloguj się ponownie.',
    'err.generic': 'Coś poszło nie tak.',
    'err.no_key': 'Serwer nie ma skonfigurowanego klucza AI.',

    'talk.title': 'Rozmowa',
    'talk.start': 'Zacznij rozmowę', 'talk.end': 'Zakończ',
    'talk.connecting': 'Łączę…', 'talk.listening': 'Słucham', 'talk.speaking': 'Mówię',
    'talk.hold': 'Przytrzymaj, by mówić', 'talk.holdHint': 'Trzymaj kółko, kiedy mówisz, i puść, gdy skończysz.',
    'talk.handsFree': 'Bez rąk', 'talk.pushToTalk': 'Przytrzymaj',
    'talk.accent': 'Akcent',
    'talk.topic': 'Dzisiaj', 'talk.topicHint': 'O czym chcesz porozmawiać?',
    'talk.objective': 'Cel tej rozmowy',
    'talk.corrections': 'Poprawki', 'talk.newWords': 'Nowe słowa',
    'talk.noCorrections': 'Na razie nie ma czego poprawiać.',
    'talk.report': 'Podsumowanie', 'talk.reportWait': 'Piszę podsumowanie…',
    'talk.saveWord': 'Dodaj do słownika',
    'talk.micDenied': 'Lingvisto potrzebuje mikrofonu. Zezwól w Ustawieniach → Lingvisto → Mikrofon.',
    'talk.micLost': 'Mikrofon przestał odpowiadać. Dotknij, by połączyć ponownie.',
    'talk.usesGlossary': 'Nauczyciel zna twoje {n} zapisanych słów i będzie je wplatał.',
    'talk.transcript': 'Zapis rozmowy',
    'talk.suggestTopics': 'Albo wybierz',

    'gl.title': 'Słowa', 'gl.empty': 'Jeszcze nie ma słów.',
    'gl.emptyHint': 'Dodaj ręcznie albo pozwól nauczycielowi łapać je w rozmowie.',
    'gl.add': 'Dodaj słowo', 'gl.search': 'Szukaj',
    'gl.term': 'Słowo lub zwrot', 'gl.termHint': 'Wpisz po {lang} — nauczyciel sprawdzi i uzupełni.',
    'gl.meaning': 'Co znaczy', 'gl.meaningOptional': 'Zostaw puste, a zostanie uzupełnione.',
    'gl.checking': 'Sprawdzam…',
    'gl.review': 'Sprawdź to przed zapisaniem',
    'gl.accept': 'Zapisz', 'gl.acceptAnyway': 'Zapisz tak, jak napisałem',
    'gl.corrected': 'Poprawiono', 'gl.youWrote': 'Napisałeś',
    'gl.notAWord': 'To nie wygląda na prawdziwe słowo w języku {lang}.',
    'gl.duplicate': 'Już jest w twoim słowniku.', 'gl.openExisting': 'Otwórz',
    'gl.example': 'Przykład', 'gl.notes': 'Notatki', 'gl.grammar': 'Gramatyka',
    'gl.addedOn': 'Dodano', 'gl.fromTalk': 'z rozmowy', 'gl.byHand': 'ręcznie',
    'gl.strength': 'Siła', 'gl.nextDue': 'Następna powtórka',
    'gl.deleteWarn': 'Usunąć to słowo razem z historią powtórek?',
    'gl.all': 'Wszystkie', 'gl.new': 'Nowe', 'gl.learning': 'W nauce', 'gl.known': 'Znane',
    'gl.count': 'słów: {n}',
    'gl.listen': 'Posłuchaj', 'gl.listenSlow': 'Wolno',
    'gl.confidence': 'Pewność',

    'kb.title': 'Klawiatura', 'kb.hint': 'iOS nie pozwala stronie zmieniać klawiatury systemowej, więc Lingvisto ma własną.',
    'kb.system': 'Klawiatura systemowa', 'kb.lingvisto': 'Klawiatura Lingvisto',
    'kb.translit': 'Pisz literami łacińskimi', 'kb.translitHint': 'privet → привет',
    'kb.stress': 'Akcent',

    'wr.title': 'Pismo', 'wr.newPage': 'Nowa strona', 'wr.pages': 'Strony',
    'wr.pen': 'Pióro', 'wr.eraser': 'Gumka', 'wr.tutorOn': 'Nauczyciel wł.', 'wr.tutorOff': 'Nauczyciel wył.',
    'wr.prompt': 'Napisz to', 'wr.freeWrite': 'Pisanie swobodne',
    'wr.reading': 'Czytam twoje pismo…',
    'wr.looksGood': 'Czyta się poprawnie.',
    'wr.pencilOnly': 'Tylko Apple Pencil',
    'wr.pencilOnlyHint': 'Ignoruj palce i dłoń podczas pisania.',
    'wr.phoneNote': 'Apple Pencil nie działa na iPhonie — tutaj rysujesz palcem. Otwórz Lingvisto na iPadzie, żeby ćwiczyć pismo naprawdę.',
    'wr.guides': 'Linie pomocnicze', 'wr.guideNone': 'Gładka', 'wr.guideRuled': 'W linie', 'wr.guideFourLine': 'Cztery linie',
    'wr.cursive': 'Kursywa', 'wr.print': 'Drukowane',
    'wr.iRead': 'Odczytuję', 'wr.target': 'Cel',
    'wr.scribbleWarn': 'Gubią się kreski? Wyłącz Ustawienia → Apple Pencil → Pismo odręczne.',
    'wr.saved': 'Zapisano', 'wr.clearWarn': 'Wyczyścić całą stronę?',
    'wr.practiceLetters': 'Ćwicz alfabet',
    'wr.practiceWord': 'Ćwicz słowo',

    'rv.title': 'Powtórki', 'rv.due': 'do powtórki: {n}', 'rv.allDone': 'Nic teraz nie czeka.',
    'rv.allDoneHint': 'Wróć później albo dodaj kilka słów.',
    'rv.again': 'Jeszcze raz', 'rv.hard': 'Trudne', 'rv.good': 'Dobrze', 'rv.easy': 'Łatwe',
    'rv.show': 'Pokaż odpowiedź',
    'rv.skill.recognise': 'Co to znaczy?',
    'rv.skill.produce': 'Jak to powiedzieć?',
    'rv.skill.pronounce': 'Powiedz na głos',
    'rv.skill.write': 'Napisz ręcznie',
    'rv.typeAnswer': 'Wpisz', 'rv.correct': 'Dobrze', 'rv.notQuite': 'Nie do końca',
    'rv.expected': 'Oczekiwano',
    'rv.tapToSpeak': 'Przytrzymaj i powiedz',
    'rv.progressToday': '{done} z {total} dzisiaj',
    'rv.streak': 'seria: {n} dni',

    /* songs */
    'sg.title': 'Ucz się z piosenki', 'sg.short': 'Piosenki',
    'sg.song': 'Tytuł piosenki', 'sg.artist': 'Zespół lub wykonawca',
    'sg.analyse': 'Zbuduj lekcję', 'sg.analysing': 'Przesłuchuję…',
    'sg.notFound': 'Nie znam tej piosenki na tyle, żeby z niej uczyć.',
    'sg.notFoundHint': 'Sprawdź pisownię albo spróbuj bardziej znanej piosenki tego wykonawcy. Nie wymyślę lekcji.',
    'sg.lowConfidence': 'Znam ją tylko połowicznie — sprawdź, co wygląda dziwnie.',
    'sg.wrongLang': 'Ta piosenka chyba nie jest po {lang}.',
    'sg.noLyrics': 'Tylko słownictwo — Lingvisto nie pokazuje tekstów piosenek.',
    'sg.about': 'O czym jest', 'sg.vocab': 'Słownictwo', 'sg.expressions': 'Zwroty',
    'sg.grammar': 'Gramatyka do przećwiczenia', 'sg.culture': 'Warto wiedzieć', 'sg.listening': 'Wsłuchaj się w',
    'sg.addAll': 'Dodaj wszystkie ({n})', 'sg.addCore': 'Dodaj {n} codziennych', 'sg.added': 'Dodano słów: {n}',
    'sg.core': 'codzienne', 'sg.poetic': 'poetyckie',
    'sg.difficulty': 'Trudność', 'sg.register': 'Rejestr',
    'sg.mySongs': 'Twoje piosenki', 'sg.noSongs': 'Jeszcze nie ma piosenek.',
    'sg.reopen': 'Otwórz', 'sg.fromSong': 'z piosenki',
    'sg.deleteWarn': 'Usunąć tę piosenkę? Dodane już słowa zostają w słowniku.',

    'set.title': 'Ustawienia',
    'set.interface': 'Język interfejsu', 'set.learning': 'Języki, których się uczę',
    'set.account': 'Konto', 'set.study': 'Nauka', 'set.data': 'Dane', 'set.about': 'O aplikacji',
    'set.newPerDay': 'Nowych słów dziennie', 'set.maxReviews': 'Maksymalnie powtórek dziennie',
    'set.retention': 'Docelowa pamięć',
    'set.retentionHint': 'Wyżej znaczy mniej zapominania i dużo więcej powtórek. {x}× dziennego obciążenia przy 90%.',
    'set.export': 'Zapisz kopię', 'set.import': 'Przywróć z kopii',
    'set.exportHint': 'Plik JSON ze wszystkimi słowami, kartami i stronami.',
    'set.diagnostics': 'Diagnostyka', 'set.diagnosticsHint': 'Co obsługuje to urządzenie.',
    'set.voiceSpeed': 'Tempo mowy nauczyciela',
    'set.reset': 'Usuń wszystko z tego urządzenia',
    'set.resetWarn': 'To czyści kopię lokalną. Jeśli jesteś zalogowany, wróci przy następnej synchronizacji.',
    'set.version': 'Wersja',

    'time.now': 'teraz', 'time.min': '{n} min', 'time.hour': '{n} godz.', 'time.day': '{n} dni',
    'time.month': '{n} mies.', 'time.year': '{n} lat',
    'offline.banner': 'Offline — zmiany są zapisane tutaj i zsynchronizują się później.',
    'install.hint': 'Dodaj Lingvisto do ekranu początkowego, żeby mieć wersję pełnoekranową.',
  },
};

let current = 'en';
const watchers = new Set();

export function detectUiLang() {
  const nav = (navigator.languages || [navigator.language || 'en']).map((l) => l.toLowerCase());
  return nav.some((l) => l.startsWith('pl')) ? 'pl' : 'en';
}

export async function initI18n() {
  const saved = await store.getMeta('uiLang', null);
  current = saved || detectUiLang();
  document.documentElement.lang = current;
  return current;
}

export const uiLang = () => current;

export async function setUiLang(code) {
  if (!STRINGS[code]) return;
  current = code;
  document.documentElement.lang = code;
  await store.setMeta('uiLang', code);
  watchers.forEach((fn) => fn(code));
}

export const onUiLangChange = (fn) => {
  watchers.add(fn);
  return () => watchers.delete(fn);
};

// t('rv.due', {n: 5}). Falls back to English, then to the key itself, so a
// missing string is visible in development rather than rendering as blank.
export function t(key, vars) {
  let s = STRINGS[current]?.[key] ?? STRINGS.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

// Rewrites every [data-t] in a subtree; used after a language switch.
export function applyStatic(root = document) {
  root.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  root.querySelectorAll('[data-t-ph]').forEach((el) => { el.placeholder = t(el.dataset.tPh); });
  root.querySelectorAll('[data-t-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.tAria)); });
}

/* ---------- formatting ---------- */

export function relativeTime(ms) {
  const abs = Math.abs(ms);
  const min = 60_000;
  if (abs < min) return t('time.now');
  if (abs < 60 * min) return t('time.min', { n: Math.round(abs / min) });
  if (abs < 24 * 60 * min) return t('time.hour', { n: Math.round(abs / (60 * min)) });
  const days = abs / (24 * 60 * min);
  if (days < 30) return t('time.day', { n: Math.round(days) });
  if (days < 365) return t('time.month', { n: Math.round(days / 30) });
  return t('time.year', { n: Math.round(days / 365) });
}

export const formatDate = (ts) =>
  new Date(ts).toLocaleDateString(current === 'pl' ? 'pl-PL' : 'en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' });
