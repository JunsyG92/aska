'use strict';
// Tasks view: several bots at once, each in its own worktree (see
// src/main/tasks/). Four steps: a new task (goal, folder, orchestrator), the
// plan to review (approving it is the consent for the rights it lists), the
// live board, and its actions. Built without innerHTML; the main process
// checks everything again.

(function () {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const GOAL_MAX = 2000;
  const PROMPT_MAX = 20000;
  const RUNNING = new Set(['queued', 'running']);

  let root = null;
  let opts = {};
  let page = 'list'; // 'list' (and a task's board) | 'new' (form, then the plan to review)
  let tasks = [];
  let current = null; // id of the task shown on the board
  let form = { goal: '', root: '', orchestrator: '' };
  let defaultRoot = '';
  let planning = false;
  let review = null; // { plan, agent, items: [{ include, mode, prompt, allow }] }
  const openLogs = new Set(); // "<task>/<n>" whose journal is shown
  let armed = null; // action waiting for a second click: 'cleanup'
  let message = { text: '', kind: '' };
  let busy = false;
  let prBusy = null; // "<task>/<n>" being pushed

  const t = (k, p) => opts.t(k, p);
  const task = () => tasks.find((x) => x.id === current) || null;

  function setMessage(text, kind = '') {
    message = { text: text || '', kind };
    const m = root && root.querySelector('.set-message');
    if (m) {
      m.textContent = message.text;
      m.dataset.kind = kind;
    }
  }

  const button = (text, onClick, cls = 'set-btn small', action) => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (action) b.dataset.action = action;
    b.addEventListener('click', onClick);
    return b;
  };

  function avatar(bot) {
    const img = el('img', 'tk-av');
    img.alt = '';
    img.src = bot && bot.image ? bot.image : window.AskaAvatar.avatarDataUrl((bot && bot.label) || '?', { ...((bot && bot.avatar) || {}), color: (bot && bot.color) || null });
    return img;
  }

  // ---------- step 1: a new task ----------

  async function planNow() {
    if (planning) return;
    const goal = form.goal.trim();
    if (!goal) return setMessage(t('tasks.goalMissing'), 'err');
    if (!form.root.trim()) return setMessage(t('tasks.rootMissing'), 'err');
    planning = true;
    review = null;
    render();
    setMessage(t('tasks.planning'));
    const r = await opts.api.planTask({ goal, root: form.root.trim(), botId: form.orchestrator || undefined });
    planning = false;
    if (r.cancelled) {
      render();
      return setMessage(t('tasks.planCancelled'));
    }
    if (r.error) {
      render();
      return setMessage(r.error, 'err');
    }
    review = { plan: r.plan, agent: r.agent, items: itemsOf(r.plan.subtasks), auto: false };
    render();
    setMessage('');
    const first = root.querySelector('.tk-plan-item input');
    if (first) first.focus();
  }

  async function pickRoot() {
    const r = await opts.api.pickTaskRoot(form.root.trim() || defaultRoot);
    if (r && r.path) {
      form.root = r.label || r.path;
      render();
    }
  }

  function newPage() {
    if (review) return reviewPage();
    const goal = el('textarea', 'set-textarea short tk-goal');
    goal.rows = 3;
    goal.maxLength = GOAL_MAX;
    goal.value = form.goal;
    goal.placeholder = t('tasks.goalPlaceholder');
    goal.dataset.focusKey = 'task-goal';
    goal.disabled = planning;
    goal.setAttribute('aria-label', t('tasks.goal'));
    goal.addEventListener('input', () => { form.goal = goal.value; });

    const folder = el('input', 'set-input tk-root');
    folder.type = 'text';
    folder.spellcheck = false;
    folder.value = form.root;
    folder.placeholder = t('tasks.rootPlaceholder');
    folder.dataset.focusKey = 'task-root';
    folder.disabled = planning;
    folder.setAttribute('aria-label', t('tasks.root'));
    folder.addEventListener('input', () => { form.root = folder.value; });
    const pick = button(t('tasks.pick'), pickRoot, 'set-btn small');
    pick.disabled = planning;
    const folderBox = el('div', 'set-inline wrap');
    folderBox.append(folder, pick);

    const orch = el('select', 'set-select tk-orchestrator');
    orch.setAttribute('aria-label', t('tasks.orchestrator'));
    const none = el('option', null, t('tasks.defaultAgent'));
    none.value = '';
    orch.append(none);
    for (const b of opts.bots()) {
      const o = el('option', null, `${b.label} (@${b.id})`);
      o.value = b.id;
      orch.append(o);
    }
    orch.value = form.orchestrator;
    orch.disabled = planning;
    orch.addEventListener('change', () => { form.orchestrator = orch.value; });

    const row = (label, control, hint) => {
      const r = el('div', 'set-row wide');
      const l = el('label', 'set-label', label);
      r.append(l, control);
      if (hint) r.append(el('div', 'set-hint', hint));
      return r;
    };
    const s = el('section', 'set-section');
    s.append(
      el('h3', 'set-title', t('tasks.newTitle')),
      row(t('tasks.goal'), goal),
      row(t('tasks.root'), folderBox, t('tasks.rootHint')),
      row(t('tasks.orchestrator'), orch, t('tasks.orchestratorHint'))
    );
    const body = [s];
    if (planning) {
      const wait = el('div', 'tk-wait');
      wait.append(el('span', 'spinner'), el('span', null, t('tasks.planning')));
      body.push(wait);
    }
    const actions = planning
      ? [button(t('tasks.cancelPlan'), () => opts.api.cancelTaskPlan(), 'set-btn', 'cancel-plan')]
      : [button(t('tasks.propose'), planNow, 'set-btn primary', 'propose')];
    return { body, actions };
  }

  // ---------- step 2: the plan to review ----------

  // What a subtask may do, as approved: writes, runs commands, acts remotely.
  function warnings(item, rights) {
    const writing = item.mode !== 'read';
    const cmds = writing && rights.commands ? item.allow : [];
    const remote = cmds.filter((c) => rights.remote.includes(c));
    const w = [];
    if (writing) w.push(['write', t('tasks.warn.write')]);
    if (cmds.length > remote.length) w.push(['run', t('tasks.warn.run')]);
    if (remote.length) w.push(['remote', t('tasks.warn.remote')]);
    if (item.mode === 'auto') w.push(['auto', t('tasks.warn.auto')]);
    return w;
  }

  // What the review edits, for each subtask of a plan or of a next wave.
  const itemsOf = (subtasks) =>
    subtasks.map((s) => ({
      include: true,
      mode: s.rights.modes.includes(s.mode) ? s.mode : s.rights.modes[Math.min(1, s.rights.modes.length - 1)],
      prompt: s.prompt,
      allow: [...s.rights.allow],
    }));

  function planItem(s, item, i) {
    const r = s.rights;
    const card = el('div', 'tk-plan-item' + (item.include ? '' : ' off') + (s.newRights && s.newRights.length ? ' new-rights' : ''));
    card.dataset.n = String(i + 1);

    const head = el('div', 'tk-plan-head');
    const check = el('input', 'tk-check');
    check.type = 'checkbox';
    check.checked = item.include;
    check.setAttribute('aria-label', t('tasks.include', { n: i + 1 }));
    check.addEventListener('change', () => {
      item.include = check.checked;
      render();
    });
    const who = el('div', 'tk-who');
    const name = el('b', null, r.bot.label);
    const tag = r.bot.id ? `@${r.bot.id}` : r.bot.copyOf ? t('tasks.copyOf', { bot: r.bot.copyOf }) : t('tasks.temporary');
    who.append(name, el('span', 'tk-tag', tag), el('span', 'tk-repo', s.repoLabel));
    if (s.continues) who.append(el('span', 'tk-tag', t('tasks.continues', { n: s.continues })));
    const badges = el('div', 'tk-badges');
    if (s.newRights && s.newRights.length) badges.append(el('span', 'tk-badge new', t('tasks.warn.new')));
    for (const [kind, text] of warnings(item, r)) badges.append(el('span', `tk-badge ${kind}`, text));
    head.append(check, avatar(r.bot), who, badges);
    card.append(head);
    if (!item.include) return card;
    // A next wave asking for more than the task was granted: said, reviewed.
    if (s.newRights && s.newRights.length) card.append(el('div', 'tk-new-rights', t('tasks.newRights', { list: s.newRights.join(' ; ') })));

    const mode = el('select', 'set-select small');
    mode.setAttribute('aria-label', t('tasks.mode'));
    for (const m of r.modes) {
      const o = el('option', null, opts.modeLabel(m));
      o.value = m;
      mode.append(o);
    }
    mode.value = item.mode;
    mode.addEventListener('change', () => {
      item.mode = mode.value;
      render();
    });

    const prompt = el('textarea', 'set-textarea short');
    prompt.rows = 3;
    prompt.maxLength = PROMPT_MAX;
    prompt.value = item.prompt;
    prompt.dataset.focusKey = `plan-prompt-${i}`;
    prompt.setAttribute('aria-label', t('tasks.instruction'));
    prompt.addEventListener('input', () => { item.prompt = prompt.value; });

    const meta = el('div', 'tk-plan-meta');
    meta.append(el('span', 'set-label', t('tasks.mode')), mode, el('span', 'tk-agent', r.agent));
    card.append(meta, prompt);

    // Its commands: unchecked ones are not granted (the plan can only lower them).
    if (r.allow.length) {
      const box = el('div', 'tk-cmds' + (item.mode === 'read' || !r.commands ? ' inactive' : ''));
      box.append(el('span', 'set-label', t('tasks.commands')));
      for (const c of r.allow) {
        const lab = el('label', 'tk-cmd' + (r.remote.includes(c) ? ' remote' : ''));
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = item.allow.includes(c);
        cb.addEventListener('change', () => {
          item.allow = cb.checked ? r.allow.filter((x) => x === c || item.allow.includes(x)) : item.allow.filter((x) => x !== c);
          render();
        });
        lab.append(cb, el('code', null, c));
        if (r.remote.includes(c)) lab.append(el('span', 'tk-remote', t('tasks.warn.remote')));
        box.append(lab);
      }
      if (item.mode === 'read') box.append(el('span', 'set-hint', t('tasks.commandsReadOnly')));
      card.append(box);
    }
    return card;
  }

  // The subtasks as approved: an existing bot with fewer commands becomes a copy of it.
  function approved(subtasks, items) {
    const out = [];
    subtasks.forEach((s, i) => {
      const item = items[i];
      if (!item.include) return;
      const sub = { repo: s.repo, prompt: item.prompt.trim(), mode: item.mode, ...(s.continues ? { continues: s.continues } : {}) };
      const fewer = s.rights.commands && item.allow.length !== s.rights.allow.length;
      if (s.botId) Object.assign(sub, fewer ? { bot: { copyOf: s.botId, allow: item.allow } } : { botId: s.botId });
      else sub.bot = fewer ? { ...s.bot, allow: item.allow } : s.bot;
      out.push(sub);
    });
    return out;
  }

  async function approveNow() {
    if (busy) return;
    const subtasks = approved(review.plan.subtasks, review.items);
    if (!subtasks.length) return setMessage(t('tasks.noneChosen'), 'err');
    if (subtasks.some((s) => !s.prompt)) return setMessage(t('tasks.promptMissing'), 'err');
    busy = true;
    const c = await opts.api.createTask({ goal: review.plan.goal, root: review.plan.root, subtasks, orchestrator: form.orchestrator || undefined, auto: review.auto });
    if (c.error) {
      busy = false;
      return setMessage(c.error, 'err');
    }
    const s = await opts.api.startTask(c.task.id);
    busy = false;
    upsert(c.task);
    review = null;
    form = { goal: '', root: form.root, orchestrator: form.orchestrator };
    page = 'list';
    current = c.task.id;
    render();
    setMessage(s && s.error ? s.error : t('tasks.started'), s && s.error ? 'err' : 'ok');
  }

  function reviewPage() {
    const p = review.plan;
    const head = el('section', 'set-section tk-review-head');
    head.append(el('h3', 'set-title', t('tasks.reviewTitle')));
    const goal = el('p', 'tk-goal-text', p.goal);
    const facts = el('p', 'set-hint', t('tasks.reviewFacts', { root: p.rootLabel || p.root, agent: review.agent }));
    head.append(goal, facts);
    if (p.summary) head.append(el('p', 'tk-summary', p.summary));
    if (p.notes && p.notes.length) {
      const notes = el('ul', 'tk-notes');
      for (const n of p.notes) notes.append(el('li', null, n));
      head.append(notes);
    }
    head.append(el('p', 'set-hint', t('tasks.consent')));
    // Next waves: by themselves when they ask for nothing new, otherwise reviewed here again.
    const auto = el('label', 'tk-auto');
    const autoBox = el('input', 'tk-check');
    autoBox.type = 'checkbox';
    autoBox.checked = review.auto;
    autoBox.dataset.focusKey = 'auto';
    autoBox.addEventListener('change', () => { review.auto = autoBox.checked; });
    auto.append(autoBox, el('span', null, t('tasks.autoContinue')));
    head.append(auto, el('p', 'set-hint', t('tasks.autoHint')));
    const list = el('div', 'tk-plan');
    p.subtasks.forEach((s, i) => list.append(planItem(s, review.items[i], i)));
    const n = review.items.filter((x) => x.include).length;
    const ok = button(t('tasks.approve', { count: n }), approveNow, 'set-btn primary', 'approve');
    ok.disabled = !n || busy;
    const back = button(t('tasks.back'), () => {
      review = null;
      render();
      setMessage('');
    }, 'set-btn', 'back');
    return { body: [head, list], actions: [back, ok] };
  }

  // ---------- steps 3 and 4: the board and its actions ----------

  function upsert(x) {
    const i = tasks.findIndex((y) => y.id === x.id);
    if (i === -1) tasks.unshift(x);
    else tasks[i] = x;
  }

  async function act(fn, okText) {
    if (busy) return;
    busy = true;
    const r = await fn();
    busy = false;
    if (r && r.task) upsert(r.task);
    if (r && r.state) opts.onState(r.state);
    if (r && r.error) setMessage(r.error, 'err');
    else if (okText) setMessage(okText, 'ok');
    render();
    return r;
  }

  // Two steps: the first click shows what will run, the second runs it.
  async function prNow(x, s) {
    const key = `${x.id}/${s.n}`;
    if (armed !== `pr:${key}`) {
      armed = `pr:${key}`;
      render();
      return setMessage('');
    }
    if (prBusy) return;
    armed = null;
    prBusy = key;
    render();
    setMessage(t('tasks.prRunning'));
    const r = await opts.api.openTaskPr(x.id, s.n);
    prBusy = null;
    if (r && r.task) upsert(r.task);
    render();
    if (r && r.url) setMessage(t('tasks.prOpened', { url: r.url }), 'ok');
    else setMessage((r && r.error) || '', 'err');
  }

  async function cleanupNow(x) {
    if (armed !== 'cleanup') {
      armed = 'cleanup';
      render();
      return setMessage(t('tasks.cleanupConfirm'), 'warn');
    }
    armed = null;
    const r = await act(() => opts.api.cleanupTask(x.id));
    if (r && r.ok) {
      tasks = tasks.filter((y) => y.id !== x.id);
      current = null;
      render();
      setMessage(t('tasks.cleaned'), 'ok');
    }
  }

  const repoOf = (x, s) => (s.repo.startsWith(x.root) ? s.repo.slice(x.root.length).replace(/^[\\/]+/, '') || '.' : s.repo);

  function subRow(x, s) {
    const key = `${x.id}/${s.n}`;
    const row = el('div', 'tk-sub');
    row.dataset.n = String(s.n);
    row.dataset.status = s.status;
    const head = el('div', 'tk-plan-head');
    const who = el('div', 'tk-who');
    who.append(el('b', null, s.bot.label), el('span', 'tk-tag', s.kept ? `@${s.kept}` : s.temporary ? t('tasks.temporary') : `@${s.bot.id}`), el('span', 'tk-repo', repoOf(x, s)));
    if (s.continues) who.append(el('span', 'tk-tag', t('tasks.continues', { n: s.continues })));
    const st = el('span', `tk-status ${s.status}`, t(`tasks.status.${s.status}`));
    head.append(avatar(s.bot), who, st);
    row.append(head);

    const facts = [];
    if (s.branch) facts.push(s.branch);
    if (s.summary) {
      if (s.summary.commits.length) facts.push(t('tasks.commits', { count: s.summary.commits.length }));
      if (s.summary.changes) facts.push(s.summary.changes);
      if (s.summary.uncommitted) facts.push(t('tasks.uncommitted', { count: s.summary.uncommitted }));
    }
    if (facts.length) row.append(el('div', 'tk-facts', facts.join(' · ')));
    if (s.error) row.append(el('div', 'set-error', s.error));

    // Its report (the agent's text, shown as text), or why it is to check.
    if (s.report) {
      const rep = el('div', 'tk-report');
      rep.append(el('div', 'tk-log-title', t('tasks.report')));
      if (s.report.summary) rep.append(el('p', 'tk-summary', s.report.summary));
      if (s.report.status === 'partial') rep.append(el('p', 'set-hint', t('tasks.partial')));
      if (s.report.followUp) rep.append(el('p', 'set-hint', t('tasks.followUp', { text: s.report.followUp })));
      row.append(rep);
    } else if (s.status === 'check') row.append(el('div', 'set-hint', t('tasks.noReport')));

    const bar = el('div', 'tk-sub-actions');
    const finished = s.status === 'done' || s.status === 'check';
    const commits = s.summary && s.summary.commits ? s.summary.commits.length : 0;
    if (s.pr && s.pr.url) {
      bar.append(button(t('tasks.viewPr'), () => opts.api.openUrl(s.pr.url), 'set-btn small primary', 'view-pr'));
    } else if (finished && s.branch && commits) {
      const pending = prBusy === key;
      const pr = button(t(pending ? 'tasks.prRunning' : 'tasks.openPr'), () => prNow(x, s), 'set-btn small primary', 'pr');
      pr.disabled = pending;
      bar.append(pr);
    }
    const logOpen = openLogs.has(key);
    const log = button(t(logOpen ? 'tasks.hideLog' : 'tasks.showLog'), () => {
      if (openLogs.has(key)) openLogs.delete(key);
      else openLogs.add(key);
      render();
    }, 'set-btn small outline', 'log');
    log.setAttribute('aria-expanded', String(logOpen));
    bar.append(log);
    if (RUNNING.has(s.status)) bar.append(button(t('tasks.cancel'), () => act(() => opts.api.cancelTask(x.id, s.n)), 'set-btn small', 'cancel'));
    if (s.status === 'failed' || s.status === 'cancelled' || s.status === 'check') bar.append(button(t('tasks.rerun'), () => act(() => opts.api.startTask(x.id, [s.n])), 'set-btn small', 'rerun'));
    if (s.temporary && !s.kept && !RUNNING.has(s.status)) {
      bar.append(button(t('tasks.keepBot'), () => act(() => opts.api.keepTaskBot(x.id, s.n)).then((r) => r && r.botId && setMessage(t('tasks.kept', { bot: r.botId }), 'ok')), 'set-btn small', 'keep'));
    }
    row.append(bar);

    // The confirmation: what Aska is about to run, outside the machine.
    if (armed === `pr:${key}`) {
      const box = el('div', 'tk-confirm');
      box.setAttribute('role', 'alertdialog');
      box.append(el('p', null, t('tasks.prConfirm', { branch: s.branch, title: s.prTitle || '' })));
      const go = button(t('tasks.prConfirmButton'), () => prNow(x, s), 'set-btn small primary', 'pr-confirm');
      const no = button(t('settings.cancel'), () => {
        armed = null;
        render();
      }, 'set-btn small', 'pr-cancel');
      const line = el('div', 'tk-sub-actions');
      line.append(go, no);
      box.append(line);
      row.append(box);
    }

    if (logOpen) {
      const box = el('div', 'tk-log');
      box.append(el('div', 'tk-log-title', t('tasks.instruction')), el('p', 'tk-prompt', s.prompt));
      box.append(el('div', 'tk-log-title', t('tasks.answer')));
      const answer = el('div', 'tk-answer output');
      if (s.answer) answer.append(window.renderMarkdown(s.answer));
      else answer.append(el('span', 'set-hint', t(RUNNING.has(s.status) ? 'tasks.waiting' : 'tasks.noAnswer')));
      box.append(answer);
      row.append(box);
    }
    return row;
  }

  function boardPage(x) {
    const head = el('section', 'set-section tk-board-head');
    const title = el('div', 'tk-board-title');
    title.append(el('b', 'tk-goal-text', x.goal), el('span', `tk-status ${x.status}`, t(`tasks.taskStatus.${x.status}`)));
    const done = x.subtasks.filter((s) => s.status === 'done').length;
    head.append(title, el('p', 'set-hint', t('tasks.boardFacts', { root: x.root, done, total: x.subtasks.length })));
    // The whole task at a glance, once nothing runs any more.
    const o = x.overview;
    if (o && !o.running && !o.pending) head.append(el('p', 'tk-overview', t('tasks.overview', { done: o.done, check: o.check, failed: o.failed, prs: o.prs.length })));
    const list = el('div', 'tk-plan');
    // Grouped by wave, once there is more than one.
    let lastWave = 0;
    for (const s of x.subtasks) {
      const w = s.wave || 1;
      if ((x.wave || 1) > 1 && w !== lastWave) list.append(el('h3', 'set-title tk-wave', t('tasks.waveTitle', { n: w })));
      lastWave = w;
      list.append(subRow(x, s));
    }
    const body = [head, list];
    const running = x.subtasks.some((s) => RUNNING.has(s.status));
    // The next wave: being written, proposed for review, or nothing more to do.
    if (x.asking) {
      const wait = el('div', 'tk-wait');
      wait.append(el('span', 'spinner'), el('span', null, t('tasks.waveAsking', { n: x.nextWave && x.nextWave.n ? x.nextWave.n : (x.wave || 1) + 1 })));
      body.push(wait);
    } else if (x.proposal) body.push(...proposalBlock(x));
    else if (x.waveNote) body.push(el('p', 'tk-wave-note', x.waveNote));
    const actions = [button(t('tasks.allTasks'), () => {
      current = null;
      armed = null;
      render();
      setMessage('');
    }, 'set-btn', 'all')];
    if (x.asking) actions.push(button(t('tasks.cancelPlan'), () => opts.api.cancelTaskPlan(), 'set-btn', 'cancel-wave'));
    else if (!running && !x.proposal && !x.waveNote && x.nextWave && x.nextWave.n && x.status === 'done') {
      actions.push(button(t('tasks.proposeWave', { n: x.nextWave.n }), () => askWave(x), 'set-btn', 'wave'));
    }
    if (running) actions.push(button(t('tasks.cancelAll'), () => act(() => opts.api.cancelTask(x.id)), 'set-btn', 'cancel-all'));
    if (x.subtasks.some((s) => s.status === 'pending')) actions.push(button(t('tasks.start'), () => act(() => opts.api.startTask(x.id)), 'set-btn primary', 'start'));
    const clean = button(t(armed === 'cleanup' ? 'tasks.cleanupSure' : 'tasks.cleanup'), () => cleanupNow(x), 'set-btn danger' + (armed === 'cleanup' ? ' armed' : ''), 'cleanup');
    clean.disabled = running || !!x.asking;
    clean.title = t('tasks.cleanupHint');
    actions.push(clean);
    return { body, actions };
  }

  // ---------- next waves ----------

  let waveReview = null; // { id, n, items } for the proposal shown

  async function askWave(x) {
    if (busy) return;
    setMessage('');
    const r = await act(() => opts.api.proposeWave(x.id));
    if (r && r.done) setMessage(t('tasks.waveNothing'), 'ok');
  }

  function proposalBlock(x) {
    const p = x.proposal;
    if (!waveReview || waveReview.id !== x.id || waveReview.n !== p.n) waveReview = { id: x.id, n: p.n, items: itemsOf(p.subtasks) };
    const box = el('section', 'set-section tk-proposal');
    box.append(el('h3', 'set-title', t('tasks.waveProposed', { n: p.n })));
    if (p.summary) box.append(el('p', 'tk-summary', p.summary));
    if (p.notes && p.notes.length) {
      const notes = el('ul', 'tk-notes');
      for (const n of p.notes) notes.append(el('li', null, n));
      box.append(notes);
    }
    box.append(el('p', 'set-hint', t('tasks.waveConsent')));
    const list = el('div', 'tk-plan');
    p.subtasks.forEach((s, i) => list.append(planItem(s, waveReview.items[i], i)));
    const k = waveReview.items.filter((it) => it.include).length;
    const line = el('div', 'tk-sub-actions');
    const ok = button(t('tasks.approveWave', { count: k }), () => approveWaveNow(x), 'set-btn small primary', 'approve-wave');
    ok.disabled = !k || busy;
    line.append(ok, button(t('tasks.dismissWave'), () => act(() => opts.api.dismissWave(x.id)), 'set-btn small', 'dismiss-wave'));
    box.append(list, line);
    return [box];
  }

  async function approveWaveNow(x) {
    const subtasks = approved(x.proposal.subtasks, waveReview.items);
    if (!subtasks.length) return setMessage(t('tasks.noneChosen'), 'err');
    if (subtasks.some((s) => !s.prompt)) return setMessage(t('tasks.promptMissing'), 'err');
    const r = await act(() => opts.api.approveWave(x.id, subtasks));
    if (r && !r.error) {
      waveReview = null;
      setMessage(t('tasks.started'), 'ok');
    }
  }

  function listPage() {
    const x = task();
    if (x) return boardPage(x);
    if (!tasks.length) {
      const empty = el('div', 'hist-empty');
      empty.append(el('b', null, t('tasks.empty')), t('tasks.emptyHint'));
      return { body: [empty], actions: [button(t('tasks.new'), () => go('new'), 'set-btn primary', 'new')] };
    }
    const list = el('div', 'tk-list');
    for (const y of tasks) {
      const row = el('button', 'tk-item');
      row.type = 'button';
      row.dataset.id = y.id;
      const top = el('div', 'tk-board-title');
      top.append(el('b', 'tk-goal-text', y.goal), el('span', `tk-status ${y.status}`, t(`tasks.taskStatus.${y.status}`)));
      const done = y.subtasks.filter((s) => s.status === 'done').length;
      row.append(top, el('div', 'tk-facts', t('tasks.boardFacts', { root: y.root, done, total: y.subtasks.length })));
      row.addEventListener('click', () => {
        current = y.id;
        armed = null;
        render();
        setMessage('');
      });
      list.append(row);
    }
    return { body: [list], actions: [button(t('tasks.new'), () => go('new'), 'set-btn primary', 'new')] };
  }

  // ---------- frame ----------

  function go(p) {
    page = p;
    armed = null;
    if (p === 'new') current = null;
    render();
    setMessage('');
    const f = root.querySelector('.tk-goal, .tk-plan-item input, .tk-item');
    if (f) f.focus();
  }

  function render() {
    if (!root) return;
    const active = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = active ? active.dataset.focusKey || (active.dataset.action ? `action:${active.dataset.action}` : null) : null;
    const oldBody = root.querySelector('.set-body');
    const scroll = oldBody ? oldBody.scrollTop : 0;

    const tabs = el('div', 'set-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const p of ['list', 'new']) {
      const b = el('button', 'set-tab', p === 'list' ? t('tasks.tabs.list', { count: tasks.length }) : t('tasks.tabs.new'));
      b.type = 'button';
      b.dataset.page = p;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(page === p));
      b.addEventListener('click', () => {
        if (page === p && !(p === 'list' && current)) return;
        if (p === 'list') current = null;
        go(p);
      });
      tabs.append(b);
    }
    const { body, actions } = page === 'new' ? newPage() : listPage();
    const bodyEl = el('div', 'set-body tk-body');
    bodyEl.setAttribute('role', 'tabpanel');
    bodyEl.append(...body);
    const bar = el('div', 'set-actions');
    const msg = el('span', 'set-message', message.text);
    msg.dataset.kind = message.kind;
    msg.setAttribute('role', 'status');
    bar.append(msg, ...actions);
    root.replaceChildren(tabs, bodyEl, bar);
    bodyEl.scrollTop = scroll;
    if (focusKey) {
      const f = focusKey.startsWith('action:')
        ? root.querySelector(`[data-action="${focusKey.slice(7)}"]`)
        : root.querySelector(`[data-focus-key="${focusKey}"]`);
      if (f) f.focus({ preventScroll: true });
    }
  }

  // ---------- public ----------

  function init(rootEl, o) {
    root = rootEl;
    opts = o;
  }

  async function open() {
    const r = await opts.api.listTasks();
    tasks = r.tasks || [];
    defaultRoot = r.root || '';
    if (!form.root) form.root = defaultRoot;
    message = { text: r.error || '', kind: r.error ? 'err' : '' };
    // A plan being reviewed (or written) is kept while Aska runs; otherwise the list.
    if (!review && !planning) page = tasks.length ? 'list' : 'new';
    render();
    const f = root.querySelector(page === 'new' ? '.tk-goal, .tk-plan-item input' : '.tk-item, .set-body button');
    if (f) f.focus();
  }

  /** A task changed (aska:task): the board follows it live. */
  function onTask(x) {
    if (!x || !x.id) return;
    upsert(x);
    if (!root || root.hidden || page !== 'list') return;
    render();
  }

  /** Esc: back from a task's board to the list, otherwise closes the view. */
  function requestClose() {
    if (armed) {
      armed = null;
      render();
      setMessage('');
      return false;
    }
    if (page === 'list' && current) {
      current = null;
      render();
      setMessage('');
      return false;
    }
    opts.onClose();
    return true;
  }

  window.AskaTasks = { init, open, onTask, requestClose };
})();
