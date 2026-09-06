import '../theme-init.js';

export function mountThemeToggle(button) {
  if (!button) return () => {};
  const render = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    button.setAttribute('aria-pressed', String(dark));
    button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
      ${dark ? '<circle cx="12" cy="12" r="4"/><path stroke-linecap="round" d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>' : '<path stroke-linejoin="round" d="M20.2 15.1A8.5 8.5 0 0 1 8.9 3.8 8.5 8.5 0 1 0 20.2 15.1Z"/>'}
    </svg><span>${dark ? 'Dark' : 'Light'}</span>`;
  };
  const toggle = () => window.sattvaTheme.toggle();
  button.addEventListener('click', toggle);
  window.addEventListener('sattva:theme-change', render);
  render();
  return () => {
    button.removeEventListener('click', toggle);
    window.removeEventListener('sattva:theme-change', render);
  };
}
