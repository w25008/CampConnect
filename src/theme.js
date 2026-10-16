// Light / dark theme. A saved choice wins; otherwise follow the device setting.
// index.html applies the same rule before the app loads, so the page never flashes the wrong theme.
const STORAGE_KEY = 'campconnect_theme';

export function initialTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* storage unavailable */ }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function saveTheme(theme) {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* storage unavailable */ }
}
