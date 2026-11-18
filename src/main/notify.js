'use strict';
// Notifications de fin de réponse, quand le chat n'est pas sous les yeux.
// La décision et le contenu sont indépendants d'Electron (testables) ; seul
// createNotifier() touche à l'API Notification.

const fs = require('fs');
const path = require('path');
const { plainText } = require('./conversations');

const NOTIFY_MODES = ['hidden', 'unfocused', 'never'];

/**
 * Faut-il prévenir l'utilisateur de la fin d'une demande ?
 *  - « hidden » (par défaut) : fenêtre masquée ou réduite en pastille ;
 *  - « unfocused » : aussi quand la fenêtre est visible mais qu'il travaille ailleurs ;
 *  - « never » : jamais.
 * Une demande annulée par l'utilisateur ne notifie jamais.
 */
function shouldNotify(mode, { visible, focused, mini, status }) {
  if (status === 'cancel' || mode === 'never') return false;
  const outOfSight = !visible || mini;
  return mode === 'unfocused' ? outOfSight || !focused : outOfSight;
}

/**
 * Titre et texte de la notification. Avec preview=false, le contenu de la
 * réponse n'apparaît pas (écran verrouillé, partage d'écran) : seul le titre
 * de la conversation est rappelé.
 */
function notificationContent({ agentLabel, status, answer, notice, title, preview = true }) {
  const ok = status === 'ok';
  const subject = title ? `« ${title} »` : '';
  let body;
  if (!preview) body = subject;
  else if (ok) body = plainText(answer || '', 180) || subject || 'Réponse vide';
  else body = notice && notice.text ? plainText(notice.text.split('\n')[0], 180) : subject;
  if (ok && notice && notice.kind === 'warn') {
    const n = (notice.text.match(/^(\d+) action/) || [])[1];
    if (n) body = `${n} action${n > 1 ? 's' : ''} refusée${n > 1 ? 's' : ''} · ${body}`;
  }
  return { title: ok ? `${agentLabel} a répondu` : `${agentLabel} : échec`, body: body || '' };
}

/**
 * @param Notification  la classe Electron
 * @param onClick       (conversationId) => void : rouvre la conversation concernée
 * @param logFile       chemin absolu facultatif où consigner les notifications
 *                      (utilisé par les tests de bout en bout)
 */
function createNotifier({ Notification, onClick, logFile = null, sound = true }) {
  // Référence gardée sur chaque notification affichée : sans elle, le ramasse-miettes
  // peut la détruire et le clic ne déclencherait plus rien.
  const active = new Map();
  const log = logFile && path.isAbsolute(logFile) ? logFile : null;

  return function notify({ conversationId, title, body }) {
    if (log) {
      try {
        fs.appendFileSync(log, JSON.stringify({ conversationId, title, body }) + '\n');
      } catch { /* journal de test seulement */ }
    }
    if (!Notification.isSupported()) return false;
    // Une seule notification par conversation : la plus récente remplace l'ancienne.
    const previous = active.get(conversationId);
    if (previous) previous.close();
    const n = new Notification({ title, body, silent: !sound });
    active.set(conversationId, n);
    const forget = () => {
      if (active.get(conversationId) === n) active.delete(conversationId);
    };
    n.on('click', () => {
      forget();
      onClick(conversationId);
    });
    n.on('close', forget);
    n.show();
    return true;
  };
}

module.exports = { NOTIFY_MODES, shouldNotify, notificationContent, createNotifier };
