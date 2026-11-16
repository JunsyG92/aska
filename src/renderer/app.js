'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const panel = $('panel');
  const input = $('input');
  const agentBtn = $('agent');
  const modeBtn = $('mode');
  const modelBtn = $('model');
  const result = $('result');
  const thread = $('thread');
  const historyBox = $('history');
  const activity = $('activity');
  const notice = $('notice');
  const confirmBox = $('confirm');
  const modelMenu = $('model-menu');
  const status = $('status');
  const keys = $('keys');
  const api = window.aska;

  let agents = [];
  let modes = {};
  let agentId = null;
  let mode = 'read';
  let runId = null;
  let running = false;
  let live = null; // tour en cours : { node, answerEl, text }
  let convId = null;
  let turnCount = 0;
  let lastAnswer = '';
  let renderTimer = null;
  let history = [];
  let histIdx = -1;
  let draft = '';
  let pendingTrust = null; // demande en attente d'accord d'écriture
  let warnings = [];
  let mini = false;
  let activityText = '';
  let view = 'chat'; // 'chat' | 'history'
  let menuOpen = false;

  const agent = () => agents.find((a) => a.id === agentId) || null;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function replay(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  // ---------- pied, statut, pastille ----------

  function setKeys() {
    const items = running
      ? [['Échap', 'annuler']]
      : pendingTrust || menuOpen
        ? []
        : view === 'history'
          ? [['↑ ↓', 'choisir'], ['⏎', 'ouvrir'], ['Suppr', 'supprimer'], ['Échap', 'retour']]
          : [['Tab', 'agent'], ['⇧ Tab', 'mode']];
    keys.replaceChildren(
      ...items.map(([k, label]) => {
        const s = el('span');
        s.append(el('kbd', null, k), label);
        return s;
      })
    );
  }

  function syncMini() {
    $('mini-status').textContent = running ? activityText || 'En cours…' : status.textContent;
  }

  function setStatus(text, cls) {
    status.textContent = text || '';
    status.className = 'status' + (cls ? ' ' + cls : '');
    syncMini();
  }

  function showNotice(text, cls) {
    notice.hidden = !text;
    notice.textContent = text || '';
    notice.className = 'notice' + (cls ? ' ' + cls : '');
    syncOpen();
  }

  function setActivity(text) {
    activityText = text || '';
    activity.hidden = !text;
    $('activity-text').textContent = activityText;
    syncMini();
    syncOpen();
  }

  function syncOpen() {
    const open = view === 'history' || thread.childElementCount > 0 || !activity.hidden || !notice.hidden;
    result.classList.toggle('open', open);
  }

  // Réduit le panneau en pastille (ou le rétablit). L'exécution en cours continue.
  function setMini(v) {
    if (mini === v) return;
    mini = v;
    panel.classList.toggle('mini', mini);
    $('mini-btn').title = mini ? 'Agrandir (Ctrl+M)' : 'Réduire (Ctrl+M)';
    $('mini-btn').setAttribute('aria-label', mini ? 'Agrandir' : 'Réduire');
    api.setMini(mini);
    syncMini();
    if (!mini) {
      autosize();
      scrollEnd(true);
      if (pendingTrust) $('trust-once').focus();
      else input.focus();
    }
  }

  // ---------- agent, mode, modèle ----------

  function setMode(next, animate) {
    mode = next;
    modeBtn.dataset.mode = mode;
    $('mode-name').textContent = modes[mode] ? modes[mode].label : mode;
    modeBtn.title = `${modes[mode] ? modes[mode].hint : ''} — Maj+Tab pour changer`;
    if (animate) replay(modeBtn, 'swap');
  }

  function syncModel() {
    const a = agent();
    modelBtn.hidden = !a || !a.canPickModel;
    if (!a) return;
    $('model-name').textContent = a.model || 'Modèle par défaut';
    modelBtn.title = `Modèle utilisé par ${a.label} — Ctrl+Maj+M pour changer`;
  }

  function setAgent(id, animate) {
    const a = agents.find((x) => x.id === id);
    if (!a) return;
    agentId = id;
    panel.style.setProperty('--agent', a.color);
    $('agent-name').textContent = a.label;
    input.placeholder = turnCount ? `Répondre à ${a.label}…` : `Demandez une action à ${a.label}…`;
    if (animate) replay(agentBtn, 'swap');
    // Un agent ne propose pas forcément tous les modes : on retombe sur le plus restrictif.
    if (!a.modes.includes(mode)) setMode(a.modes[0], animate);
    syncModel();
    if (menuOpen) closeModelMenu();
  }

  function cycleAgent(dir) {
    if (running || agents.length < 2) return;
    const i = agents.findIndex((a) => a.id === agentId);
    setAgent(agents[(i + dir + agents.length) % agents.length].id, true);
  }

  function cycleMode() {
    const a = agent();
    if (running || !a) return;
    const i = a.modes.indexOf(mode);
    setMode(a.modes[(i + 1) % a.modes.length], true);
  }

  // ----- choix du modèle : liste fournie par le CLI, filtrable au clavier -----

  let modelItems = []; // options affichées : { id, label }
  let modelSel = 0;
  let modelAll = [];
  let modelCurrent = null;
  const MODEL_RE = /^[A-Za-z0-9][\w.:\/\[\]-]{0,79}$/;

  function closeModelMenu() {
    menuOpen = false;
    modelMenu.hidden = true;
    setKeys();
    input.focus();
  }

  async function chooseModel(value) {
    const a = agent();
    if (!a) return;
    applyState(await api.setModel(a.id, value));
    closeModelMenu();
    replay(modelBtn, 'swap');
  }

  function highlightModel(i, scroll) {
    const nodes = $('model-list').children;
    if (!nodes.length) return;
    modelSel = Math.min(Math.max(i, 0), nodes.length - 1);
    [...nodes].forEach((n, j) => n.classList.toggle('active', j === modelSel));
    if (scroll) nodes[modelSel].scrollIntoView({ block: 'nearest' });
  }

  function renderModels() {
    const q = $('model-filter').value.trim();
    const needle = q.toLowerCase();
    const match = (m) => !needle || m.id.toLowerCase().includes(needle) || (m.label || '').toLowerCase().includes(needle);
    modelItems = [];
    if (!needle) modelItems.push({ id: null, label: 'Par défaut du CLI' });
    modelItems.push(...modelAll.filter(match).slice(0, 300));
    // Un nom absent de la liste reste utilisable, si le CLI le connaît.
    if (q && MODEL_RE.test(q) && !modelItems.length) modelItems.push({ id: q, label: `Utiliser « ${q} »`, custom: true });
    $('model-list').replaceChildren(
      ...modelItems.map((m, i) => {
        const row = el('div', 'model-opt');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(m.id === modelCurrent));
        row.append(el('span', 'model-label', m.label || ''), el('span', 'model-id', m.custom || m.id === null ? '' : m.id));
        row.addEventListener('click', () => chooseModel(m.id));
        row.addEventListener('mousemove', () => highlightModel(i, false));
        return row;
      })
    );
    const cur = modelItems.findIndex((m) => m.id === modelCurrent);
    highlightModel(needle ? 0 : Math.max(cur, 0), true);
  }

  async function loadModels(refresh) {
    const a = agent();
    if (!a) return;
    const btn = $('model-refresh');
    btn.classList.add('busy');
    $('model-note').textContent = modelAll.length ? '' : `Récupération des modèles de ${a.label}…`;
    const res = await api.listModels(a.id, refresh);
    btn.classList.remove('busy');
    if (!menuOpen || agentId !== a.id) return;
    modelAll = res.models;
    modelCurrent = res.current;
    $('model-note').textContent = res.fromCli
      ? ''
      : res.error
        ? `Liste indisponible (${res.error}) : tapez le nom du modèle.`
        : modelAll.length
          ? ''
          : `${a.label} ne publie pas sa liste : tapez le nom du modèle.`;
    renderModels();
  }

  function openModelMenu() {
    const a = agent();
    if (running || !a || !a.canPickModel) return;
    if (menuOpen) return closeModelMenu();
    modelAll = a.models.map((id) => ({ id, label: null }));
    modelCurrent = a.model || null;
    $('model-filter').value = '';
    $('model-filter').placeholder = `Rechercher un modèle ${a.label}…`;
    menuOpen = true;
    modelMenu.hidden = false;
    setKeys();
    renderModels();
    $('model-filter').focus();
    loadModels(false);
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    $('enter-hint').classList.toggle('off', !input.value.trim() || running);
  }

  // ---------- fil de conversation ----------

  function scrollEnd(force) {
    if (force || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80) thread.scrollTop = thread.scrollHeight;
  }

  function fillMeta(metaEl, t) {
    const secs = t.durationMs ? `${(t.durationMs / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s` : null;
    const parts = [t.model, modes[t.mode] ? modes[t.mode].label : null, secs].filter(Boolean);
    metaEl.replaceChildren(el('i'), el('b', null, t.label), parts.length ? ' · ' + parts.join(' · ') : '');
  }

  function addTurn(t, isStatic) {
    const node = el('article', 'turn' + (isStatic ? ' static' : ''));
    node.style.setProperty('--agent', t.color);
    node.dataset.status = t.status;
    const meta = el('div', 'meta');
    fillMeta(meta, t);
    const answerEl = el('div', 'output');
    if (t.answer) answerEl.append(window.renderMarkdown(t.answer));
    node.append(el('div', 'q', t.prompt), meta, answerEl);
    if (t.notice) node.append(el('div', 'notice ' + t.notice.kind, t.notice.text));
    thread.append(node);
    return { node, meta, answerEl, text: t.answer || '' };
  }

  function renderThread(conversation) {
    convId = conversation.id;
    turnCount = conversation.turns.length;
    thread.replaceChildren();
    for (const t of conversation.turns) addTurn(t, true);
    const last = conversation.turns[turnCount - 1];
    lastAnswer = last ? last.answer : '';
    panel.dataset.state = 'idle';
    setStatus('');
    syncOpen();
    scrollEnd(true);
  }

  function renderLive() {
    renderTimer = null;
    if (!live) return;
    live.answerEl.replaceChildren(window.renderMarkdown(live.text));
    scrollEnd(false);
  }

  function applyState(s) {
    modes = s.modes;
    agents = s.agents.filter((a) => a.available);
    history = s.history || [];
    warnings = s.warnings || [];
    $('cwd-name').textContent = s.cwd;
    $('cwd').title = (s.cwdIsScratch ? 'Dossier vide réservé à Aska' : s.cwd) + ' — Ctrl+O pour choisir un dossier';
    $('hist-btn').hidden = !s.historyEnabled;
    if (!running && (s.conversation.id !== convId || s.conversation.turns.length !== turnCount)) renderThread(s.conversation);
    if (!agents.length) {
      input.disabled = true;
      input.placeholder = 'Aucun agent détecté';
      $('agent-name').textContent = 'Aucun';
      modelBtn.hidden = true;
      const hints = s.agents.map((a) => `${a.label} : ${a.install || a.error}`).join('\n');
      showNotice(`Aucun CLI d'agent trouvé dans le PATH.\n${hints}`, 'warn');
      return;
    }
    input.disabled = false;
    if (!agentId || !agent()) {
      const preferred = agents.find((a) => a.id === s.defaultAgent) || agents[0];
      if (!modes[mode] || !agentId) mode = s.defaultMode;
      agentId = preferred.id;
    }
    setAgent(agentId, false);
    const a = agent();
    setMode(a.modes.includes(mode) ? mode : a.modes[0], false);
    if (warnings.length && !turnCount && !running) showNotice(warnings.join('\n'), 'warn');
  }

  // ---------- envoi ----------

  function closeConfirm() {
    pendingTrust = null;
    confirmBox.hidden = true;
    setKeys();
    input.focus();
  }

  async function submit(trust) {
    const prompt = pendingTrust ? pendingTrust.prompt : input.value.trim();
    const a = agent();
    if (running || !prompt || !a) return;
    if (view === 'history') showHistory(false);
    const res = await api.run({ agentId, mode, prompt, trust });
    if (res.needsTrust) {
      pendingTrust = { prompt };
      confirmBox.dataset.mode = res.mode;
      const what = res.mode === 'auto' ? 'modifier des fichiers et lancer des commandes' : 'modifier des fichiers';
      $('confirm-text').textContent =
        res.reason === 'content'
          ? `${res.agent} demande de faire confiance au contenu de « ${res.cwd} » : il lira sa configuration et pourra exécuter du code qui s'y trouve. Continuer ?`
          : `Autoriser ${res.agent} à ${what} dans « ${res.cwd} » ?`;
      confirmBox.hidden = false;
      $('trust-once').focus();
      setKeys();
      return;
    }
    pendingTrust = null;
    confirmBox.hidden = true;
    if (res.error) {
      showNotice(res.error, 'error');
      replay(panel, 'in');
      input.focus();
      return;
    }
    // La demande rejoint le fil et le champ se vide pour le message suivant.
    runId = res.id;
    running = true;
    if (history[history.length - 1] !== prompt) history.push(prompt);
    histIdx = -1;
    draft = '';
    input.value = '';
    showNotice('');
    live = addTurn({ label: a.label, color: a.color, model: a.model, mode, prompt, answer: '', status: 'running' }, false);
    live.node.classList.add('live');
    turnCount += 1;
    panel.dataset.state = 'running';
    setStatus('');
    setActivity('Démarrage…');
    setKeys();
    autosize();
    scrollEnd(true);
    input.placeholder = `Répondre à ${a.label}…`;
    input.focus();
  }

  function onRunEvent(ev) {
    if (ev.id !== runId || !live) return;
    switch (ev.type) {
      case 'text':
        live.text += ev.text;
        // Plus la réponse est longue, moins on la redessine souvent.
        if (!renderTimer) renderTimer = setTimeout(renderLive, Math.min(400, 45 + live.text.length / 400));
        break;
      case 'activity':
        setActivity(ev.text);
        break;
      case 'stderr': {
        const last = ev.text.trim().split('\n').pop();
        if (last) setActivity(last.slice(0, 160));
        break;
      }
      case 'end':
        finish(ev);
        break;
      default:
    }
  }

  function finish(ev) {
    const t = ev.turn;
    running = false;
    clearTimeout(renderTimer);
    renderTimer = null;
    live.text = t.answer || live.text;
    renderLive();
    live.node.classList.remove('live');
    live.node.dataset.status = t.status;
    fillMeta(live.meta, t);
    if (t.notice) live.node.append(el('div', 'notice ' + t.notice.kind, t.notice.text));
    lastAnswer = live.text;
    live = null;
    setActivity('');
    panel.dataset.state = t.status === 'ok' ? 'done' : 'error';
    if (t.status === 'ok') setStatus('Terminé', 'ok');
    else setStatus(t.status === 'cancel' ? 'Annulé' : 'Échec', 'err');
    setKeys();
    autosize();
    scrollEnd(true);
  }

  async function newConversation() {
    if (running) return;
    if (view === 'history') showHistory(false);
    showNotice('');
    applyState(await api.newConversation());
    input.focus();
  }

  // ---------- historique des conversations ----------

  const histList = $('hist-list');
  const histSearch = $('hist-search');
  let histAll = [];
  let histShown = [];
  let histSel = 0;
  let histConfirm = null; // id en attente de confirmation de suppression

  const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
  const yearFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  // Regroupe par ancienneté et choisit le format de date le plus court qui reste clair.
  function whenOf(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { group: 'Plus ancien', time: '' };
    const days = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
    if (days <= 0) return { group: "Aujourd'hui", time: timeFmt.format(d) };
    if (days === 1) return { group: 'Hier', time: timeFmt.format(d) };
    if (days < 7) return { group: '7 derniers jours', time: dayFmt.format(d) };
    if (days < 30) return { group: '30 derniers jours', time: dayFmt.format(d) };
    return { group: 'Plus ancien', time: d.getFullYear() === new Date().getFullYear() ? dayFmt.format(d) : yearFmt.format(d) };
  }

  function armDelete(id) {
    histConfirm = id;
    histList.querySelectorAll('.hist-item').forEach((r) => {
      const on = r.dataset.id === id;
      r.classList.toggle('arming', on);
      r.querySelector('.hist-del').textContent = on ? 'Confirmer la suppression' : 'Supprimer';
    });
  }

  function highlightHist(i, scroll) {
    const rows = histList.querySelectorAll('.hist-item');
    if (!rows.length) return;
    histSel = Math.min(Math.max(i, 0), rows.length - 1);
    rows.forEach((r, j) => {
      r.classList.toggle('active', j === histSel);
      r.setAttribute('aria-selected', String(j === histSel));
    });
    if (histConfirm && histShown[histSel].id !== histConfirm) armDelete(null);
    if (scroll) {
      if (histSel === 0) histList.scrollTop = 0;
      else rows[histSel].scrollIntoView({ block: 'nearest' });
    }
  }

  function renderHistory() {
    const q = histSearch.value.trim().toLowerCase();
    histShown = histAll.filter(
      (c) => !q || [c.title, c.preview, c.cwd || '', ...c.agents.map((a) => a.label)].some((t) => t.toLowerCase().includes(q))
    );
    const n = histAll.length;
    $('hist-count').textContent = !n ? '' : q ? `${histShown.length} sur ${n}` : `${n} conversation${n > 1 ? 's' : ''}`;
    histConfirm = null;
    if (!histShown.length) {
      const empty = el('div', 'hist-empty');
      empty.append(
        el('b', null, n ? 'Aucun résultat' : 'Aucune conversation pour le moment'),
        n ? `Rien ne correspond à « ${histSearch.value.trim()} ».` : 'Vos échanges apparaîtront ici dès le premier message envoyé.'
      );
      histList.replaceChildren(empty);
      return;
    }
    const nodes = [];
    let group = null;
    histShown.forEach((c, i) => {
      const w = whenOf(c.updatedAt);
      if (w.group !== group) {
        group = w.group;
        nodes.push(el('div', 'hist-group', group));
      }
      const row = el('div', 'hist-item' + (c.id === convId ? ' current' : ''));
      row.setAttribute('role', 'option');
      row.dataset.id = c.id;
      const dots = el('span', 'dots');
      for (const a of c.agents) {
        const d = el('i');
        d.style.setProperty('--c', a.color);
        dots.append(d);
      }
      const sub = el('div', 'hist-sub');
      const facts = [c.agents.map((a) => a.label).join(', '), `${c.turns} message${c.turns > 1 ? 's' : ''}`, c.cwd].filter(Boolean);
      sub.append(dots, el('span', null, facts.join(' · ')));
      const del = el('button', 'hist-del', 'Supprimer');
      del.type = 'button';
      del.tabIndex = -1;
      row.append(el('div', 'hist-title', c.title), el('div', 'hist-time', w.time));
      if (c.preview) row.append(el('div', 'hist-preview', c.preview));
      row.append(sub, del);
      row.addEventListener('mousemove', () => { if (histSel !== i) highlightHist(i, false); });
      nodes.push(row);
    });
    histList.replaceChildren(...nodes);
    const cur = histShown.findIndex((c) => c.id === convId);
    highlightHist(q ? 0 : Math.max(cur, 0), true);
  }

  async function showHistory(on) {
    if (on && running) return;
    view = on ? 'history' : 'chat';
    $('hist-btn').setAttribute('aria-pressed', String(on));
    historyBox.hidden = !on;
    thread.hidden = on;
    panel.classList.toggle('in-history', on); // le pied ne garde que les raccourcis de la liste
    if (on) {
      setStatus('');
      histSearch.value = '';
      histAll = await api.listConversations();
      renderHistory();
      histSearch.focus();
    } else {
      scrollEnd(true);
      input.focus();
    }
    syncOpen();
    setKeys();
  }

  async function openConversation(id) {
    const s = await api.openConversation(id);
    showNotice('');
    applyState(s);
    showHistory(false);
  }

  // Suppression en deux temps : la première demande arme, la seconde confirme.
  async function deleteConversation(id) {
    if (histConfirm !== id) return armDelete(id);
    const keep = histSel;
    histAll = await api.deleteConversation(id);
    applyState(await api.getState());
    renderHistory();
    highlightHist(Math.min(keep, histShown.length - 1), true);
    histSearch.focus();
  }

  histSearch.addEventListener('input', renderHistory);
  histList.addEventListener('click', (e) => {
    const row = e.target.closest('.hist-item');
    if (!row) return;
    if (e.target.closest('.hist-del')) deleteConversation(row.dataset.id);
    else openConversation(row.dataset.id);
    histSearch.focus();
  });

  // Dans le fil : liens ouverts dans le navigateur, bouton « Copier » des blocs de code.
  thread.addEventListener('click', (e) => {
    const a = e.target.closest('a.md-link');
    if (a) {
      e.preventDefault();
      api.openUrl(a.href);
      return;
    }
    const btn = e.target.closest('.code-copy');
    if (btn) {
      api.copy(btn.closest('.codeblock').querySelector('pre code').textContent);
      btn.textContent = 'Copié';
      setTimeout(() => { btn.textContent = 'Copier'; }, 1400);
    }
  });

  // ---------- clavier ----------

  function historyMove(dir) {
    if (!history.length) return false;
    if (histIdx === -1) {
      if (dir > 0) return false;
      draft = input.value;
      histIdx = history.length;
    }
    histIdx += dir;
    if (histIdx >= history.length) {
      histIdx = -1;
      input.value = draft;
    } else {
      histIdx = Math.max(0, histIdx);
      input.value = history[histIdx];
    }
    autosize();
    input.setSelectionRange(input.value.length, input.value.length);
    return true;
  }

  function moveFocus(selector, dir) {
    const items = [...document.querySelectorAll(selector)];
    const i = items.indexOf(document.activeElement);
    const next = items[Math.min(Math.max(i + dir, 0), items.length - 1)];
    if (next) next.focus();
  }

  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.shiftKey && k === 'm') {
      e.preventDefault();
      setMini(!mini);
      return;
    }
    if (mini) {
      if (e.key === 'Escape') { e.preventDefault(); api.hide(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMini(false); }
      return;
    }
    if (pendingTrust) {
      if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(e.shiftKey ? 'always' : 'once'); }
      else if (e.key !== 'Tab') e.preventDefault();
      return;
    }
    if (menuOpen) {
      if (e.key === 'Escape' || (e.ctrlKey && e.shiftKey && k === 'm')) { e.preventDefault(); closeModelMenu(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); highlightModel(modelSel + 1, true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlightModel(modelSel - 1, true); }
      else if (e.key === 'PageDown') { e.preventDefault(); highlightModel(modelSel + 6, true); }
      else if (e.key === 'PageUp') { e.preventDefault(); highlightModel(modelSel - 6, true); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (modelItems[modelSel]) chooseModel(modelItems[modelSel].id);
      } else if (e.key === 'Tab') e.preventDefault();
      return;
    }
    if (view === 'history') {
      const sel = histShown[histSel];
      if (e.key === 'Escape') {
        e.preventDefault();
        if (histConfirm) armDelete(null);
        else if (histSearch.value) { histSearch.value = ''; renderHistory(); }
        else showHistory(false);
      } else if (e.ctrlKey && k === 'h') { e.preventDefault(); showHistory(false); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); highlightHist(histSel + 1, true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlightHist(histSel - 1, true); }
      else if (e.key === 'PageDown') { e.preventDefault(); highlightHist(histSel + 5, true); }
      else if (e.key === 'PageUp') { e.preventDefault(); highlightHist(histSel - 5, true); }
      else if (e.key === 'Enter' && sel) {
        e.preventDefault();
        if (histConfirm === sel.id) deleteConversation(sel.id);
        else openConversation(sel.id);
      } else if (e.key === 'Delete' && sel && histSearch.selectionStart === histSearch.value.length) {
        // « Suppr » vise la conversation quand il n'y a plus rien à effacer dans la recherche.
        e.preventDefault();
        deleteConversation(sel.id);
      } else if (e.ctrlKey && k === 'n') { e.preventDefault(); newConversation(); }
      else if (e.key === 'Tab') e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (running) api.cancel();
      else api.hide();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) cycleMode();
      else cycleAgent(1);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.ctrlKey && e.shiftKey && k === 'm') {
      e.preventDefault();
      openModelMenu();
    } else if (e.ctrlKey && e.shiftKey && k === 'c') {
      e.preventDefault();
      if (lastAnswer) api.copy(lastAnswer).then(() => setStatus('Réponse copiée', 'ok'));
    } else if (e.ctrlKey && !e.shiftKey && k === 'o') {
      e.preventDefault();
      if (!running) api.pickDir().then(applyState);
    } else if (e.ctrlKey && !e.shiftKey && (k === 'n' || k === 'l')) {
      e.preventDefault();
      newConversation();
    } else if (e.ctrlKey && !e.shiftKey && k === 'h') {
      e.preventDefault();
      if (!$('hist-btn').hidden) showHistory(true);
    } else if (e.key === 'ArrowUp' && e.target === input && !input.value.slice(0, input.selectionStart).includes('\n')) {
      if (historyMove(-1)) e.preventDefault();
    } else if (e.key === 'ArrowDown' && e.target === input && histIdx !== -1) {
      if (historyMove(1)) e.preventDefault();
    }
  });

  input.addEventListener('input', () => {
    histIdx = -1;
    autosize();
  });
  agentBtn.addEventListener('click', () => { cycleAgent(1); input.focus(); });
  modeBtn.addEventListener('click', () => { cycleMode(); input.focus(); });
  modelBtn.addEventListener('click', openModelMenu);
  $('model-filter').addEventListener('input', renderModels);
  $('model-refresh').addEventListener('click', () => { loadModels(true); $('model-filter').focus(); });
  $('cwd').addEventListener('click', () => { if (!running) api.pickDir().then(applyState); });
  $('cwd').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!running) api.resetDir().then(applyState);
  });
  $('trust-once').addEventListener('click', () => submit('once'));
  $('trust-always').addEventListener('click', () => submit('always'));
  $('trust-cancel').addEventListener('click', closeConfirm);
  $('mini-btn').addEventListener('click', () => setMini(!mini));
  $('close-btn').addEventListener('click', () => api.hide());
  $('new-btn').addEventListener('click', newConversation);
  $('hist-btn').addEventListener('click', () => showHistory(view !== 'history'));

  // La fenêtre suit la taille du panneau (réduit, agrandi, fil qui s'allonge).
  new ResizeObserver(() => {
    const pad = 2 * parseFloat(getComputedStyle(document.body).paddingLeft);
    api.resize({ w: panel.offsetWidth + pad, h: panel.offsetHeight + pad });
  }).observe(panel);

  // ---------- cycle d'affichage ----------

  api.onRunEvent(onRunEvent);
  api.onWillHide(() => {
    panel.classList.remove('in');
    panel.classList.add('out');
  });
  api.onShown((s) => {
    applyState(s);
    setMini(false);
    panel.classList.remove('out', 'in');
    void panel.offsetWidth;
    panel.classList.add('in');
    if (!pendingTrust && !menuOpen && view === 'chat') input.focus();
    setKeys();
    autosize();
  });

  api.getState().then((s) => {
    applyState(s);
    setKeys();
    autosize();
  });
})();
