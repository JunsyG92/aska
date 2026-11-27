'use strict';
// Icon in the system tray (notification area, or GNOME's top bar through the
// AppIndicator extension): run status and menu.
// The logic (trayModel) is pure; createTray receives Electron's classes, so it
// can be tested without starting the app.
const path = require('path');
const { t } = require('../i18n');

const ICON_DIR = path.join(__dirname, '..', '..', 'assets');
const ICONS = { idle: 'tray.png', running: 'tray-running.png' };

/**
 * What the icon shows for a given state.
 * `running`: number of requests in progress (all tabs); `agentLabels`: their agents.
 * The tooltip only names the agents, never the text of the requests.
 */
function trayModel({ running = 0, agentLabels = [], visible = false } = {}) {
  const count = Number(running) || 0;
  const agents = [...new Set(agentLabels.filter(Boolean))].join(', ') || t('tray.agent');
  return {
    icon: count ? 'running' : 'idle',
    tooltip: count ? t('tray.running', { count, agents }) : t('tray.idle'),
    items: [
      { id: 'toggle', label: t(visible ? 'tray.hide' : 'tray.show'), enabled: true },
      { type: 'separator' },
      // Opens a new tab: allowed even while a request is running.
      { id: 'new', label: t('tray.newConversation'), enabled: true },
      { id: 'cancel', label: t('tray.cancel', { count: Math.max(count, 1) }), enabled: count > 0 },
      { type: 'separator' },
      { id: 'tasks', label: t('tray.tasks'), enabled: true },
      { id: 'settings', label: t('tray.settings'), enabled: true },
      { id: 'quit', label: t('tray.quit'), enabled: true },
    ],
  };
}

/**
 * Creates the icon. `electron` provides { Tray, Menu, nativeImage }; `actions`
 * maps each menu entry (toggle, new, cancel, tasks, settings, quit) to a function.
 */
function createTray(electron, actions, iconDir = ICON_DIR) {
  const { Tray, Menu, nativeImage } = electron;
  // nativeImage also loads the @2x variant for high-density screens.
  const images = {};
  for (const [k, file] of Object.entries(ICONS)) images[k] = nativeImage.createFromPath(path.join(iconDir, file));

  const tray = new Tray(images.idle);
  // Left click (Windows, and Linux when the desktop forwards it): show or hide.
  tray.on('click', () => actions.toggle());

  let last = null;
  function update(state) {
    const m = trayModel(state);
    const key = JSON.stringify(m);
    if (key === last) return;
    last = key;
    tray.setImage(images[m.icon]);
    tray.setToolTip(m.tooltip);
    // On Linux, a menu already set does not update: it is replaced on every change.
    tray.setContextMenu(Menu.buildFromTemplate(m.items.map((it) =>
      it.type === 'separator'
        ? { type: 'separator' }
        : { label: it.label, enabled: it.enabled, click: () => actions[it.id]() }
    )));
  }

  return {
    update,
    destroy() {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}

module.exports = { trayModel, createTray, ICONS, ICON_DIR };
