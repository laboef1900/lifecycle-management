/* eslint-disable no-undef */
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = stored === 'dark' || ((!stored || stored === 'system') && prefersDark);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {
    // Ignore errors (e.g., in browsers with localStorage disabled)
  }
})();
