'use strict';
// Barre d'onglets : une conversation par onglet. Construite sans innerHTML ;
// les actions (activer, fermer, ouvrir) sont confiées à app.js.

(function () {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  let nav = null;
  let handlers = {};

  function init(navEl, h) {
    nav = navEl;
    handlers = h;
    nav.addEventListener('click', (e) => {
      if (e.target.closest('.tab-new')) return handlers.onNew();
      const tab = e.target.closest('.tab');
      if (!tab) return;
      if (e.target.closest('.tab-close')) handlers.onClose(tab.dataset.id);
      else handlers.onActivate(tab.dataset.id);
    });
    // Clic du milieu : fermer, comme dans un navigateur.
    nav.addEventListener('auxclick', (e) => {
      const tab = e.target.closest('.tab');
      if (tab && e.button === 1) {
        e.preventDefault();
        handlers.onClose(tab.dataset.id);
      }
    });
    nav.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // pas de défilement automatique
    });
  }

  /** @param list  [{ id, title, color, running, unread, active }] */
  function update(list) {
    if (!nav) return;
    // Un seul onglet : pas de barre, l'interface reste celle d'un simple chat.
    nav.hidden = list.length < 2;
    nav.replaceChildren(
      ...list.map((t, i) => {
        const b = el('div', 'tab' + (t.active ? ' active' : '') + (t.running ? ' running' : '') + (t.unread ? ' unread' : ''));
        b.dataset.id = t.id;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(t.active));
        b.title = `${t.title || 'Nouvelle conversation'}${i < 9 ? ` (Ctrl+${i + 1})` : ''}`;
        const dot = el('span', 'tab-dot');
        if (t.color) dot.style.setProperty('--c', t.color);
        const close = el('span', 'tab-close', '×');
        close.setAttribute('role', 'button');
        close.setAttribute('aria-label', 'Fermer l’onglet');
        close.title = t.running ? 'Fermer (annule la demande en cours)' : 'Fermer (Ctrl+W)';
        b.append(dot, el('span', 'tab-title', t.title || 'Nouvelle conversation'), close);
        return b;
      }),
      (() => {
        const plus = el('button', 'tab-new', '+');
        plus.type = 'button';
        plus.title = 'Nouvel onglet (Ctrl+T)';
        plus.setAttribute('aria-label', 'Nouvel onglet');
        return plus;
      })()
    );
    const active = nav.querySelector('.tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  window.AskaTabs = { init, update };
})();
