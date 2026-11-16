'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const panel = $('panel');
  const input = $('input');
  const agentBtn = $('agent');
  const modeBtn = $('mode');
  const result = $('result');
  const output = $('output');
  const activity = $('activity');
  const notice = $('notice');
  const confirmBox = $('confirm');
  const status = $('status');
  const keys = $('keys');
  const api = window.aska;

  let agents = [];
  let modes = {};
  let agentId = null;
  let mode = 'read';
  let runId = null;
  let running = false;
  let buffer = '';
  let denied = null;
  let streamError = null;
  let renderTimer = null;
  let history = [];
  let histIdx = -1;
  let draft = '';
  let pendingTrust = false;
  let warnings = [];

  const agent = () => agents.find((a) => a.id === agentId) || null;

  function replay(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // ---------- affichage ----------

  function setKeys() {
    const items = running
      ? [['Échap', 'annuler']]
      : pendingTrust
        ? []
        : buffer
          ? [['Ctrl ⇧ C', 'copier'], ['Tab', 'agent'], ['Échap', 'fermer']]
          : [['Tab', 'agent'], ['⇧ Tab', 'mode'], ['Échap', 'fermer']];
    keys.replaceChildren(
      ...items.map(([k, label]) => {
        const s = document.createElement('span');
        const kbd = document.createElement('kbd');
        kbd.textContent = k;
        s.append(kbd, label);
        return s;
      })
    );
  }

  function setStatus(text, cls) {
    status.textContent = text || '';
    status.className = 'status' + (cls ? ' ' + cls : '');
  }

  function showNotice(text, cls) {
    notice.hidden = !text;
    notice.textContent = text || '';
    notice.className = 'notice' + (cls ? ' ' + cls : '');
    if (text) result.classList.add('open');
  }

  function setMode(next, animate) {
    mode = next;
    modeBtn.dataset.mode = mode;
    $('mode-name').textContent = modes[mode] ? modes[mode].label : mode;
    modeBtn.title = `${modes[mode] ? modes[mode].hint : ''} — Maj+Tab pour changer`;
    if (animate) replay(modeBtn, 'swap');
  }

  function setAgent(id, animate) {
    const a = agents.find((x) => x.id === id);
    if (!a) return;
    agentId = id;
    panel.style.setProperty('--agent', a.color);
    $('agent-name').textContent = a.label;
    input.placeholder = `Demandez une action à ${a.label}…`;
    if (animate) replay(agentBtn, 'swap');
    // Un agent ne propose pas forcément tous les modes : on retombe sur le plus restrictif.
    if (!a.modes.includes(mode)) setMode(a.modes[0], animate);
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

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    $('enter-hint').classList.toggle('off', !input.value.trim() || running);
  }

  function render() {
    renderTimer = null;
    const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    output.replaceChildren(window.renderMarkdown(buffer));
    if (nearBottom) output.scrollTop = output.scrollHeight;
  }
  function scheduleRender() {
    if (!renderTimer) renderTimer = setTimeout(render, 45);
  }

  function setActivity(text) {
    activity.hidden = !text;
    $('activity-text').textContent = text || '';
  }

  function applyState(s) {
    modes = s.modes;
    agents = s.agents.filter((a) => a.available);
    history = s.history || [];
    warnings = s.warnings || [];
    $('cwd-name').textContent = s.cwd;
    $('cwd').title = (s.cwdIsScratch ? 'Dossier vide réservé à Aska' : s.cwd) + ' — Ctrl+O pour choisir un dossier';
    if (!agents.length) {
      input.disabled = true;
      input.placeholder = 'Aucun agent détecté';
      $('agent-name').textContent = 'Aucun';
      const hints = s.agents.map((a) => `${a.label} : ${a.install || a.error}`).join('\n');
      showNotice(`Aucun CLI d'agent trouvé dans le PATH.\n${hints}`, 'warn');
      return;
    }
    input.disabled = false;
    if (!agentId || !agent()) {
      const preferred = agents.find((a) => a.id === s.defaultAgent) || agents[0];
      if (!modes[mode] || !agentId) mode = s.defaultMode;
      setAgent(preferred.id, false);
    }
    const a = agent();
    setMode(a.modes.includes(mode) ? mode : a.modes[0], false);
    if (warnings.length && !buffer && !running) showNotice(warnings.join('\n'), 'warn');
  }

  // ---------- exécution ----------

  function closeConfirm() {
    pendingTrust = false;
    confirmBox.hidden = true;
    setKeys();
    input.focus();
  }

  async function submit(trust) {
    const prompt = input.value.trim();
    if (running || !prompt || !agent()) return;
    const res = await api.run({ agentId, mode, prompt, trust });
    if (res.needsTrust) {
      pendingTrust = true;
      confirmBox.dataset.mode = res.mode;
      const what = res.mode === 'auto' ? 'modifier des fichiers et lancer des commandes' : 'modifier des fichiers';
      $('confirm-text').textContent = `Autoriser ${res.agent} à ${what} dans « ${res.cwd} » ?`;
      confirmBox.hidden = false;
      $('trust-once').focus();
      setKeys();
      return;
    }
    pendingTrust = false;
    confirmBox.hidden = true;
    if (res.error) {
      showNotice(res.error, 'error');
      replay(panel, 'in');
      return;
    }
    runId = res.id;
    running = true;
    buffer = '';
    denied = null;
    streamError = null;
    if (history[history.length - 1] !== prompt) history.push(prompt);
    histIdx = -1;
    output.replaceChildren();
    showNotice('');
    setActivity('Démarrage…');
    result.classList.add('open');
    panel.dataset.state = 'running';
    setStatus('');
    setKeys();
    autosize();
    input.focus();
  }

  function onRunEvent(ev) {
    if (ev.id !== runId) return;
    switch (ev.type) {
      case 'text':
        buffer += ev.text;
        scheduleRender();
        break;
      case 'activity':
        setActivity(ev.text);
        break;
      case 'stderr': {
        const last = ev.text.trim().split('\n').pop();
        if (last) setActivity(last.slice(0, 160));
        break;
      }
      case 'meta':
        if (ev.model) setStatus(ev.model);
        break;
      case 'denied':
        denied = ev;
        break;
      case 'error':
        streamError = ev.text;
        break;
      case 'end':
        finish(ev);
        break;
      default:
    }
  }

  function finish(ev) {
    running = false;
    clearTimeout(renderTimer);
    render();
    setActivity('');
    const secs = (ev.durationMs / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
    if (ev.ok && !streamError) {
      panel.dataset.state = 'done';
      setStatus(`Terminé en ${secs} s`, 'ok');
      if (denied) {
        showNotice(
          `${denied.count} action(s) refusée(s) par le mode « ${modes[mode].label} » (${denied.tools.join(', ')}). Maj+Tab pour changer de mode, puis relancez.`,
          'warn'
        );
      }
    } else {
      panel.dataset.state = 'error';
      const why = {
        cancel: 'Annulé',
        timeout: `Arrêté : délai de ${ev.timeoutSec} s dépassé`,
        overflow: 'Arrêté : sortie trop volumineuse',
        'spawn-error': `Lancement impossible : ${ev.error}`,
      }[ev.reason] || streamError || `Le CLI s'est terminé avec le code ${ev.code}`;
      setStatus(ev.reason === 'cancel' ? 'Annulé' : 'Échec', 'err');
      if (ev.reason !== 'cancel') showNotice([why, ev.stderr].filter(Boolean).join('\n\n'), 'error');
      else if (!buffer) result.classList.remove('open');
    }
    setKeys();
    autosize();
  }

  function clearAll() {
    if (running) return;
    buffer = '';
    output.replaceChildren();
    showNotice('');
    setActivity('');
    result.classList.remove('open');
    panel.dataset.state = 'idle';
    setStatus('');
    input.value = '';
    autosize();
    setKeys();
  }

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

  document.addEventListener('keydown', (e) => {
    if (pendingTrust) {
      if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(e.shiftKey ? 'always' : 'once'); }
      else if (e.key !== 'Tab') e.preventDefault();
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
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      if (buffer) api.copy(buffer).then(() => setStatus('Copié', 'ok'));
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      if (!running) api.pickDir().then(applyState);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      clearAll();
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
  $('cwd').addEventListener('click', () => { if (!running) api.pickDir().then(applyState); });
  $('cwd').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!running) api.resetDir().then(applyState);
  });
  $('trust-once').addEventListener('click', () => submit('once'));
  $('trust-always').addEventListener('click', () => submit('always'));
  $('trust-cancel').addEventListener('click', closeConfirm);
  // Un clic dans la zone transparente autour du panneau referme le lanceur.
  document.addEventListener('mousedown', (e) => {
    if (e.target === document.body || e.target === document.documentElement) api.hide();
  });

  // ---------- cycle d'affichage ----------

  api.onRunEvent(onRunEvent);
  api.onWillHide(() => {
    panel.classList.remove('in');
    panel.classList.add('out');
  });
  api.onShown((s) => {
    applyState(s);
    panel.classList.remove('out', 'in');
    void panel.offsetWidth;
    panel.classList.add('in');
    if (!pendingTrust) {
      input.focus();
      input.select();
    }
    setKeys();
    autosize();
  });

  api.getState().then((s) => {
    applyState(s);
    setKeys();
    autosize();
  });
})();
