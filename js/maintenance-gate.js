/* Demo hold switch. Set to false when the public demo is ready. */
(() => {
  const MAINTENANCE_MODE = true;
  if (!MAINTENANCE_MODE) return;

  const path = window.location.pathname.replace(/\/$/, '');
  if (path === '/updating' || path === '/updating.html') return;

  // Hide the old page immediately, then send every route to the update screen.
  document.documentElement.style.visibility = 'hidden';
  window.location.replace('/updating.html');
})();
