// Classic synchronous head script: choose the theme before styles or the SDK load.
// Also imported by the shell so static test harnesses use the same implementation.
(() => {
  if (window.sattvaTheme) return;
  const key = 'sattva:theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => value === 'light' || value === 'dark' ? value : null;
  let preference = null;
  try { preference = valid(localStorage.getItem(key)); } catch { /* Embedded storage can be blocked. */ }
  const apply = () => {
    const theme = preference || (system.matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.dispatchEvent(new CustomEvent('sattva:theme-change', { detail: theme }));
  };
  window.sattvaTheme = Object.freeze({
    toggle() {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch { /* Retain the choice for this visit. */ }
      apply();
    },
  });
  system.addEventListener('change', () => { if (!preference) apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    try { if (event.storageArea !== localStorage) return; } catch { return; }
    preference = valid(event.newValue);
    apply();
  });
  apply();
})();
