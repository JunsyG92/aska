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
  let capture = null; // { kind: 'global' } | { kind: 'key', action }
  let armedClose = false;
  let message = { text: '', kind: '' };

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
        draft.shortcut = combo;
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
    return patch;
  }
  const isDirty = () => !!data && Object.keys(changed()).length > 0;

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

  function globalShortcutRow() {
    const box = el('div', 'set-keys');
    const recording = capture && capture.kind === 'global';
    const btn = el('button', 'set-kbd' + (recording ? ' recording' : ''), recording ? t('settings.record') : label(draft.shortcut));
    btn.type = 'button';
    btn.title = t('settings.change');
    btn.addEventListener('click', () => {
      capture = { kind: 'global' };
      render();
    });
    box.append(btn);
    if (recording) box.append(cancelRecordButton());
    if (draft.shortcut && !recording) {
      const clear = el('button', 'set-icon', '×');
      clear.type = 'button';
      clear.title = t('settings.clear');
      clear.setAttribute('aria-label', t('settings.clear'));
      clear.addEventListener('click', () => {
        draft.shortcut = false;
        armedClose = false;
        render();
      });
      box.append(clear);
    }
    const g = data.gnome || {};
    return field(t('settings.shortcut'), box, {
      hint: g.active ? t('settings.gnomeHint') : g.error ? t('settings.gnomeError', { error: g.error }) : t('settings.shortcutHint'),
      error: errors.shortcut,
    });
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
    const body = el('div', 'set-body');
    body.append(
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
      section(t('settings.sections.globalShortcut'), globalShortcutRow()),
      section(
        t('settings.sections.notifications'),
        field(t('settings.notify'), select(['hidden', 'unfocused', 'never'].map((v) => ({ value: v, label: t(`settings.notifyOptions.${v}`) })), draft.notify, (v) => { draft.notify = v; }), { error: errors.notify }),
        field(t('settings.notifyPreview'), toggle(draft.notifyPreview, (v) => { draft.notifyPreview = v; })),
        field(t('settings.notifySound'), toggle(draft.notifySound, (v) => { draft.notifySound = v; }))
      ),
      section(t('settings.sections.history'), field(t('settings.savePrompts'), toggle(draft.savePrompts, (v) => { draft.savePrompts = v; }))),
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
      el('p', 'set-note', t('settings.fileOnly'))
    );

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
    bar.append(resetAll, msg, cancel, save);

    root.replaceChildren(body, bar);
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
    if (!Object.keys(patch).length) {
      close(true);
      return;
    }
    const res = await opts.api.saveSettings(patch);
    if (!res || res.errors) {
      errors = (res && res.errors) || {};
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
    data = await opts.api.getSettings();
    draft = clone(data.values);
    errors = {};
    capture = null;
    armedClose = false;
    message = { text: '', kind: '' };
    render();
    const first = root.querySelector('select, input, button');
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
