'use strict';
// Tab bar: one conversation per tab. Built without innerHTML; the actions
// (activate, close, open) are handed to app.js, along with the translations (t).

(function () {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    // Middle click: close, as in a browser.
    nav.addEventListener('auxclick', (e) => {
      const tab = e.target.closest('.tab');
      if (tab && e.button === 1) {
        e.preventDefault();
        handlers.onClose(tab.dataset.id);
      }
    });
    nav.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll
    });
  }

  /** @param list  [{ id, title, color, bot: { id, label, color } | null, running, unread, active }] */
  function update(list) {
    if (!nav) return;
    const t = handlers.t || ((key) => key);
    // A single tab: no bar, the interface stays a simple chat.
    nav.hidden = list.length < 2;
    nav.replaceChildren(
      ...list.map((tab, i) => {
        const title = tab.title || t('newConversation');
        const b = el('div', 'tab' + (tab.active ? ' active' : '') + (tab.running ? ' running' : '') + (tab.unread ? ' unread' : ''));
        b.dataset.id = tab.id;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(tab.active));
        b.title = `${tab.bot ? `@${tab.bot.label} · ` : ''}${title}${i < 9 ? ` (Ctrl+${i + 1})` : ''}`;
        // A bot: its avatar, animated while it works (unless motion is reduced).
        let dot;
        if (tab.bot && window.AskaAvatar) {
          dot = el('img', 'tab-dot bot');
          dot.alt = '';
          dot.src = tab.bot.image || window.AskaAvatar.avatarDataUrl(tab.bot.label, { ...tab.bot.avatar, color: tab.bot.color, badge: false, animate: tab.running && !reducedMotion() });
        } else dot = el('span', 'tab-dot');
        const color = tab.bot ? tab.bot.color : tab.color;
        if (color) dot.style.setProperty('--c', color);
        const close = el('span', 'tab-close', '×');
        close.setAttribute('role', 'button');
        close.setAttribute('aria-label', t('tabs.close'));
        close.title = t(tab.running ? 'tabs.closeRunningTitle' : 'tabs.closeTitle');
        b.append(dot, el('span', 'tab-title', title), close);
        return b;
      }),
      (() => {
        const plus = el('button', 'tab-new', '+');
        plus.type = 'button';
        plus.title = t('tabs.newTabTitle');
        plus.setAttribute('aria-label', t('tabs.newTab'));
        return plus;
      })()
    );
    const active = nav.querySelector('.tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  window.AskaTabs = { init, update };
})();
