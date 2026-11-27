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
  const settingsBox = $('settings');
  const activity = $('activity');
  const notice = $('notice');
  const confirmBox = $('confirm');
  const modelMenu = $('model-menu');
  const status = $('status');
  const keys = $('keys');
  const cmdMenu = $('cmd-menu');
  const srcMenu = $('src-menu');
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
  let view = 'chat'; // 'chat' | 'history' | 'settings'
  let menuOpen = false;
  let srcOpen = false; // documents and links of the conversation
  let sources = []; // [{ key, kind, label }]
  let pinned = false;
  let unread = 0;
  let tabList = []; // tabs: [{ id, title, color, running, unread, active }]
  const tabUi = new Map(); // per tab: { draft, agentId, mode }, kept when switching tabs
  let closeArmed = null; // working tab waiting for the close confirmation
  let wide = false; // large view: 70 % of the screen, as soon as the agent answers
  const wideChoice = new Map(); // conversation id -> large view chosen (true) or refused (false) by hand
  let lastPrompt = ''; // last request of the active conversation, for /retry
  let customCommands = []; // "/" commands of the config: [{ name, prompt, description?, agent?, mode?, model? }]

  // ---------- translations (strings sent by the main process) ----------

  let lang = 'en';
  let strings = {};
  let keyLabels = {}; // configured shortcut of each action, for {key:action} in the strings
  const lookup = (key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), strings);
  function t(key, params = {}) {
    let v = lookup(key);
    if (v && typeof v === 'object' && typeof params.count === 'number') v = v[new Intl.PluralRules(lang).select(params.count)] ?? v.other;
    if (typeof v !== 'string') return key;
    return v.replace(/\{(key:)?(\w+)\}/g, (m, isKey, k) => {
      if (isKey) return Object.hasOwn(keyLabels, k) ? keyLabels[k] : m;
      return Object.hasOwn(params, k) ? String(params[k]) : m;
    });
  }

  // ---------- configurable shortcuts (parsed and checked by the main process, see keys.js) ----------

  let keymap = {}; // action -> [{ ctrl, shift, alt, meta, key }]
  const eventKey = (e) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);
  /** Does this key event trigger the action? Modifiers must match exactly. */
  const isKey = (e, action) =>
    (keymap[action] || []).some((c) =>
      c.key === eventKey(e) && c.ctrl === e.ctrlKey && c.shift === e.shiftKey && c.alt === e.altKey && c.meta === e.metaKey);
  let locale = 'en-US';
  let timeFmt, dayFmt, yearFmt;

  // Static texts of index.html (data-i18n*), reapplied when the language changes.
  function setLanguage(s) {
    lang = s.lang || 'en';
    strings = s.strings || {};
    keymap = s.keys || {};
    keyLabels = s.keyLabels || {};
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
    syncWideLabels();
    if (sources.length) renderAttach();
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
    const items = view === 'settings'
      ? [[t('keys.esc'), t('footer.back')]]
      : srcOpen
      ? [['⏎', t('footer.add')], [t('keys.del'), t('footer.remove')], [t('keys.esc'), t('footer.close')]]
      : cmdOpen()
      ? [['↑ ↓', t('footer.select')], ['Tab', t('footer.complete')], ['⏎', t('footer.run')], [t('keys.esc'), t('footer.close')]]
      : running
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
    const open = view !== 'chat' || thread.childElementCount > 0 || !activity.hidden || !notice.hidden;
    result.classList.toggle('open', open);
  }

  // Minimizes the panel to a pill (or restores it). The current run keeps going.
  function setMini(v) {
    if (mini === v) return;
    mini = v;
    panel.classList.toggle('mini', mini);
    refreshPalette();
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
  let modelDefault = null; // full name of the CLI's default model, once seen in an answer
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
    if (!needle) modelItems.push({ id: null, label: t('model.cliDefault'), sub: modelDefault });
    modelItems.push(...modelAll.filter(match).slice(0, 300));
    // A name missing from the list is still usable, if the CLI knows it.
    if (q && MODEL_RE.test(q) && !modelItems.length) modelItems.push({ id: q, label: t('model.use', { model: q }), custom: true });
    $('model-list').replaceChildren(
      ...modelItems.map((m, i) => {
        const row = el('div', 'model-opt');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(m.id === modelCurrent));
        row.append(el('span', 'model-label', m.label || ''), el('span', 'model-id', m.custom ? '' : m.id === null ? m.sub || '' : m.id));
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
    modelDefault = res.defaultModel || null;
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
    if (srcOpen) closeSources();
    modelAll = a.models.map((id) => ({ id, label: null }));
    modelDefault = null;
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
    const docs = turn.sources ? t('sources.used', { count: turn.sources }) : null;
    const parts = [turn.model, modes[turn.mode] ? modes[turn.mode].label : null, docs, secs].filter(Boolean);
    metaEl.dataset.cancelled = t('cancelled');
    metaEl.replaceChildren(el('i'), el('b', null, turn.label), parts.length ? ' · ' + parts.join(' · ') : '');
  }

  // Next mode, wider than `m`, offered by this agent (autonomous only if allowed): null if none.
  function widerMode(a, m) {
    const order = ['read', 'edit', 'auto'];
    return (a && a.modes.find((x) => order.indexOf(x) > order.indexOf(m))) || null;
  }

  // Notice of a turn. Actions denied by the mode, on the last turn: a button runs
  // the same request again in the next wider mode (the folder approval still applies).
  function noticeEl(turn, isLast) {
    const n = el('div', 'notice ' + turn.notice.kind, turn.notice.text);
    const a = agents.find((x) => x.id === turn.agentId);
    const next = turn.notice.denied && isLast ? widerMode(a, turn.mode) : null;
    if (next) {
      const label = modes[next] ? modes[next].label : next;
      const b = el('button', 'rerun', t('rerun', { mode: label }));
      b.type = 'button';
      b.title = t('rerunTitle', { mode: label });
      if ((keymap.rerun || []).length) b.append(el('kbd', null, keyLabels.rerun));
      b.addEventListener('click', () => rerun(turn, next));
      n.append(b);
    }
    return n;
  }

  function rerun(turn, next) {
    if (running || pendingTrust) return;
    if (turn.agentId !== agentId) setAgent(turn.agentId, true);
    setMode(next, true);
    submit(undefined, turn.prompt);
  }

  function addTurn(t, isStatic, isLast) {
    const node = el('article', 'turn' + (isStatic ? ' static' : ''));
    node.style.setProperty('--agent', t.color);
    node.dataset.status = t.status;
    const meta = el('div', 'meta');
    fillMeta(meta, t);
    const answerEl = el('div', 'output');
    if (t.answer) answerEl.append(window.renderMarkdown(t.answer));
    node.append(el('div', 'q', t.prompt), meta, answerEl);
    if (t.notice) node.append(noticeEl(t, isLast));
    thread.append(node);
    return { node, meta, answerEl, text: t.answer || '' };
  }

  function renderThread(conversation) {
    convId = conversation.id;
    turnCount = conversation.turns.length;
    thread.replaceChildren();
    conversation.turns.forEach((t, i) => addTurn(t, true, i === conversation.turns.length - 1));
    const choice = wideChoice.get(conversation.id);
    wideOnShow = false;
    setWide(choice !== undefined ? choice : conversation.turns.some((t) => t.answer || t.status !== 'running'));
    const last = conversation.turns[turnCount - 1];
    lastAnswer = last ? last.answer : '';
    lastPrompt = last ? last.prompt : '';
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

  // Widened as soon as the AI answers; an empty tab goes back to the normal size.
  // Large view as soon as the agent answers (unless reduced by hand in this
  // conversation); an empty conversation goes back to the normal size.
  // The window animates to its new size (main process) while the panel fills it:
  // the panel follows the edges exactly, then takes its final layout.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let layoutSeq = 0;
  function setWide(v) {
    if (wide === v) return;
    wide = v;
    syncWideLabels();
    const seq = ++layoutSeq;
    const animate = !document.hidden && !mini && !reduceMotion.matches;
    const settle = () => {
      if (seq !== layoutSeq) return; // another change since: it settles itself
      panel.classList.toggle('wide', wide);
      panel.classList.remove('morphing');
      scrollEnd(false);
    };
    if (wide) {
      panel.classList.add('wide', 'morphing'); // fills the window, and grows with it
      api.setWide(true, { animate }).then(settle, settle);
      return;
    }
    // Size of the panel at the normal size, measured now (same task: nothing is drawn
    // in between), so that the window shrinks right onto it.
    panel.classList.remove('wide');
    const pad = 2 * parseFloat(getComputedStyle(document.body).paddingLeft);
    const compact = { w: panel.offsetWidth + pad, h: panel.offsetHeight + pad };
    if (animate) panel.classList.add('wide', 'morphing'); // keeps filling the window while it shrinks
    api.setWide(false, { compact, animate }).then(settle, settle);
  }

  let wideOnShow = false; // large view due while the window was hidden
  function autoWide() {
    if (wide || wideChoice.get(convId) === false) return;
    // Hidden window: the large view waits until it shows (no layout out of sight).
    if (document.hidden) wideOnShow = true;
    else setWide(true);
  }

  function toggleWide() {
    if (mini) return;
    wideChoice.set(convId, !wide);
    setWide(!wide);
  }

  function syncWideLabels() {
    const btn = $('wide-btn');
    btn.title = t(wide ? 'wide.reduceTitle' : 'wide.enlargeTitle');
    btn.setAttribute('aria-label', t(wide ? 'wide.reduce' : 'wide.enlarge'));
    btn.setAttribute('aria-pressed', String(wide));
  }

  function applyState(s) {
    setLanguage(s);
    modes = s.modes;
    agents = s.agents.filter((a) => a.available);
    history = s.history || [];
    warnings = s.warnings || [];
    customCommands = s.commands || [];
    setSources(s.conversation.sources || []);
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
    if (srcOpen) closeSources(true);
    if (view === 'history') showHistory(false);
    showNotice('');
    renderThread(s.conversation);
    const ui = tabUi.get(s.conversation.id);
    input.value = ui ? ui.draft || '' : '';
    histIdx = -1;
    refreshPalette();
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

  /**
   * Sends the field, or `direct`: a request sent again (/retry, the button after
   * denied actions), which leaves the field as it is. A "/" command is run by the
   * window and never reaches the agent (see commands.js).
   */
  async function submit(trust, direct) {
    let prompt;
    let typed; // as typed, for the recall with ↑
    let model; // model for this request only (command of the config), undefined: the chosen one
    if (pendingTrust) ({ prompt, typed, model, direct } = pendingTrust);
    else if (direct) prompt = typed = direct;
    else {
      typed = input.value.trim();
      if (!typed) return;
      const cmd = window.AskaCommands.parse(typed, cmdCtx());
      if (cmd.kind === 'command') return runCommand(cmd.name, cmd.arg);
      if (cmd.kind === 'unknown') return setStatus(t('commands.unknown', { name: cmd.name }), 'err');
      if (cmd.kind === 'custom') {
        const c = cmd.command;
        if (running) return setStatus(t('commands.busy'), 'err');
        if (c.agent) {
          if (!agents.some((x) => x.id === c.agent)) return setStatus(t('commands.unknownAgent', { name: c.agent }), 'err');
          if (c.agent !== agentId) setAgent(c.agent, true);
        }
        if (c.mode && c.mode !== mode) {
          const offered = agent().modes;
          if (!offered.includes(c.mode)) {
            const list = offered.map((id) => `${id} (${modes[id] ? modes[id].label : id})`).join(', ');
            return setStatus(t('commands.unknownMode', { name: c.mode, agent: agent().label, list }), 'err');
          }
          setMode(c.mode, true);
        }
        if (c.model !== undefined && agent().canPickModel) model = c.model;
        prompt = window.AskaCommands.expand(c.prompt, cmd.arg);
      } else if (cmd.kind === 'agent') {
        if (running) return setStatus(t('commands.busy'), 'err');
        setAgent(cmd.agentId, true);
        if (!cmd.rest) return setInput('');
        prompt = cmd.rest;
      } else prompt = cmd.text;
    }
    const a = agent();
    if (running || !prompt || !a) return;
    if (view === 'history') showHistory(false);
    const req = { tabId: convId, agentId, mode, prompt, trust };
    if (model !== undefined) req.model = model;
    const res = await api.run(req);
    if (res.needsTrust) {
      pendingTrust = { prompt, typed, model, direct };
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
    if (history[history.length - 1] !== typed) history.push(typed);
    lastPrompt = prompt;
    histIdx = -1;
    if (!direct) {
      draft = '';
      input.value = '';
      refreshPalette();
    }
    showNotice('');
    thread.querySelectorAll('.notice .rerun').forEach((b) => b.remove()); // only on the last turn
    live = addTurn({ label: a.label, color: a.color, model: model !== undefined ? model : a.model, mode, prompt, answer: '', status: 'running', sources: sources.length }, false);
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
        if (ev.text.trim()) autoWide(); // first answer: more room to read it
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
    autoWide();
    renderLive();
    live.node.classList.remove('live');
    live.node.dataset.status = turn.status;
    fillMeta(live.meta, turn);
    if (turn.notice) live.node.append(noticeEl(turn, true));
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

  // ---------- "/" commands (parsing and suggestions: commands.js) ----------

  let cmdItems = [];
  let cmdSel = 0;
  let cmdDismissed = null; // field value on which Esc closed the palette
  // A list that opens under a still pointer gets a mousemove without any movement:
  // it must not move the keyboard selection.
  let pointerAt = '';
  let pointerMoved = false;
  document.addEventListener('mousemove', (e) => {
    const at = e.screenX + ',' + e.screenY;
    pointerMoved = at !== pointerAt;
    pointerAt = at;
  }, true);
  function cmdOpen() {
    return !cmdMenu.hidden;
  }

  function cmdCtx() {
    const a = agent();
    return {
      agents: agents.map((x) => ({ id: x.id, label: x.label })),
      modes: (a ? a.modes : []).map((id) => ({ id, label: modes[id] ? modes[id].label : id })),
      models: a && a.canPickModel ? a.models : [],
      custom: customCommands,
    };
  }

  function setInput(value) {
    input.value = value;
    histIdx = -1;
    autosize();
    input.setSelectionRange(value.length, value.length);
    refreshPalette();
  }

  function highlightCmd(i, scroll) {
    const nodes = $('cmd-list').children;
    if (!nodes.length) return;
    cmdSel = Math.min(Math.max(i, 0), nodes.length - 1);
    [...nodes].forEach((n, j) => {
      n.classList.toggle('active', j === cmdSel);
      n.setAttribute('aria-selected', String(j === cmdSel));
    });
    if (scroll) nodes[cmdSel].scrollIntoView({ block: 'nearest' });
  }

  // Palette above the footer while a command is typed (not while recalling with ↑).
  function refreshPalette() {
    const quiet = view !== 'chat' || mini || pendingTrust || menuOpen || srcOpen || histIdx !== -1 || input.value === cmdDismissed;
    const items = quiet ? null : window.AskaCommands.suggest(input.value, cmdCtx());
    if (input.value !== cmdDismissed) cmdDismissed = null;
    const wasOpen = cmdOpen();
    const prev = wasOpen && cmdItems[cmdSel] ? cmdItems[cmdSel].line : null;
    cmdItems = items || [];
    cmdMenu.hidden = !cmdItems.length;
    if (cmdItems.length) {
      $('cmd-list').replaceChildren(
        ...cmdItems.map((it, i) => {
          const row = el('div', 'cmd-opt');
          row.setAttribute('role', 'option');
          if (it.desc || it.custom) {
            row.append(el('span', 'cmd-name', '/' + it.name));
            if (it.arg) row.append(el('span', 'cmd-arg', t('commands.args.' + it.arg)));
            row.append(el('span', 'cmd-desc', it.custom ? it.text : t('commands.desc.' + it.desc, it.descParams || {})));
          } else {
            row.append(el('span', 'cmd-name', it.name), el('span', 'cmd-desc', it.label || ''));
          }
          row.addEventListener('mousedown', (e) => e.preventDefault()); // the field keeps the focus
          row.addEventListener('click', () => acceptCmd(it, true));
          row.addEventListener('mousemove', () => { if (pointerMoved && cmdSel !== i) highlightCmd(i, false); });
          return row;
        })
      );
      const keep = cmdItems.findIndex((it) => it.line === prev);
      highlightCmd(keep >= 0 ? keep : 0, true);
    }
    if (wasOpen !== cmdOpen()) setKeys();
  }

  // Tab completes; Enter (or a click) runs when nothing more is needed.
  function acceptCmd(it, run) {
    if (run && it.done) {
      input.value = it.line;
      submit();
      return;
    }
    setInput(it.line + (it.arg && !it.line.endsWith(' ') ? ' ' : ''));
  }

  async function runCommand(name, arg) {
    const a = agent();
    const busy = () => setStatus(t('commands.busy'), 'err');
    const done = () => setInput('');
    switch (name) {
      case 'help':
        cmdDismissed = null;
        return setInput('/');
      case 'new':
        done();
        return newConversation();
      case 'close':
        done();
        return closeTab();
      case 'agent': {
        const needle = arg.toLowerCase();
        const target = agents.find((x) => x.id === needle || x.label.toLowerCase() === needle);
        if (!target) return setStatus(t('commands.unknownAgent', { name: arg }), 'err');
        if (running) return busy();
        setAgent(target.id, true);
        return done();
      }
      case 'mode': {
        if (running) return busy();
        const needle = arg.toLowerCase();
        const m = a && a.modes.find((id) => id === needle || (modes[id] && modes[id].label.toLowerCase() === needle));
        if (!m) {
          const list = (a ? a.modes : []).map((id) => `${id} (${modes[id] ? modes[id].label : id})`).join(', ');
          return setStatus(t('commands.unknownMode', { name: arg, agent: a ? a.label : '', list }), 'err');
        }
        setMode(m, true);
        return done();
      }
      case 'model': {
        if (!a || !a.canPickModel) return setStatus(t('commands.noModel', { agent: a ? a.label : '' }), 'err');
        if (running) return busy();
        done();
        if (!arg) return openModelMenu();
        const value = arg === window.AskaCommands.DEFAULT_MODEL ? null : arg;
        if (value !== null && !MODEL_RE.test(value)) return setStatus(t('errors.invalidModel'), 'err');
        applyState(await api.setModel(a.id, value));
        replay(modelBtn, 'swap');
        return setStatus(t('commands.model', { model: value || t('model.cliDefault') }), 'ok');
      }
      case 'cd': {
        if (running) return busy();
        if (!arg) {
          done();
          return applyState(await api.pickDir());
        }
        const res = await api.setDir(arg);
        applyState(res);
        if (res.error) return setStatus(res.error, 'err');
        done();
        return setStatus(t('commands.folder', { path: res.cwd }), 'ok');
      }
      case 'add': {
        if (!arg) {
          done();
          return pickSources();
        }
        if (await addSource(arg)) done();
        return;
      }
      case 'sources':
        done();
        return openSources();
      case 'retry':
        if (running) return busy();
        if (!lastPrompt) return setStatus(t('commands.noRetry'), 'err');
        done();
        return submit(undefined, lastPrompt);
      case 'copy':
        done();
        if (lastAnswer) await api.copy(lastAnswer).then(() => setStatus(t('status.copied'), 'ok'));
        return;
      case 'history':
        done();
        if (!$('hist-btn').hidden) showHistory(true);
        return;
      case 'settings':
        done();
        return showSettings(true);
      case 'pin':
        done();
        return setPinned(!pinned, true);
      case 'mini':
        done();
        return setMini(true);
      default:
    }
  }

  // New conversation: in a new tab (or the active tab if it is empty).
  async function newConversation() {
    if (view === 'history') showHistory(false);
    await newTab();
  }

  // ---------- documents and links (read by the main process, see sources.js) ----------

  const srcList = $('src-list');
  const srcInput = $('src-input');
  let srcInfo = new Map(); // key -> what the main process read: { title, chars, error, note }
  let srcSel = -1;
  let srcError = ''; // why the last entry was refused, shown in the panel
  const SRC_ICON = {
    file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
    url: 'M6.7 9.3a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8M9.3 6.7a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.8-.8',
  };

  function icon(d) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }

  function setSources(list) {
    const changed = list.map((x) => x.key).join('\n') !== sources.map((x) => x.key).join('\n');
    sources = list;
    $('sources-count').textContent = list.length ? String(list.length) : '';
    $('sources').classList.toggle('on', list.length > 0);
    if (srcOpen) renderSources();
    if (changed) renderAttach();
    if (changed && list.length) loadSourceInfo(false);
  }

  // Short name of a source on its chip: the file name, or the host and path of a link.
  function shortName(s) {
    if (s.kind === 'url') {
      try {
        const u = new URL(s.label);
        const p = u.pathname.replace(/\/$/, '');
        return u.host + (p ? (p.length > 24 ? '/…' + p.slice(-22) : p) : '');
      } catch {
        return s.label;
      }
    }
    return s.label.split(/[\\/]/).pop() || s.label;
  }

  // The documents of the conversation, above the field: one chip each, with its ×.
  function renderAttach() {
    const bar = $('attach');
    bar.hidden = !sources.length;
    bar.replaceChildren(
      ...sources.map((s) => {
        const info = srcInfo.get(s.key);
        const chip = el('div', 'att' + (info && info.error ? ' err' : !info ? ' loading' : ''));
        chip.setAttribute('role', 'listitem');
        const sub = !info ? t('sources.loading') : info.error || [info.title, info.chars ? t('sources.chars', { count: info.chars }) : null, info.note].filter(Boolean).join(' · ');
        chip.title = sub ? `${s.label}\n${sub}` : s.label;
        const name = el('button', 'att-name', shortName(s));
        name.type = 'button';
        name.prepend(icon(SRC_ICON[s.kind] || SRC_ICON.file));
        name.addEventListener('click', openSources);
        const del = el('button', 'att-del', '×');
        del.type = 'button';
        del.title = t('sources.removeTitle', { name: s.label });
        del.setAttribute('aria-label', t('sources.removeTitle', { name: s.label }));
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          removeSource(s.key);
        });
        chip.append(name, del);
        return chip;
      })
    );
  }

  function highlightSource(i, scroll) {
    const rows = srcList.children;
    srcSel = rows.length ? Math.min(Math.max(i, -1), rows.length - 1) : -1;
    [...rows].forEach((r, j) => {
      r.classList.toggle('active', j === srcSel);
      r.setAttribute('aria-selected', String(j === srcSel));
    });
    if (scroll && srcSel >= 0) rows[srcSel].scrollIntoView({ block: 'nearest' });
  }

  function renderSources() {
    srcList.replaceChildren(
      ...sources.map((s, i) => {
        const info = srcInfo.get(s.key);
        const row = el('div', 'src-item');
        row.setAttribute('role', 'option');
        const sub = !info
          ? t('sources.loading')
          : info.error || [info.title, info.chars ? t('sources.chars', { count: info.chars }) : null, info.note].filter(Boolean).join(' · ');
        const del = el('button', 'src-del', t('sources.remove'));
        del.type = 'button';
        del.tabIndex = -1;
        del.title = t('sources.removeTitle', { name: s.label });
        del.addEventListener('click', () => removeSource(s.key));
        row.append(icon(SRC_ICON[s.kind] || SRC_ICON.file), el('div', 'src-name', s.label), del, el('div', 'src-sub' + (info && info.error ? ' err' : ''), sub));
        row.title = s.label;
        row.addEventListener('mousemove', () => { if (pointerMoved && srcSel !== i) highlightSource(i, false); });
        return row;
      })
    );
    $('src-note').textContent = srcError || t(sources.length ? 'sources.note' : 'sources.empty');
    $('src-note').classList.toggle('err', !!srcError);
    highlightSource(Math.min(srcSel, sources.length - 1), false);
  }

  // What each source gave once read (size, title, or why it could not be read).
  async function loadSourceInfo(refresh) {
    if (!sources.length) return;
    const btn = $('src-refresh');
    const forConv = convId;
    btn.classList.add('busy');
    const list = await api.listSources(refresh);
    btn.classList.remove('busy');
    if (forConv !== convId) return;
    srcInfo = new Map(list.map((x) => [x.key, x]));
    if (srcOpen) renderSources();
    renderAttach();
  }

  function openSources() {
    if (mini || pendingTrust) return;
    if (srcOpen) return closeSources();
    if (menuOpen) closeModelMenu();
    if (view !== 'chat') return;
    srcOpen = true;
    srcMenu.hidden = false;
    srcInput.value = '';
    srcSel = -1;
    srcError = '';
    refreshPalette();
    renderSources();
    setKeys();
    srcInput.focus();
    loadSourceInfo(false);
  }

  function closeSources(quiet) {
    srcOpen = false;
    srcMenu.hidden = true;
    if (quiet) return;
    setKeys();
    input.focus();
  }

  function reportSources(res) {
    srcError = res.errors && res.errors.length ? res.errors[0] : '';
    applyState(res);
    if (srcOpen) renderSources();
    if (srcError) setStatus(srcError, 'err');
    else if (res.added) setStatus(t('sources.added', { count: res.added }), 'ok');
    return !(res.errors && res.errors.length);
  }

  /** A link or a file path, typed or pasted (several lines: one per line). */
  async function addSource(text) {
    const items = String(text).split('\n').map((x) => x.trim()).filter(Boolean);
    if (!items.length) return false;
    return reportSources(await api.addSources(items));
  }

  async function pickSources() {
    const ok = reportSources(await api.pickSources());
    (srcOpen ? srcInput : input).focus();
    return ok;
  }

  async function removeSource(key) {
    const keep = srcSel;
    applyState(await api.removeSource(key));
    setStatus(t('sources.removed'), 'ok');
    if (srcOpen) {
      highlightSource(Math.min(keep, sources.length - 1), false);
      srcInput.focus();
    } else input.focus();
  }

  // ---------- drag and drop: files, or a link from the browser ----------

  // What a drag carries that can become sources: file paths, or http(s) links.
  function droppedItems(dt) {
    const files = [...(dt.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
    if (files.length) return files;
    const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    const text = uris.length ? uris : [(dt.getData('text/plain') || '').trim()];
    return text.filter((u) => /^https?:\/\/\S+$/i.test(u)).slice(0, 20);
  }

  const canDrop = (dt) => !!dt && [...(dt.types || [])].some((x) => x === 'Files' || x === 'text/uri-list' || x === 'text/plain');
  let dragDepth = 0;

  function dragDone(state) {
    dragDepth = 0;
    panel.classList.remove('dropping');
    api.drag(state);
  }

  document.addEventListener('dragenter', (e) => {
    if (!canDrop(e.dataTransfer)) return;
    e.preventDefault();
    if (dragDepth++ === 0) {
      panel.classList.add('dropping');
      panel.classList.remove('fading');
      api.drag('over');
    }
  });
  document.addEventListener('dragover', (e) => {
    // Always handled here: otherwise the page would open the dropped file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = canDrop(e.dataTransfer) && !pendingTrust ? 'copy' : 'none';
  });
  document.addEventListener('dragleave', () => {
    // Entering a child element comes before leaving the previous one: the count reaches 0 only outside.
    if (dragDepth && --dragDepth === 0) dragDone('leave');
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const items = droppedItems(e.dataTransfer);
    dragDone('drop');
    if (pendingTrust || view !== 'chat') return;
    if (mini) setMini(false);
    if (!items.length) {
      setStatus(t('sources.dropNothing'), 'err');
      return;
    }
    reportSources(await api.addSources(items));
    input.focus();
  });

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

  // ---------- settings (see settings.js) ----------

  async function showSettings(on) {
    if (on && view === 'settings') return;
    if (on && srcOpen) closeSources(true);
    if (on && view === 'history') await showHistory(false);
    view = on ? 'settings' : 'chat';
    refreshPalette();
    $('settings-btn').setAttribute('aria-pressed', String(on));
    settingsBox.hidden = !on;
    thread.hidden = on;
    panel.classList.toggle('in-settings', on); // no tabs, chips or history while editing
    if (on) {
      setStatus('');
      await window.AskaSettings.open();
    } else {
      scrollEnd(true);
      input.focus();
    }
    syncOpen();
    setKeys();
  }

  async function showHistory(on) {
    if (on && srcOpen) closeSources(true);
    view = on ? 'history' : 'chat';
    refreshPalette();
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
    const is = (action) => isKey(e, action);
    if (is('toggleMini')) {
      e.preventDefault();
      setMini(!mini);
      return;
    }
    if (is('toggleWide') && !mini) {
      e.preventDefault();
      toggleWide();
      return;
    }
    if (is('togglePin') && !mini) {
      e.preventDefault();
      setPinned(!pinned, true);
      return;
    }
    // Settings: the form keeps the keyboard; Esc (or the settings shortcut) closes it.
    if (view === 'settings') {
      if (e.key === 'Escape' || is('settings')) {
        e.preventDefault();
        window.AskaSettings.requestClose();
      }
      return;
    }
    if (is('settings') && !mini && !pendingTrust && !menuOpen && !srcOpen) {
      e.preventDefault();
      showSettings(true);
      return;
    }
    if (!mini && !pendingTrust && !menuOpen && !srcOpen) {
      // Ctrl+1 to Ctrl+9 stay fixed: tab n°1 to 8, Ctrl+9 the last one.
      const tabNumber = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key) && tabList.length > 1;
      const tabKey =
        is('newTab') ? () => newConversation()
        : is('closeTab') ? () => closeTab()
        : is('nextTab') ? () => cycleTab(1)
        : is('prevTab') ? () => cycleTab(-1)
        : tabNumber ? () => activateTab((e.key === '9' ? tabList[tabList.length - 1] : tabList[Number(e.key) - 1] || {}).id)
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
      if (e.key === 'Escape' || is('modelMenu')) { e.preventDefault(); closeModelMenu(); }
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
    if (srcOpen) {
      const sel = sources[srcSel];
      if (e.key === 'Escape' || is('sources')) { e.preventDefault(); closeSources(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); highlightSource(srcSel + 1, true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlightSource(srcSel - 1, true); }
      else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        // Nothing typed: the file picker.
        if (!srcInput.value.trim()) pickSources();
        else addSource(srcInput.value).then((ok) => { if (ok) srcInput.value = ''; });
      } else if (e.key === 'Delete' && sel && srcInput.selectionStart === srcInput.value.length) {
        // "Del" targets the selected document when there is nothing left to erase in the field.
        e.preventDefault();
        removeSource(sel.key);
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
      } else if (is('history')) { e.preventDefault(); showHistory(false); }
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
    if (cmdOpen() && e.target === input && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const it = cmdItems[cmdSel];
      const key =
        e.key === 'ArrowDown' ? () => highlightCmd(cmdSel + 1, true)
        : e.key === 'ArrowUp' ? () => highlightCmd(cmdSel - 1, true)
        : e.key === 'Tab' && !e.shiftKey ? () => acceptCmd(it, false)
        : e.key === 'Enter' && !e.shiftKey && !e.isComposing ? () => acceptCmd(it, true)
        : e.key === 'Escape' ? () => { cmdDismissed = input.value; refreshPalette(); }
        : null;
      if (key) {
        e.preventDefault();
        key();
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (running) api.cancel(convId);
      else api.hide();
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      if (e.shiftKey) cycleMode();
      else cycleAgent(1);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (is('modelMenu')) {
      e.preventDefault();
      openModelMenu();
    } else if (is('rerun')) {
      // Same as the button of the last answer, if it has one.
      e.preventDefault();
      const b = thread.querySelector('.turn:last-child .notice .rerun');
      if (b && !running) b.click();
    } else if (is('copyAnswer')) {
      e.preventDefault();
      if (lastAnswer) api.copy(lastAnswer).then(() => setStatus(t('status.copied'), 'ok'));
    } else if (is('pickDir')) {
      e.preventDefault();
      if (!running) api.pickDir().then(applyState);
    } else if (is('history')) {
      e.preventDefault();
      if (!$('hist-btn').hidden) showHistory(true);
    } else if (is('sources')) {
      e.preventDefault();
      openSources();
    } else if (e.key === 'ArrowUp' && e.target === input && !input.value.slice(0, input.selectionStart).includes('\n')) {
      if (historyMove(-1)) e.preventDefault();
    } else if (e.key === 'ArrowDown' && e.target === input && histIdx !== -1) {
      if (historyMove(1)) e.preventDefault();
    }
  });

  input.addEventListener('input', () => {
    histIdx = -1;
    autosize();
    refreshPalette();
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
  $('sources').addEventListener('click', openSources);
  srcInput.addEventListener('input', () => { if (srcError) { srcError = ''; renderSources(); } });
  $('src-pick').addEventListener('click', pickSources);
  $('src-refresh').addEventListener('click', () => { loadSourceInfo(true); srcInput.focus(); });
  $('trust-once').addEventListener('click', () => submit('once'));
  $('trust-always').addEventListener('click', () => submit('always'));
  $('trust-cancel').addEventListener('click', closeConfirm);
  $('mini-btn').addEventListener('click', () => setMini(!mini));
  $('wide-btn').addEventListener('click', () => {
    toggleWide();
    input.focus();
  });
  // Click outside: the panel fades for a moment before hiding (time to drop a file on it).
  api.onFading((on) => panel.classList.toggle('fading', on === true && !panel.classList.contains('dropping')));
  $('close-btn').addEventListener('click', () => api.hide());
  $('new-btn').addEventListener('click', newConversation);
  $('hist-btn').addEventListener('click', () => showHistory(view !== 'history'));
  $('settings-btn').addEventListener('click', () => (view === 'settings' ? window.AskaSettings.requestClose() : showSettings(true)));
  window.AskaSettings.init(settingsBox, {
    api,
    t,
    modeLabel: (m) => (modes[m] ? modes[m].label : m),
    onClose: () => showSettings(false),
    onSaved: (s) => applyState(s), // language, shortcuts, tooltips… applied at once
  });

  // The window follows the panel size (minimized, expanded, growing thread).
  new ResizeObserver(() => {
    const pad = 2 * parseFloat(getComputedStyle(document.body).paddingLeft);
    api.resize({ w: panel.offsetWidth + pad, h: panel.offsetHeight + pad });
  }).observe(panel);

  // ---------- display lifecycle ----------

  api.onRunEvent(onRunEvent);
  api.onNewConversation(() => newConversation()); // system tray icon menu
  api.onOpenSettings(() => showSettings(true)); // system tray icon menu
  // "Ask about the selection": the selected text, quoted, before the draft; nothing is sent.
  api.onSelection(async (sel) => {
    if (!sel || !sel.quote) {
      setStatus(t('selection.empty'), 'err');
      return;
    }
    if (view === 'settings') window.AskaSettings.requestClose();
    if (view === 'history') await showHistory(false);
    if (menuOpen) closeModelMenu();
    if (view !== 'chat' || pendingTrust) return; // unsaved settings or an approval waiting: left as is
    setMini(false);
    const rest = input.value.trim();
    setInput(sel.quote + '\n\n' + (rest ? rest : ''));
    input.scrollTop = input.scrollHeight;
    input.focus();
    if (sel.truncated) setStatus(t('selection.truncated', { max: Number(sel.max).toLocaleString(locale) }), 'err');
    else if (sel.source === 'clipboard') setStatus(t('selection.fromClipboard'));
    else setStatus('');
  });
  api.onUnread(setUnread);
  $('pin-btn').addEventListener('click', () => { setPinned(!pinned, true); input.focus(); });
  api.onWillHide(() => {
    panel.classList.remove('in');
    panel.classList.add('out');
  });
  api.onShown((s) => {
    applyState(s);
    setMini(false);
    if (wideOnShow) {
      wideOnShow = false;
      if (thread.childElementCount && wideChoice.get(convId) !== false) setWide(true);
    }
    panel.classList.remove('out', 'in');
    void panel.offsetWidth;
    panel.classList.add('in');
    if (!pendingTrust && !menuOpen && !srcOpen && view === 'chat') input.focus();
    setKeys();
    autosize();
  });

  api.getState().then((s) => {
    applyState(s);
    setKeys();
    autosize();
  });
})();
