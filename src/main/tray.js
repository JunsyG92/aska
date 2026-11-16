'use strict';
// Icône dans la barre système (zone de notification, ou barre du haut de GNOME
// via l'extension AppIndicator) : état d'exécution et menu.
// La logique (trayModel) est pure ; createTray reçoit les classes d'Electron,
// ce qui permet de la tester sans lancer l'application.
const path = require('path');

const ICON_DIR = path.join(__dirname, '..', '..', 'assets');
const ICONS = { idle: 'tray.png', running: 'tray-running.png' };

/**
 * Ce que l'icône affiche pour un état donné.
 * L'info-bulle ne contient que le nom de l'agent, jamais le texte de la demande.
 */
function trayModel({ running = false, agentLabel = null, visible = false } = {}) {
  return {
    icon: running ? 'running' : 'idle',
    tooltip: running ? `Aska : ${agentLabel || 'agent'} en cours…` : 'Aska',
    items: [
      { id: 'toggle', label: visible ? 'Masquer Aska' : 'Afficher Aska', enabled: true },
      { type: 'separator' },
      // Comme dans l'interface, on ne change pas de conversation pendant une exécution.
      { id: 'new', label: 'Nouvelle conversation', enabled: !running },
      { id: 'cancel', label: 'Annuler l’exécution', enabled: running },
      { type: 'separator' },
      { id: 'quit', label: 'Quitter Aska', enabled: true },
    ],
  };
}

/**
 * Crée l'icône. `electron` fournit { Tray, Menu, nativeImage } ; `actions`
 * associe à chaque entrée du menu (toggle, new, cancel, quit) une fonction.
 */
function createTray(electron, actions, iconDir = ICON_DIR) {
  const { Tray, Menu, nativeImage } = electron;
  // nativeImage charge aussi la variante @2x pour les écrans haute densité.
  const images = {};
  for (const [k, file] of Object.entries(ICONS)) images[k] = nativeImage.createFromPath(path.join(iconDir, file));

  const tray = new Tray(images.idle);
  // Clic gauche (Windows, et Linux quand le bureau le transmet) : afficher ou masquer.
  tray.on('click', () => actions.toggle());

  let last = null;
  function update(state) {
    const m = trayModel(state);
    const key = JSON.stringify(m);
    if (key === last) return;
    last = key;
    tray.setImage(images[m.icon]);
    tray.setToolTip(m.tooltip);
    // Sous Linux, un menu déjà posé ne se met pas à jour : on le remplace à chaque changement.
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
