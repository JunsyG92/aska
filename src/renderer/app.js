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
  let live = null; // current turn: { node, answerEl, text }
  let convId = null;
  let turnCount = 0;
  let lastAnswer = '';
  let renderTimer = null;
  let history = [];
  let histIdx = -1;
  let draft = '';
  let pendingTrust = null; // request waiting for write approval
  let warnings = [];
  let mini = false;
  let activityText = '';
  let view = 'chat'; // 'chat' | 'history'
  let menuOpen = false;
  let pinned = false;
  let unread = 0;
  let tabList = []; // tabs: [{ id, title, color, running, unread, active }]
  const tabUi = new Map(); // per tab: { draft, agentId, mode }, kept when switching tabs
  let closeArmed = null; // working tab waiting for the close confirmation

  // ---------- translations (strings sent by the main process) ----------

  let lang = 'en';
  let strings = {};
  const lookup = (key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), strings);
  function t(key, params = {}) {
    let v = lookup(key);
    if (v && typeof v === 'object' && typeof params.count === 'number') v = v[new Intl.PluralRules(lang).select(params.count)] ?? v.other;
    if (typeof v !== 'string') return key;
    return v.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(params, k) ? String(params[k]) : m));
  }
  let locale = 'en-US';
  let timeFmt, dayFmt, yearFmt;

  // Static texts of index.html (data-i18n*), reapplied when the language changes.
  function setLanguage(s) {
    lang = s.lang || 'en';
    strings = s.strings || {};
    locale = t('locale');
    document.documentElement.lang = lang;
    timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
    dayFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
    yearFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' });
    window.renderMarkdown.labels.copy = t('copy');
    for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
    for (const [attr, data] of [['title', 'i18nTitle'], ['aria-label', 'i18nAriaLabel'], ['placeholder', 'i18nPlaceholder']]) {
      const sel = '[data-' + data.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ']';
      for (const n of document.querySelectorAll(sel)) n.setAttribute(attr, t(n.dataset[data]));
    }
    document.querySelectorAll('.code-copy').forEach((b) => { b.textContent = t('copy'); });
    document.querySelectorAll('.turn .meta').forEach((m) => { m.dataset.cancelled = t('cancelled'); });
    syncMiniLabels();
    setKeys();
  }

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

  // ---------- footer, status, pill ----------

  function setKeys() {
    const items = running
      ? [[t('keys.esc'), t('footer.cancel')]]
      : pendingTrust || menuOpen
        ? []
        : view === 'history'
          ? [['↑ ↓', t('footer.select')], ['⏎', t('footer.open')], [t('keys.del'), t('footer.delete')], [t('keys.esc'), t('footer.back')]]
          : [['Tab', t('footer.agent')], ['⇧ Tab', t('footer.mode')]];
    keys.replaceChildren(
      ...items.map(([k, label]) => {
        const s = el('span');
        s.append(el('kbd', null, k), label);
        return s;
      })
    );
  }

  function syncMini() {
    const others = tabList.filter((t) => t.running && !t.active).length;
    $('mini-status').textContent = running
      ? (activityText || t('running')) + (others ? ` · +${others}` : '')
      : others
        ? t('tabs.running', { count: others })
        : unread
        ? t('unread', { count: unread })
        : status.textContent;
  }

  // Replies that arrived while the chat was hidden or minimized.
  function setUnread(n) {
    unread = n;
    panel.classList.toggle('has-unread', unread > 0);
    syncMini();
  }

  // Pinned: the chat stays visible when clicking elsewhere.
  function setPinned(v, save) {
    pinned = v;
    const btn = $('pin-btn');
    btn.setAttribute('aria-pressed', String(pinned));
    btn.title = t(pinned ? 'pin.pinnedTitle' : 'pin.title');
    if (save) {
      api.setPinned(pinned);
      replay(btn, 'swap');
      setStatus(t(pinned ? 'pin.pinned' : 'pin.hidesOnBlur'));
    }
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

  // Minimizes the panel to a pill (or restores it). The current run keeps going.
  function setMini(v) {
    if (mini === v) return;
    mini = v;
    panel.classList.toggle('mini', mini);
    syncMiniLabels();
    api.setMini(mini);
    window.AskaTabs.update(mini ? [] : tabList); // no tab bar in the pill
    syncMini();
    if (!mini) {
      autosize();
      scrollEnd(true);
      if (pendingTrust) $('trust-once').focus();
      else input.focus();
    }
  }

  function syncMiniLabels() {
    $('mini-btn').title = t(mini ? 'mini.expandTitle' : 'mini.minimizeTitle');
    $('mini-btn').setAttribute('aria-label', t(mini ? 'mini.expand' : 'mini.minimize'));
  }

  // ---------- agent, mode, model ----------

  function setMode(next, animate) {
    mode = next;
    modeBtn.dataset.mode = mode;
    $('mode-name').textContent = modes[mode] ? modes[mode].label : mode;
    modeBtn.title = t('modeTitle', { hint: modes[mode] ? modes[mode].hint : '' });
    if (animate) replay(modeBtn, 'swap');
  }

  function syncModel() {
    const a = agent();
    modelBtn.hidden = !a || !a.canPickModel;
    if (!a) return;
    $('model-name').textContent = a.model || t('model.default');
    modelBtn.title = t('model.title', { agent: a.label });
  }

  function setAgent(id, animate) {
    const a = agents.find((x) => x.id === id);
    if (!a) return;
    agentId = id;
    panel.style.setProperty('--agent', a.color);
    $('agent-name').textContent = a.label;
    input.placeholder = t(turnCount ? 'reply' : 'ask', { agent: a.label });
    if (animate) replay(agentBtn, 'swap');
    // An agent may not offer every mode: fall back to the most restrictive one.
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

  // ----- model picker: list provided by the CLI, filterable from the keyboard -----

  let modelItems = []; // displayed options: { id, label }
  let modelSel = 0;
  let modelAll = [];
  let modelCurrent = null;
  const MODEL_RE = /^[A-Za-z0-9][\w.:/[\]-]{0,79}$/;

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
    if (!needle) modelItems.push({ id: null, label: t('model.cliDefault') });
    modelItems.push(...modelAll.filter(match).slice(0, 300));
    // A name missing from the list is still usable, if the CLI knows it.
    if (q && MODEL_RE.test(q) && !modelItems.length) modelItems.push({ id: q, label: t('model.use', { model: q }), custom: true });
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
    $('model-note').textContent = modelAll.length ? '' : t('model.fetching', { agent: a.label });
    const res = await api.listModels(a.id, refresh);
    btn.classList.remove('busy');
    if (!menuOpen || agentId !== a.id) return;
    modelAll = res.models;
    modelCurrent = res.current;
    $('model-note').textContent = res.fromCli
      ? ''
      : res.error
        ? t('model.unavailable', { error: res.error })
        : modelAll.length
          ? ''
          : t('model.notPublished', { agent: a.label });
    renderModels();
  }

  function openModelMenu() {
    const a = agent();
    if (running || !a || !a.canPickModel) return;
    if (menuOpen) return closeModelMenu();
    modelAll = a.models.map((id) => ({ id, label: null }));
    modelCurrent = a.model || null;
    $('model-filter').value = '';
    $('model-filter').placeholder = t('model.search', { agent: a.label });
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

  // ---------- conversation thread ----------

  function scrollEnd(force) {
    if (force || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80) thread.scrollTop = thread.scrollHeight;
  }

  function fillMeta(metaEl, turn) {
    const secs = turn.durationMs ? t('duration', { secs: (turn.durationMs / 1000).toLocaleString(locale, { maximumFractionDigits: 1 }) }) : null;
    const parts = [turn.model, modes[turn.mode] ? modes[turn.mode].label : null, secs].filter(Boolean);
    metaEl.dataset.cancelled = t('cancelled');
    metaEl.replaceChildren(el('i'), el('b', null, turn.label), parts.length ? ' · ' + parts.join(' · ') : '');
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
    setLanguage(s);
    modes = s.modes;
    agents = s.agents.filter((a) => a.available);
    history = s.history || [];
    warnings = s.warnings || [];
    $('cwd-name').textContent = s.cwd;
    $('cwd').title = t('cwdTitle', { path: s.cwdIsScratch ? t('cwdScratch') : s.cwd });
    $('hist-btn').hidden = !s.historyEnabled;
    setPinned(!!s.pinned, false);
    setUnread(s.unread || 0);
    setTabs(s.tabs || []);
    if (s.conversation.id !== convId) switchTo(s);
    else if (!running && s.conversation.turns.length !== turnCount) renderThread(s.conversation);
    if (!agents.length) {
      input.disabled = true;
      input.placeholder = t('noAgent');
      $('agent-name').textContent = t('noneAgent');
      modelBtn.hidden = true;
      const hints = s.agents.map((a) => t('agentHint', { agent: a.label, hint: a.install || a.error })).join('\n');
      showNotice(t('noAgentCli', { hints }), 'warn');
      return;
    }
    input.disabled = false;
    const saved = tabUi.get(convId);
    if (saved && saved.agentId && agents.some((x) => x.id === saved.agentId)) {
      agentId = saved.agentId;
      mode = saved.mode || mode;
      tabUi.set(convId, { ...saved, agentId: null }); // applied once, when arriving on the tab
    }
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

  // ---------- tabs ----------

  function setTabs(list) {
    tabList = list;
    window.AskaTabs.update(mini ? [] : list);
    syncMini();
  }

  // Switching to another tab: store the draft and choices of the tab being left,
  // show the new one's thread, and reattach to its running request.
  function switchTo(s) {
    if (convId) tabUi.set(convId, { draft: input.value, agentId, mode });
    clearTimeout(renderTimer);
    renderTimer = null;
    closeArmed = null;
    pendingTrust = null;
    confirmBox.hidden = true;
    if (view === 'history') showHistory(false);
    showNotice('');
    renderThread(s.conversation);
    const ui = tabUi.get(s.conversation.id);
    input.value = ui ? ui.draft || '' : '';
    histIdx = -1;
    running = !!s.run;
    live = null;
    runId = null;
    if (s.run) {
      const node = thread.lastElementChild;
      if (node) {
        live = { node, meta: node.querySelector('.meta'), answerEl: node.querySelector('.output'), text: s.conversation.turns[s.conversation.turns.length - 1].answer || '' };
        node.classList.add('live');
      }
      runId = s.run.id;
      panel.dataset.state = 'running';
      setActivity(t('running'));
    } else setActivity('');
    autosize();
    setKeys();
  }

  async function newTab() {
    const res = await api.newTab();
    if (res.error) setStatus(res.error, 'err');
    applyState(res);
    input.focus();
  }

  async function activateTab(id) {
    if (!id || id === convId) return;
    applyState(await api.activateTab(id));
    input.focus();
  }

  async function cycleTab(dir) {
    if (tabList.length < 2) return;
    applyState(await api.cycleTab(dir));
    input.focus();
  }

  // Closing a working tab takes two steps: its request will be cancelled.
  async function closeTab(id) {
    const target = id || convId;
    const res = await api.closeTab(target, closeArmed === target);
    if (res.needsConfirm) {
      closeArmed = target;
      setStatus(t('tabs.confirmClose'), 'err');
      return;
    }
    closeArmed = null;
    if (res.error) setStatus(res.error, 'err');
    applyState(res);
    input.focus();
  }

  window.AskaTabs.init($('tabs'), { onActivate: activateTab, onClose: closeTab, onNew: newTab, t });
  api.onTabs(setTabs);

  // ---------- sending ----------

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
    const res = await api.run({ tabId: convId, agentId, mode, prompt, trust });
    if (res.needsTrust) {
      pendingTrust = { prompt };
      confirmBox.dataset.mode = res.mode;
      const what = t(res.mode === 'auto' ? 'trust.editAndRun' : 'trust.editFiles');
      $('confirm-text').textContent = t(res.reason === 'content' ? 'trust.content' : 'trust.allow', { agent: res.agent, cwd: res.cwd, what });
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
    // The request joins the thread and the field clears for the next message.
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
    setActivity(t('starting'));
    setKeys();
    autosize();
    scrollEnd(true);
    input.placeholder = t('reply', { agent: a.label });
    input.focus();
  }

  function onRunEvent(ev) {
    if (ev.type === 'end' && ev.tabs) setTabs(ev.tabs);
    if (ev.tabId !== convId || ev.id !== runId || !live) return;
    switch (ev.type) {
      case 'text':
        live.text += ev.text;
        // The longer the answer, the less often it is redrawn.
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
    const turn = ev.turn;
    running = false;
    clearTimeout(renderTimer);
    renderTimer = null;
    live.text = turn.answer || live.text;
    renderLive();
    live.node.classList.remove('live');
    live.node.dataset.status = turn.status;
    fillMeta(live.meta, turn);
    if (turn.notice) live.node.append(el('div', 'notice ' + turn.notice.kind, turn.notice.text));
    lastAnswer = live.text;
    live = null;
    setActivity('');
    panel.dataset.state = turn.status === 'ok' ? 'done' : 'error';
    if (turn.status === 'ok') setStatus(t('status.done'), 'ok');
    else setStatus(t(turn.status === 'cancel' ? 'status.cancelled' : 'status.failed'), 'err');
    setKeys();
    autosize();
    scrollEnd(true);
  }

  // New conversation: in a new tab (or the active tab if it is empty).
  async function newConversation() {
    if (view === 'history') showHistory(false);
    await newTab();
  }

  // ---------- conversation history ----------

  const histList = $('hist-list');
  const histSearch = $('hist-search');
  let histAll = [];
  let histShown = [];
  let histSel = 0;
  let histConfirm = null; // id waiting for delete confirmation

  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  // Groups by age and picks the shortest date format that stays clear.
  function whenOf(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { group: t('history.older'), time: '' };
    const days = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
    if (days <= 0) return { group: t('history.today'), time: timeFmt.format(d) };
    if (days === 1) return { group: t('history.yesterday'), time: timeFmt.format(d) };
    if (days < 7) return { group: t('history.last7'), time: dayFmt.format(d) };
    if (days < 30) return { group: t('history.last30'), time: dayFmt.format(d) };
    return { group: t('history.older'), time: d.getFullYear() === new Date().getFullYear() ? dayFmt.format(d) : yearFmt.format(d) };
  }

  function armDelete(id) {
    histConfirm = id;
    histList.querySelectorAll('.hist-item').forEach((r) => {
      const on = r.dataset.id === id;
      r.classList.toggle('arming', on);
      r.querySelector('.hist-del').textContent = t(on ? 'history.confirmDelete' : 'history.delete');
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
    $('hist-count').textContent = !n ? '' : q ? t('history.filtered', { shown: histShown.length, total: n }) : t('history.count', { count: n });
    histConfirm = null;
    if (!histShown.length) {
      const empty = el('div', 'hist-empty');
      empty.append(
        el('b', null, t(n ? 'history.noResults' : 'history.empty')),
        n ? t('history.noMatch', { query: histSearch.value.trim() }) : t('history.emptyHint')
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
      const facts = [c.agents.map((a) => a.label).join(', '), t('history.messages', { count: c.turns }), c.cwd].filter(Boolean);
      sub.append(dots, el('span', null, facts.join(' · ')));
      const del = el('button', 'hist-del', t('history.delete'));
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
    view = on ? 'history' : 'chat';
    $('hist-btn').setAttribute('aria-pressed', String(on));
    historyBox.hidden = !on;
    thread.hidden = on;
    panel.classList.toggle('in-history', on); // the footer only keeps the list shortcuts
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
    showHistory(false);
    applyState(s);
    if (s.error) setStatus(s.error, 'err');
  }

  // Two-step delete: the first request arms, the second confirms.
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

  // In the thread: links open in the browser, "Copy" button on code blocks.
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
      btn.textContent = t('copied');
      setTimeout(() => { btn.textContent = t('copy'); }, 1400);
    }
  });

  // ---------- keyboard ----------

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


  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.shiftKey && k === 'm') {
      e.preventDefault();
      setMini(!mini);
      return;
    }
    if (e.ctrlKey && !e.shiftKey && k === 'p' && !mini) {
      e.preventDefault();
      setPinned(!pinned, true);
      return;
    }
    if (!mini && !pendingTrust && !menuOpen && e.ctrlKey) {
      const tabKey =
        (k === 't' || (k === 'n' && !e.shiftKey)) ? () => newConversation()
        : k === 'w' && !e.shiftKey ? () => closeTab()
        : e.key === 'Tab' ? () => cycleTab(e.shiftKey ? -1 : 1)
        : e.key === 'PageDown' ? () => cycleTab(1)
        : e.key === 'PageUp' ? () => cycleTab(-1)
        : /^[1-9]$/.test(e.key) && !e.shiftKey && tabList.length > 1
          ? () => activateTab((e.key === '9' ? tabList[tabList.length - 1] : tabList[Number(e.key) - 1] || {}).id)
          : null;
      if (tabKey) {
        e.preventDefault();
        tabKey();
        return;
      }
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
        // "Del" targets the conversation when there is nothing left to erase in the search.
        e.preventDefault();
        deleteConversation(sel.id);
      } else if (e.key === 'Tab') e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (running) api.cancel(convId);
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
      if (lastAnswer) api.copy(lastAnswer).then(() => setStatus(t('status.copied'), 'ok'));
    } else if (e.ctrlKey && !e.shiftKey && k === 'o') {
      e.preventDefault();
      if (!running) api.pickDir().then(applyState);
    } else if (e.ctrlKey && !e.shiftKey && k === 'l') {
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

  // The window follows the panel size (minimized, expanded, growing thread).
  new ResizeObserver(() => {
    const pad = 2 * parseFloat(getComputedStyle(document.body).paddingLeft);
    api.resize({ w: panel.offsetWidth + pad, h: panel.offsetHeight + pad });
  }).observe(panel);

  // ---------- display lifecycle ----------

  api.onRunEvent(onRunEvent);
  api.onUnread(setUnread);
  $('pin-btn').addEventListener('click', () => { setPinned(!pinned, true); input.focus(); });
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
