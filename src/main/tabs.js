'use strict';
// Onglets : plusieurs conversations ouvertes en même temps, chacune avec son
// dossier de travail et sa propre demande en cours. Indépendant d'Electron.
//
// Un onglet = { id, conv, run, unread } où id est l'identifiant de la
// conversation, run la demande en cours ({ id, handle }) et unread vaut true
// quand une réponse est arrivée alors que l'onglet n'était pas sous les yeux.

const MAX_TABS = 8;

class Tabs {
  /**
   * @param store  ConversationStore (create, load)
   * @param max    nombre d'onglets au plus
   */
  constructor(store, { max = MAX_TABS } = {}) {
    this.store = store;
    this.max = max;
    this.list = [];
    this.activeId = null;
  }

  get(id) {
    return this.list.find((t) => t.id === id) || null;
  }

  active() {
    return this.get(this.activeId);
  }

  running() {
    return this.list.filter((t) => t.run);
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

  /** Nouvel onglet vide, dans le dossier donné. Réutilise l'onglet actif s'il est encore vide. */
  create(cwd) {
    const current = this.active();
    if (current && this.isEmpty(current) && current.conv.cwd === cwd) return { tab: current };
    if (this.list.length >= this.max) return { error: `${this.max} onglets au plus : fermez-en un (Ctrl+W)` };
    const tab = this._add(this.store.create(cwd));
    this.activate(tab.id);
    return { tab };
  }

  /**
   * Ouvre une conversation enregistrée : l'active si elle l'est déjà, sinon
   * l'ouvre à la place de l'onglet actif s'il est vide, sinon dans un nouvel onglet.
   */
  open(convId) {
    const existing = this.get(convId);
    if (existing) return { tab: this.activate(convId) };
    const conv = this.store.load(convId);
    if (!conv) return { error: 'Conversation introuvable' };
    const current = this.active();
    if (current && this.isEmpty(current)) {
      const i = this.list.indexOf(current);
      const tab = { id: conv.id, conv, run: null, unread: false };
      this.list[i] = tab;
      this.activeId = tab.id;
      return { tab };
    }
    if (this.list.length >= this.max) return { error: `${this.max} onglets au plus : fermez-en un (Ctrl+W)` };
    const tab = this._add(conv);
    this.activate(tab.id);
    return { tab };
  }

  /**
   * Ferme un onglet. Un onglet qui travaille n'est fermé que sur confirmation
   * (force), et sa demande est alors annulée. Il reste toujours au moins un onglet.
   */
  close(id, { force = false, cwd } = {}) {
    const tab = this.get(id);
    if (!tab) return { error: 'Onglet introuvable' };
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

  /** Onglet suivant ou précédent (dir = ±1), en boucle. */
  cycle(dir) {
    if (this.list.length < 2) return this.active();
    const i = this.list.findIndex((t) => t.id === this.activeId);
    return this.activate(this.list[(i + dir + this.list.length) % this.list.length].id);
  }

  /** Une conversation supprimée de l'historique disparaît aussi de ses onglets. */
  forget(convId, cwd) {
    const tab = this.get(convId);
    if (!tab) return { ok: true };
    if (tab.run) return { error: 'Cette conversation est en cours : annulez sa demande avant de la supprimer' };
    return this.close(convId, { cwd });
  }

  /** Ce qu'on enregistre : les onglets qui ont un contenu, et l'onglet actif. */
  serialize() {
    const ids = this.list.filter((t) => t.conv.turns.length).map((t) => t.id);
    return { tabs: ids, activeTab: ids.includes(this.activeId) ? this.activeId : ids[ids.length - 1] || null };
  }

  /** Rouvre les onglets enregistrés ; les conversations disparues sont ignorées. */
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
