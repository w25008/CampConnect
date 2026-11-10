// Pick the theme before the page paints (same rule as src/theme.js).
// This is a separate file, not an inline <script>, so the Content-Security-Policy
// in vercel.json can forbid inline scripts.
try {
  var saved = localStorage.getItem('campconnect_theme');
  document.documentElement.dataset.theme = saved === 'light' || saved === 'dark' ? saved
    : (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
} catch (e) { document.documentElement.dataset.theme = 'dark'; }
