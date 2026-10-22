// Runs before the page paints so the chosen theme never flashes. Choice: auto | light | dark.
(function () {
  var t = 'auto';
  try { t = localStorage.getItem('nl-theme') || 'auto'; } catch (e) { /* storage blocked: use auto */ }
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
})();
