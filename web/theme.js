// Applies the chosen skin and light or dark theme before the first paint, so
// the page never flashes another one. Loaded in <head> as a plain script;
// app.js owns the controls.
(function () {
  // The skins the page offers, in menu order; the first is the default. Each
  // has a stylesheet at /skins/<id>/skin.css, linked from index.html.
  var skins = [
    { id: 'guild', name: 'Guild' },
    { id: 'professional', name: 'Professional' },
    { id: 'orbital', name: 'Orbital' },
    { id: 'grove', name: 'Grove' },
  ];
  window.agentGuildSkins = skins;

  var theme = null;
  var skin = null;
  try {
    theme = localStorage.getItem('agentGuild.theme');
    skin = localStorage.getItem('agentGuild.skin');
  } catch (e) { /* storage unavailable */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  if (!skins.some(function (s) { return s.id === skin; })) skin = skins[0].id;
  var view = null;
  try { view = localStorage.getItem('agentGuild.view'); } catch (e) { /* storage unavailable */ }
  if (view !== 'cards' && view !== 'yard') view = 'cards';
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.skin = skin;
  document.documentElement.dataset.view = view;
})();
