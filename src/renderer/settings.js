'use strict';
// Settings view: a form over the values sent by the main process, which
// checks everything again before writing config.json (see src/main/settings.js).
// Built without innerHTML. Nothing is written before "Save".

(function () {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const LANGUAGE_NAMES = { en: 'English', fr: 'Français' };
  const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super'];
  const NAMED = ['Tab', 'PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Enter', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

  let root = null;
  let opts = {};
  let data = null; // { values, defaults, actions, languages, agents, gnome, keyNames, configError }
  let draft = null;
  let errors = {};
  let capture = null; // { kind: 'global', key: 'shortcut' | 'selectionShortcut' } | { kind: 'key', action }
  let armedClose = false;
  let message = { text: '', kind: '' };
  let page = 'general'; // 'general' | 'keys' | 'bots'
  const PAGE_OF_ERROR = (k) => (k === 'shortcut' || k === 'selectionShortcut' || k.startsWith('keybindings') ? 'keys' : 'general');
  // Bots tab: its own list and drafts, saved by the same "Save" (see saveBot in the main process).
  let botData = null; // { bots: [...], folder }
  let botDrafts = {}; // id -> fields being edited
  let botErrors = {}; // id -> { field: message }
  let botSel = null;
  const RANK = ['read', 'edit', 'auto'];
  const SOUL_WARN = 4000;
  const SOUL_MAX = 8000;

  const t = (k, p) => opts.t(k, p);

  // ---------- combos ----------

  // In-window shortcut, from a key event, as written in the config: "Ctrl+Shift+J".
  function keyCombo(e) {
    const key = e.key.length === 1 ? e.key.toUpperCase() : NAMED.includes(e.key) || /^F\d{1,2}$/.test(e.key) ? e.key : null;
    if (!key) return null;
    return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', key].filter(Boolean).join('+');
  }
  // Global shortcut, as an Electron accelerator. A letter comes from the layout
  // (AZERTY: the A key gives A), like GNOME does; digits, F keys and Space from the key itself.
  function globalCombo(e) {
    const c = e.code;
    const key = /^[a-z]$/i.test(e.key) ? e.key.toUpperCase()
      : /^Digit\d$/.test(c) ? c.slice(5)
      : /^F\d{1,2}$/.test(c) ? c
      : c === 'Space' ? 'Space'
      : null;
    if (!key) return null;
    return [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key].filter(Boolean).join('+');
  }
  // Readable label in the current language ("Ctrl+Maj+J").
  function label(text) {
    if (!text) return t('settings.none');
    const names = data.keyNames || {};
    return text
      .split('+')
      .map((p) => (p === 'Control' ? names.Ctrl || 'Ctrl' : names[p] || p))
      .join('+');
  }

  function onCaptureKey(e) {
    if (!capture) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (MODIFIER_KEYS.includes(e.key)) return; // wait for the actual key
    if (capture.kind === 'global') {
      // Esc alone cancels; a global shortcut is never a plain Esc.
      if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey) {
        const combo = globalCombo(e);
        if (!combo) return; // key not usable for a global shortcut: wait for another
        draft[capture.key] = combo;
      }
    } else {
      // In the window, Esc can be a shortcut too: the "Cancel" button stops the capture.
      const combo = keyCombo(e);
      const list = draft.keybindings[capture.action];
      if (combo && !list.includes(combo)) list.push(combo);
    }
    capture = null;
    armedClose = false;
    render();
  }

  // ---------- form ----------

  function changed() {
    const patch = {};
    for (const [k, v] of Object.entries(draft)) {
      if (JSON.stringify(v) !== JSON.stringify(data.values[k])) patch[k] = v;
    }
    // The shortcuts are checked together (conflicts): all of them, or none.
    if (patch.keybindings) patch.keybindings = draft.keybindings;
    if ('shortcut' in patch || 'selectionShortcut' in patch) {
      patch.shortcut = draft.shortcut;
      patch.selectionShortcut = draft.selectionShortcut;
    }
    return patch;
  }
  // ---------- bots ----------

  // What the form edits, from a bot of the list.
  const botFields = (b) => ({
    label: b.label,
    description: b.description,
    color: b.color,
    model: b.model,
    mode: b.mode,
    soul: b.soul,
    avatar: { variant: b.avatar.variant || 0, shape: b.avatar.shape || 'auto', emblem: b.avatar.emblem || 'auto' },
  });
  const botList = () => (botData ? botData.bots : []);
  const draftOf = (b) => (botDrafts[b.id] = botDrafts[b.id] || botFields(b));
  function botChanged(b) {
    if (!botDrafts[b.id]) return {};
    const orig = botFields(b);
    const patch = {};
    for (const [k, v] of Object.entries(botDrafts[b.id])) if (JSON.stringify(v) !== JSON.stringify(orig[k])) patch[k] = v;
    return patch;
  }
  const botPatches = () => botList().map((b) => [b.id, botChanged(b)]).filter(([, p]) => Object.keys(p).length);
  const avatarUrl = (b, d) => b.image || window.AskaAvatar.avatarDataUrl(d.label || b.id, d.avatar);

  async function refreshBots() {
    botData = await opts.api.listBots();
    if (!botList().some((b) => b.id === botSel)) botSel = botList()[0] ? botList()[0].id : null;
    render();
  }

  // Picture added by hand: written at once (not by "Save"), like the folder of a tab.
  async function botPicture(id, remove) {
    const s = remove ? await opts.api.clearBotAvatar(id) : await opts.api.pickBotAvatar(id);
    if (s.error) setMessage(s.error, 'err');
    opts.onSaved(s);
    await refreshBots();
  }

  function textInput(value, onInput, { focusKey, max, placeholder, list } = {}) {
    const i = el('input', 'set-input');
    i.type = 'text';
    i.value = value;
    if (max) i.maxLength = max;
    if (placeholder) i.placeholder = placeholder;
    if (list) i.setAttribute('list', list);
    i.dataset.focusKey = focusKey;
    i.addEventListener('input', () => {
      onInput(i.value);
      armedClose = false;
    });
    return i;
  }

  // A control without a label of its own: named for the tooltip and screen readers.
  const named = (name, control) => {
    control.title = name;
    control.setAttribute('aria-label', name);
    return control;
  };
  const wide = (row) => {
    row.classList.add('wide');
    return row;
  };

  function botsPage() {
    const list = botList();
    if (!list.length) return [el('p', 'set-note', t('settings.bots.empty', { folder: botData ? botData.folder : '' }))];
    const b = list.find((x) => x.id === botSel) || list[0];
    botSel = b.id;
    const d = draftOf(b);
    const errs = botErrors[b.id] || {};

    // The bots, as a row of chips: avatar, name, @id.
    const nav = el('div', 'set-bots');
    for (const x of list) {
      const dx = botDrafts[x.id] || botFields(x);
      const chip = el('button', 'set-bot' + (x.id === b.id ? ' active' : '') + (Object.keys(botChanged(x)).length ? ' dirty' : '') + (botErrors[x.id] ? ' has-error' : ''));
      chip.type = 'button';
      chip.dataset.bot = x.id;
      chip.setAttribute('aria-pressed', String(x.id === b.id));
      const img = el('img', 'set-bot-av');
      img.alt = '';
      img.src = avatarUrl(x, dx);
      chip.append(img, el('span', 'set-bot-name', dx.label || x.id), el('span', 'set-bot-id', '@' + x.id));
      chip.addEventListener('click', () => {
        botSel = x.id;
        render();
      });
      nav.append(chip);
    }

    // Avatar: preview, another variant, shape, emblem, a picture of your own.
    const preview = el('img', 'set-bot-preview');
    preview.alt = '';
    preview.src = avatarUrl(b, d);
    const redraw = () => {
      preview.src = avatarUrl(b, d);
      armedClose = false;
    };
    const avatarBox = el('div', 'set-bot-avatar');
    const tools = el('div', 'set-inline wrap');
    const button = (text, onClick, cls = 'set-btn small') => {
      const btn = el('button', cls, text);
      btn.type = 'button';
      btn.addEventListener('click', onClick);
      return btn;
    };
    if (!b.image) {
      tools.append(
        button(t('settings.bots.variant'), () => {
          d.avatar = { ...d.avatar, variant: (d.avatar.variant + 1) % 10000 };
          armedClose = false;
          render();
        }),
        named(t('settings.bots.shape'), select([{ value: 'auto', label: t('settings.bots.shapeAuto') }, ...window.AskaAvatar.SHAPES.map((s) => ({ value: s, label: t(`settings.bots.shapes.${s}`) }))], d.avatar.shape, (v) => {
          d.avatar = { ...d.avatar, shape: v };
          render();
        })),
        named(t('settings.bots.emblem'), select(
          [{ value: 'auto', label: t('settings.bots.emblemAuto') }, { value: 'none', label: t('settings.bots.none') }, ...window.AskaAvatar.EMBLEMS.map((e) => ({ value: e, label: t(`settings.bots.emblems.${e}`) }))],
          d.avatar.emblem,
          (v) => {
            d.avatar = { ...d.avatar, emblem: v };
            render();
          }
        ))
      );
    }
    tools.append(button(t('settings.bots.importImage'), () => botPicture(b.id, false)));
    if (b.image) tools.append(button(t('settings.bots.removeImage'), () => botPicture(b.id, true)));
    avatarBox.append(preview, tools);

    const name = textInput(d.label, (v) => {
      d.label = v;
      redraw();
    }, { focusKey: 'bot-label', max: 24 });
    const description = textInput(d.description, (v) => { d.description = v; }, { focusKey: 'bot-description', max: 120 });

    // Color: the avatar's, or one picked.
    const colorBox = el('div', 'set-inline');
    const auto = d.color === '';
    const picker = el('input', 'set-color');
    picker.type = 'color';
    picker.value = auto ? window.AskaAvatar.avatarColor(d.label || b.id, d.avatar.variant) : d.color;
    picker.disabled = auto;
    picker.addEventListener('input', () => {
      d.color = picker.value;
      armedClose = false;
    });
    const autoSwitch = toggle(auto, (v) => {
      d.color = v ? '' : picker.value;
      render();
    });
    colorBox.append(picker, autoSwitch, el('span', 'set-unit', t('settings.bots.colorAuto')));

    // Model: the agent's by default, or a name (suggested from the agent's list).
    const listId = 'set-bot-models';
    const models = el('datalist');
    models.id = listId;
    for (const m of b.models) {
      const o = el('option');
      o.value = m;
      models.append(o);
    }
    const model = textInput(d.model, (v) => { d.model = v.trim(); }, { focusKey: 'bot-model', placeholder: t('settings.bots.modelDefault', { agent: b.agentLabel }), list: listId });
    const modelBox = el('div', 'set-inline');
    modelBox.append(model, models);

    // Mode: up to the bot's maxMode, among the agent's modes; never auto at startup.
    const modeSelect = select(
      ['read', 'edit'].map((m) => ({ value: m, label: opts.modeLabel(m), disabled: !b.modes.includes(m) || RANK.indexOf(m) > RANK.indexOf(b.maxMode) })),
      d.mode,
      (v) => { d.mode = v; }
    );

    // Personality, with its length: a warning from 4,000 characters, refused beyond 8,000.
    const soul = el('textarea', 'set-textarea');
    soul.rows = 8;
    soul.spellcheck = false;
    soul.value = d.soul;
    soul.dataset.focusKey = 'bot-soul';
    const count = el('div', 'set-count');
    const syncCount = () => {
      const n = soul.value.trim().length;
      count.textContent = t('settings.bots.soulCount', { count: n.toLocaleString(), max: SOUL_MAX.toLocaleString() }) + (n > SOUL_WARN && n <= SOUL_MAX ? ' · ' + t('settings.bots.soulLong') : '');
      count.dataset.kind = n > SOUL_MAX ? 'err' : n > SOUL_WARN ? 'warn' : '';
    };
    soul.addEventListener('input', () => {
      d.soul = soul.value;
      armedClose = false;
      syncCount();
    });
    syncCount();
    const soulBox = el('div', 'set-stack');
    soulBox.append(soul, count);

    // What stays in the files: the agent, the ceiling, the folder.
    const filesBox = el('div', 'set-inline wrap');
    filesBox.append(
      el('span', 'set-unit', t('settings.bots.files', { agent: b.agentLabel, max: opts.modeLabel(b.maxMode), cwd: b.cwd || t('settings.bots.tabFolder') })),
      button(t('settings.bots.openFolder'), () => opts.api.openBotFolder(b.id))
    );

    return [
      nav,
      section(
        d.label || b.id,
        wide(field(t('settings.bots.avatar'), avatarBox, { error: errs.avatar })),
        field(t('settings.bots.name'), name, { error: errs.label }),
        field(t('settings.bots.description'), description, { error: errs.description }),
        field(t('settings.bots.color'), colorBox, { error: errs.color }),
        field(t('settings.bots.model'), modelBox, { error: errs.model }),
        field(t('settings.bots.mode'), modeSelect, { hint: t('settings.bots.modeHint', { max: opts.modeLabel(b.maxMode) }), error: errs.mode }),
        wide(field(t('settings.bots.soul'), soulBox, { hint: t('settings.bots.soulHint'), error: errs.soul })),
        field(t('settings.bots.filesHint'), filesBox)
      ),
    ];
  }

  const isDirty = () => !!data && (Object.keys(changed()).length > 0 || botPatches().length > 0);

  function setMessage(text, kind = '') {
    message = { text, kind };
    const m = root && root.querySelector('.set-message');
    if (m) {
      m.textContent = text;
      m.dataset.kind = kind;
    }
  }

  function field(labelText, control, { hint, error } = {}) {
    const row = el('div', 'set-row');
    const lab = el('label', 'set-label', labelText);
    const id = 'set-' + Math.random().toString(36).slice(2, 8);
    if (control.matches && control.matches('input, select')) {
      control.id = id;
      lab.htmlFor = id;
    }
    row.append(lab, control);
    if (hint) row.append(el('div', 'set-hint', hint));
    if (error) row.append(el('div', 'set-error', error));
    return row;
  }

  function select(options, value, onChange) {
    const s = el('select', 'set-select');
    for (const o of options) {
      const opt = el('option', null, o.label);
      opt.value = o.value;
      if (o.disabled) opt.disabled = true;
      s.append(opt);
    }
    s.value = value;
    s.addEventListener('change', () => {
      onChange(s.value);
      armedClose = false;
    });
    return s;
  }

  function toggle(value, onChange) {
    const c = el('input', 'set-switch');
    c.type = 'checkbox';
    c.checked = !!value;
    c.addEventListener('change', () => {
      onChange(c.checked);
      armedClose = false;
    });
    return c;
  }

  function section(title, ...rows) {
    const s = el('section', 'set-section');
    s.append(el('h3', 'set-title', title), ...rows);
    return s;
  }

  function cancelRecordButton() {
    const b = el('button', 'set-btn small', t('settings.cancelRecord'));
    b.type = 'button';
    b.addEventListener('click', () => {
      capture = null;
      render();
    });
    return b;
  }

  // A global shortcut: "shortcut" (show / hide) or "selectionShortcut" (ask about the selection).
  function globalShortcutRow(key) {
    const box = el('div', 'set-keys');
    box.dataset.key = key;
    const recording = capture && capture.kind === 'global' && capture.key === key;
    const btn = el('button', 'set-kbd' + (recording ? ' recording' : ''), recording ? t('settings.record') : label(draft[key]));
    btn.type = 'button';
    btn.title = t('settings.change');
    btn.addEventListener('click', () => {
      capture = { kind: 'global', key };
      render();
    });
    box.append(btn);
    if (recording) box.append(cancelRecordButton());
    if (draft[key] && !recording) {
      const clear = el('button', 'set-icon', '×');
      clear.type = 'button';
      clear.title = t('settings.clear');
      clear.setAttribute('aria-label', t('settings.clear'));
      clear.addEventListener('click', () => {
        draft[key] = false;
        armedClose = false;
        render();
      });
      box.append(clear);
    }
    const g = data.gnome || {};
    const sel = key === 'selectionShortcut';
    const hint = g.active
      ? t(sel ? 'settings.selectionGnomeHint' : 'settings.gnomeHint')
      : g.error
        ? t('settings.gnomeError', { error: g.error })
        : t(sel ? 'settings.selectionHint' : 'settings.shortcutHint');
    return field(t(sel ? 'settings.selectionShortcut' : 'settings.shortcut'), box, { hint, error: errors[key] });
  }

  function keyRow(action) {
    const list = draft.keybindings[action];
    const box = el('div', 'set-keys');
    for (const combo of list) {
      const chip = el('span', 'set-chip');
      const x = el('button', 'set-chip-x', '×');
      x.type = 'button';
      x.title = t('settings.removeKey', { key: label(combo) });
      x.setAttribute('aria-label', x.title);
      x.addEventListener('click', () => {
        draft.keybindings[action] = list.filter((c) => c !== combo);
        armedClose = false;
        render();
      });
      chip.append(el('kbd', null, label(combo)), x);
      box.append(chip);
    }
    if (!list.length) box.append(el('span', 'set-none', t('settings.none')));
    const recording = capture && capture.kind === 'key' && capture.action === action;
    if (recording) box.append(el('span', 'set-kbd recording', t('settings.record')), cancelRecordButton());
    else {
      const add = el('button', 'set-icon', '+');
      add.type = 'button';
      add.title = t('settings.addKey');
      add.setAttribute('aria-label', add.title);
      add.addEventListener('click', () => {
        capture = { kind: 'key', action };
        render();
      });
      box.append(add);
    }
    if (JSON.stringify(list) !== JSON.stringify(data.defaults.keybindings[action])) {
      const reset = el('button', 'set-icon', '↺');
      reset.type = 'button';
      reset.title = t('settings.resetKey');
      reset.setAttribute('aria-label', reset.title);
      reset.addEventListener('click', () => {
        draft.keybindings[action] = [...data.defaults.keybindings[action]];
        armedClose = false;
        render();
      });
      box.append(reset);
    }
    const row = field(t(`settings.actions.${action}`), box, { error: errors[`keybindings.${action}`] });
    row.dataset.action = action;
    return row;
  }

  function render() {
    if (!root || !data) return;
    const focusKey = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    const agentOptions = data.agents
      .filter((a) => a.available || a.id === draft.defaultAgent)
      .map((a) => ({ value: a.id, label: a.label }));
    const general = [
      section(
        t('settings.sections.general'),
        field(t('settings.language'), select(data.languages.map((l) => ({ value: l, label: l === 'auto' ? t('settings.languageAuto') : LANGUAGE_NAMES[l] || l })), draft.language, (v) => { draft.language = v; }), { error: errors.language }),
        field(t('settings.defaultAgent'), select(agentOptions, draft.defaultAgent, (v) => { draft.defaultAgent = v; }), { error: errors.defaultAgent }),
        field(t('settings.defaultMode'), select(['read', 'edit'].map((m) => ({ value: m, label: opts.modeLabel(m) })), draft.defaultMode, (v) => { draft.defaultMode = v; }), { hint: t('settings.defaultsHint'), error: errors.defaultMode }),
        (() => {
          const box = el('div', 'set-inline');
          const n = el('input', 'set-number');
          n.type = 'number';
          n.min = '5';
          n.max = '3600';
          n.step = '1';
          n.value = String(draft.timeoutSec);
          n.dataset.focusKey = 'timeout';
          n.addEventListener('input', () => {
            draft.timeoutSec = n.value === '' ? NaN : Number(n.value);
            armedClose = false;
          });
          box.append(n, el('span', 'set-unit', t('settings.seconds')));
          return field(t('settings.timeout'), box, { error: errors.timeoutSec });
        })()
      ),
      section(
        t('settings.sections.window'),
        field(t('settings.alwaysOnTop'), toggle(draft.alwaysOnTop, (v) => { draft.alwaysOnTop = v; }), { error: errors.alwaysOnTop }),
        field(t('settings.tray'), toggle(draft.tray, (v) => { draft.tray = v; }), { error: errors.tray })
      ),
      section(
        t('settings.sections.notifications'),
        field(t('settings.notify'), select(['hidden', 'unfocused', 'never'].map((v) => ({ value: v, label: t(`settings.notifyOptions.${v}`) })), draft.notify, (v) => { draft.notify = v; }), { error: errors.notify }),
        field(t('settings.notifyPreview'), toggle(draft.notifyPreview, (v) => { draft.notifyPreview = v; })),
        field(t('settings.notifySound'), toggle(draft.notifySound, (v) => { draft.notifySound = v; }))
      ),
      section(t('settings.sections.history'), field(t('settings.savePrompts'), toggle(draft.savePrompts, (v) => { draft.savePrompts = v; }))),
      el('p', 'set-note', t('settings.fileOnly')),
    ];
    const shortcuts = [
      section(t('settings.sections.globalShortcut'), globalShortcutRow('shortcut'), globalShortcutRow('selectionShortcut')),
      section(t('settings.sections.keys'), ...data.actions.map(keyRow)),
      section(
        t('settings.fixed.title'),
        ...(() => {
          const n = (k) => (data.keyNames || {})[k] || k;
          return [
            [n('Enter'), 'send'],
            [`Tab  /  ${n('Shift')}+Tab`, 'agentMode'],
            [n('Escape'), 'cancel'],
            [`${n('ArrowUp')} ${n('ArrowDown')}`, 'recall'],
            ['Ctrl+1…9', 'tabNumbers'],
            [n('Delete'), 'lists'],
          ];
        })().map(([keysText, what]) => {
          const box = el('div', 'set-keys');
          box.append(el('kbd', 'set-fixed', keysText));
          return field(t(`settings.fixed.${what}`), box);
        })
      ),
    ];

    // Two pages, General and Shortcuts, chosen with the tabs at the top.
    const tabs = el('div', 'set-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const p of ['general', 'keys', 'bots']) {
      const b = el('button', 'set-tab', t(`settings.tabs.${p}`));
      b.type = 'button';
      b.dataset.page = p;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(page === p));
      if (p === 'bots' ? Object.keys(botErrors).length : Object.keys(errors).some((k) => k !== '_' && PAGE_OF_ERROR(k) === p)) b.classList.add('has-error');
      b.addEventListener('click', () => {
        if (page === p) return;
        page = p;
        capture = null;
        render();
      });
      tabs.append(b);
    }
    const body = el('div', 'set-body');
    body.setAttribute('role', 'tabpanel');
    body.append(...(page === 'bots' ? botsPage() : page === 'keys' ? shortcuts : general));

    const bar = el('div', 'set-actions');
    const resetAll = el('button', 'set-btn outline', t('settings.resetAll'));
    resetAll.type = 'button';
    resetAll.addEventListener('click', () => {
      draft = clone(data.defaults);
      errors = {};
      armedClose = false;
      render();
      setMessage(t('settings.resetDone'));
    });
    const msg = el('span', 'set-message', message.text);
    msg.dataset.kind = message.kind;
    msg.setAttribute('role', 'status');
    const cancel = el('button', 'set-btn', t('settings.cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => close(true));
    const save = el('button', 'set-btn primary', t('settings.save'));
    save.type = 'button';
    save.disabled = !!data.configError;
    save.addEventListener('click', saveNow);
    // "Reset all" is about the configuration: not on the Bots page.
    resetAll.hidden = page === 'bots';
    bar.append(resetAll, msg, cancel, save);

    root.replaceChildren(tabs, body, bar);
    if (data.configError) setMessage(data.configError, 'err');
    if (focusKey) {
      const f = root.querySelector(`[data-focus-key="${focusKey}"]`);
      if (f) f.focus();
    }
    const rec = root.querySelector('.recording');
    if (rec) rec.scrollIntoView({ block: 'nearest' });
  }

  async function saveNow() {
    if (capture) return;
    const patch = changed();
    const bots = botPatches();
    if (!Object.keys(patch).length && !bots.length) {
      close(true);
      return;
    }
    // The bots first: a refused value shows on their page, nothing else is written.
    let state = null;
    for (const [id, p] of bots) {
      const r = await opts.api.saveBot(id, p);
      if (!r || r.errors) {
        botErrors[id] = (r && r.errors) || {};
        botSel = id;
        page = 'bots';
        render();
        setMessage(botErrors[id]._ || t('settings.hasErrors'), 'err');
        const first = root.querySelector('.set-error');
        if (first) first.scrollIntoView({ block: 'nearest' });
        return;
      }
      botData = { ...botData, bots: r.bots };
      delete botDrafts[id];
      delete botErrors[id];
      state = r.state;
    }
    if (!Object.keys(patch).length) {
      armedClose = false;
      opts.onSaved(state);
      render();
      setMessage(t('settings.bots.saved'), 'ok');
      return;
    }
    const res = await opts.api.saveSettings(patch);
    if (!res || res.errors) {
      errors = (res && res.errors) || {};
      // Show the page holding the first error, if it is not the current one.
      const pages = Object.keys(errors).filter((k) => k !== '_').map(PAGE_OF_ERROR);
      if (pages.length && !pages.includes(page)) page = pages[0];
      render();
      setMessage(errors._ || t('settings.hasErrors'), 'err');
      const first = root.querySelector('.set-error');
      if (first) first.scrollIntoView({ block: 'nearest' });
      return;
    }
    data = res.settings;
    draft = clone(data.values);
    errors = {};
    armedClose = false;
    opts.onSaved(res.state); // new language, shortcuts… applied to the whole window
    render();
    setMessage(t('settings.saved'), 'ok');
  }

  function close(discard) {
    capture = null;
    armedClose = false;
    if (discard && data) draft = clone(data.values);
    errors = {};
    botDrafts = {};
    botErrors = {};
    message = { text: '', kind: '' };
    opts.onClose();
  }

  // ---------- public ----------

  function init(rootEl, o) {
    root = rootEl;
    opts = o;
    window.addEventListener('keydown', onCaptureKey, true);
  }

  async function open() {
    [data, botData] = await Promise.all([opts.api.getSettings(), opts.api.listBots()]);
    draft = clone(data.values);
    errors = {};
    botDrafts = {};
    botErrors = {};
    if (!botList().some((b) => b.id === botSel)) botSel = botList()[0] ? botList()[0].id : null;
    capture = null;
    armedClose = false;
    message = { text: '', kind: '' };
    page = 'general';
    render();
    const first = root.querySelector('.set-body select, .set-body input, .set-body button');
    if (first) first.focus();
  }

  /** Esc: closes, unless there are unsaved changes (first Esc warns, the second discards). */
  function requestClose() {
    if (capture) return false;
    if (isDirty() && !armedClose) {
      armedClose = true;
      setMessage(t('settings.unsaved'), 'warn');
      return false;
    }
    close(true);
    return true;
  }

  window.AskaSettings = { init, open, requestClose, isDirty, isCapturing: () => !!capture };
})();
