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
          ? [['↑ ↓', 'choisir'], ['Suppr', 'supprimer'], ['Échap', 'retour']]
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
        if (!renderTimer) renderTimer = setTimeout(renderLive, 45);
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

  const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function fillHistory(list) {
    if (!list.length) {
      historyBox.replaceChildren(el('div', 'hist-empty', 'Aucune conversation enregistrée pour le moment.'));
      return;
    }
    historyBox.replaceChildren(
      ...list.map((c) => {
        const item = el('div', 'hist-item' + (c.id === convId ? ' current' : ''));
        item.tabIndex = 0;
        item.setAttribute('role', 'option');
        item.dataset.id = c.id;
        const main = el('span', 'hist-main');
        const when = c.updatedAt ? dateFmt.format(new Date(c.updatedAt)) : '';
        main.append(
          el('span', 'hist-title', c.title),
          el('span', 'hist-sub', `${when} · ${c.agents.join(', ')} · ${c.turns} message${c.turns > 1 ? 's' : ''}`)
        );
        const del = el('span', 'hist-del');
        del.title = 'Supprimer cette conversation';
        del.setAttribute('role', 'button');
        del.setAttribute('aria-label', 'Supprimer');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', 'M4.5 4.5l7 7M11.5 4.5l-7 7');
        svg.append(p);
        del.append(svg);
        item.append(main, del);
        return item;
      })
    );
  }

  async function showHistory(on) {
    if (on && running) return;
    view = on ? 'history' : 'chat';
    $('hist-btn').setAttribute('aria-pressed', String(on));
    historyBox.hidden = !on;
    thread.hidden = on;
    if (on) {
      setStatus('');
      fillHistory(await api.listConversations());
      const first = historyBox.querySelector('.hist-item.current') || historyBox.querySelector('.hist-item');
      if (first) first.focus();
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

  async function deleteConversation(item) {
    const next = item.nextElementSibling || item.previousElementSibling;
    const nextId = next ? next.dataset.id : null;
    fillHistory(await api.deleteConversation(item.dataset.id));
    applyState(await api.getState());
    const focus = (nextId && historyBox.querySelector(`[data-id="${nextId}"]`)) || historyBox.querySelector('.hist-item');
    if (focus) focus.focus();
  }

  historyBox.addEventListener('click', (e) => {
    const item = e.target.closest('.hist-item');
    if (!item) return;
    if (e.target.closest('.hist-del')) deleteConversation(item);
    else openConversation(item.dataset.id);
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
      const item = e.target.closest ? e.target.closest('.hist-item') : null;
      if (e.key === 'Escape' || (e.ctrlKey && k === 'h')) { e.preventDefault(); showHistory(false); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus('.hist-item', 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus('.hist-item', -1); }
      else if (e.key === 'Enter' && item) { e.preventDefault(); openConversation(item.dataset.id); }
      else if (e.key === 'Delete' && item) { e.preventDefault(); deleteConversation(item); }
      else if (e.ctrlKey && k === 'n') { e.preventDefault(); newConversation(); }
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
