// Google Website Translator: lets students read the whole page in their own language.
// Google remembers the chosen language in the "googtrans" cookie and re-applies it on every load.
// Anything marked translate="no" (private messages, keys, codes) is never sent to Google.

// Shown in each language's own script so students can find theirs.
export const TRANSLATE_LANGUAGES = [
  ['vi', 'Tiếng Việt'],
  ['ne', 'नेपाली'],
  ['my', 'မြန်မာ'],
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['ko', '한국어'],
  ['si', 'සිංහල'],
  ['bn', 'বাংলা'],
  ['hi', 'हिन्दी'],
  ['ur', 'اردو'],
  ['mn', 'Монгол'],
  ['uz', 'Oʻzbek'],
  ['id', 'Bahasa Indonesia'],
  ['th', 'ไทย'],
  ['tl', 'Filipino'],
  ['km', 'ខ្មែរ'],
  ['ru', 'Русский'],
  ['es', 'Español'],
  ['pt', 'Português'],
  ['fr', 'Français'],
  ['en', 'English'],
  ['ja', '日本語'],
];

const SCRIPT_URL = 'https://translate.google.com/translate_a/element.js?cb=campconnectTranslateReady';
const HOLDER_ID = 'google_translate_element';
let loading = null;
let resuming = ''; // language being re-applied at start-up, while its cookie is hidden from Google

export function currentTranslateLanguage() {
  const match = document.cookie.match(/(?:^|;\s*)googtrans=\/[^/]*\/([^;]+)/);
  return match ? decodeURIComponent(match[1]) : resuming;
}

function writeCookie(value, maxAge) {
  const host = window.location.hostname;
  // Google may set the cookie on the bare domain too, so clear/set both.
  for (const domain of ['', `; domain=${host}`, `; domain=.${host}`]) {
    document.cookie = `googtrans=${value}; path=/; max-age=${maxAge}${domain}`;
  }
}

// Google's widget swaps text nodes for its own <font> wrappers, which React doesn't know about.
// Without this, React throws "removeChild/insertBefore: not a child" and the page goes blank.
let patched = false;
function patchDomForTranslation() {
  if (patched || typeof Node === 'undefined') return;
  patched = true;
  const removeChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function patchedRemoveChild(child) {
    if (child.parentNode !== this) return child;
    return removeChild.call(this, child);
  };
  const insertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function patchedInsertBefore(node, reference) {
    if (reference && reference.parentNode !== this) return insertBefore.call(this, node, null);
    return insertBefore.call(this, node, reference);
  };
}

function loadWidget() {
  if (loading) return loading;
  patchDomForTranslation();
  loading = new Promise((resolve, reject) => {
    let holder = document.getElementById(HOLDER_ID);
    if (!holder) {
      holder = document.createElement('div');
      holder.id = HOLDER_ID;
      holder.hidden = true;
      document.body.appendChild(holder);
    }
    window.campconnectTranslateReady = () => {
      // No pageLanguage: Google detects it, since the page mixes English, Japanese and students' posts.
      new window.google.translate.TranslateElement({ autoDisplay: false, includedLanguages: TRANSLATE_LANGUAGES.map(([code]) => code).join(',') }, HOLDER_ID);
      resolve();
    };
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onerror = () => { loading = null; script.remove(); reject(new Error('Google Translate could not be loaded.')); };
    document.head.appendChild(script);
  });
  return loading;
}

// Wait for Google's hidden language <select> to appear, then pick the language in it.
function chooseInWidget(code, tries = 40) {
  const combo = document.querySelector('.goog-te-combo');
  if (combo && combo.options.length > 1) {
    combo.value = code;
    combo.dispatchEvent(new Event('change'));
    return;
  }
  if (tries > 0) setTimeout(() => chooseInWidget(code, tries - 1), 150);
}

export async function setTranslateLanguage(code) {
  if (!code) {
    // Google has no reliable "undo" call; clearing the cookie and reloading shows the original text.
    writeCookie('', 0);
    window.location.reload();
    return;
  }
  writeCookie(`/auto/${code}`, 60 * 60 * 24 * 365);
  await loadWidget();
  chooseInWidget(code);
}

// On start-up, only load Google's script if the student already chose a language.
// Google would re-apply the cookie by itself while React is still drawing the page, and that
// often fails, so hide the cookie from it and choose the language once the widget is ready.
export function resumeTranslation() {
  const code = currentTranslateLanguage();
  if (!code) return;
  resuming = code;
  writeCookie('', 0);
  const restore = () => { writeCookie(`/auto/${code}`, 60 * 60 * 24 * 365); resuming = ''; };
  loadWidget().then(() => { restore(); chooseInWidget(code); }, restore);
}
