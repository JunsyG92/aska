'use strict';
// Tabs: several conversations open at once, each with its own working folder
// and its own running request. Independent of Electron.
//
// A tab = { id, conv, run, unread } where id is the conversation id, run the
// running request ({ id, handle }) and unread is true when an answer arrived
// while the tab was not in view.

const { t } = require('../i18n');

const MAX_TABS = 8;

class Tabs {
  /**
   * @param store  ConversationStore (create, load)
   * @param max    maximum number of tabs
   */
  constructor(store, { max = MAX_TABS } = {}) {
    this.store = store;
    this.max = max;
    this.list = [];
    this.activeId = null;
  }

  get(id) {
    return this.list.find((tab) => tab.id === id) || null;
  }

  active() {
    return this.get(this.activeId);
  }

  running() {
    return this.list.filter((tab) => tab.run);
  }

  isEmpty(tab) {
    return !tab.conv.turns.length && !tab.run;
  }

  _add(conv) {
    const tab = { id: conv.id, conv, run: null, unread: false };
    this.list.push(tab);
    return tab;
  }

  activate(id) {
    const tab = this.get(id);
    if (!tab) return null;
    this.activeId = id;
    tab.unread = false;
    return tab;
  }

  /** New empty tab, in the given folder. Reuses the active tab if it is still empty. */
  create(cwd) {
    const current = this.active();
    if (current && this.isEmpty(current) && current.conv.cwd === cwd) return { tab: current };
    if (this.list.length >= this.max) return { error: t('errors.tooManyTabs', { max: this.max }) };
    const tab = this._add(this.store.create(cwd));
    this.activate(tab.id);
    return { tab };
  }

  /**
   * Opens a saved conversation: activates it if already open, otherwise opens it
   * in place of the active tab if that one is empty, otherwise in a new tab.
   */
  open(convId) {
    const existing = this.get(convId);
    if (existing) return { tab: this.activate(convId) };
    const conv = this.store.load(convId);
    if (!conv) return { error: t('errors.conversationNotFound') };
    const current = this.active();
    if (current && this.isEmpty(current)) {
      const i = this.list.indexOf(current);
      const tab = { id: conv.id, conv, run: null, unread: false };
      this.list[i] = tab;
      this.activeId = tab.id;
      return { tab };
    }
    if (this.list.length >= this.max) return { error: t('errors.tooManyTabs', { max: this.max }) };
    const tab = this._add(conv);
    this.activate(tab.id);
    return { tab };
  }

  /**
   * Closes a tab. A working tab is only closed once confirmed (force), and its
   * request is then cancelled. There is always at least one tab left.
   */
  close(id, { force = false, cwd } = {}) {
    const tab = this.get(id);
    if (!tab) return { error: t('errors.tabNotFound') };
    if (tab.run && !force) return { needsConfirm: true };
    if (tab.run) tab.run.handle.cancel();
    const i = this.list.indexOf(tab);
    this.list.splice(i, 1);
    if (!this.list.length) {
      const fresh = this._add(this.store.create(cwd ?? tab.conv.cwd));
      this.activeId = fresh.id;
    } else if (this.activeId === id) {
      this.activate(this.list[Math.min(i, this.list.length - 1)].id);
    }
    return { ok: true };
  }

  /** Next or previous tab (dir = ±1), wrapping around. */
  cycle(dir) {
    if (this.list.length < 2) return this.active();
    const i = this.list.findIndex((tab) => tab.id === this.activeId);
    return this.activate(this.list[(i + dir + this.list.length) % this.list.length].id);
  }

  /** A conversation deleted from the history also leaves the tabs. */
  forget(convId, cwd) {
    const tab = this.get(convId);
    if (!tab) return { ok: true };
    if (tab.run) return { error: t('errors.deleteRunning') };
    return this.close(convId, { cwd });
  }

  /** What gets saved: the tabs that have content, and the active tab. */
  serialize() {
    const ids = this.list.filter((tab) => tab.conv.turns.length).map((tab) => tab.id);
    return { tabs: ids, activeTab: ids.includes(this.activeId) ? this.activeId : ids[ids.length - 1] || null };
  }

  /** Reopens the saved tabs; conversations that are gone are skipped. */
  restore(ids, activeId, cwd) {
    this.list = [];
    for (const id of Array.isArray(ids) ? ids.slice(0, this.max) : []) {
      if (typeof id !== 'string' || this.get(id)) continue;
      const conv = this.store.load(id);
      if (conv) this._add(conv);
    }
    if (!this.list.length) this._add(this.store.create(cwd));
    this.activate(this.get(activeId) ? activeId : this.list[this.list.length - 1].id);
  }
}

module.exports = { Tabs, MAX_TABS };
