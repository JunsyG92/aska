'use strict';
// Notifications when an answer finishes, while the chat is out of sight.
// The decision and the content are independent of Electron (testable); only
// createNotifier() touches the Notification API.

const fs = require('fs');
const path = require('path');
const { plainText } = require('./conversations');
const { t } = require('../i18n');

const NOTIFY_MODES = ['hidden', 'unfocused', 'never'];

/**
 * Should the user be told that a request finished?
 *  - "hidden" (default): window hidden or collapsed into a pill;
 *  - "unfocused": also when the window is visible but they are working elsewhere;
 *  - "never": never.
 * A request cancelled by the user never notifies.
 */
function shouldNotify(mode, { visible, focused, mini, status }) {
  if (status === 'cancel' || mode === 'never') return false;
  const outOfSight = !visible || mini;
  return mode === 'unfocused' ? outOfSight || !focused : outOfSight;
}

/**
 * Notification title and text. With preview=false, the answer's content does
 * not appear (lock screen, screen sharing): only the conversation title is shown.
 */
function notificationContent({ agentLabel, status, answer, notice, title, preview = true }) {
  const ok = status === 'ok';
  const subject = title ? t('notify.subject', { title }) : '';
  let body;
  if (!preview) body = subject;
  else if (ok) body = plainText(answer || '', 180) || subject || t('notify.emptyAnswer');
  else body = notice && notice.text ? plainText(notice.text.split('\n')[0], 180) : subject;
  if (ok && notice && notice.kind === 'warn') {
    const n = (notice.text.match(/^(\d+) action/) || [])[1];
    if (n) body = t('notify.denied', { count: Number(n), body });
  }
  return { title: t(ok ? 'notify.replied' : 'notify.failed', { agent: agentLabel }), body: body || '' };
}

/**
 * @param Notification  the Electron class
 * @param onClick       (conversationId) => void: reopens the related conversation
 * @param logFile       optional absolute path where notifications are logged
 *                      (used by the end-to-end tests)
 */
function createNotifier({ Notification, onClick, logFile = null, sound = true }) {
  // Keep a reference to each shown notification: without it, the garbage collector
  // may destroy it and the click would no longer do anything.
  const active = new Map();
  const log = logFile && path.isAbsolute(logFile) ? logFile : null;

  return function notify({ conversationId, title, body }) {
    if (log) {
      try {
        fs.appendFileSync(log, JSON.stringify({ conversationId, title, body }) + '\n');
      } catch { /* test log only */ }
    }
    if (!Notification.isSupported()) return false;
    // One notification per conversation: the newest replaces the previous one.
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
