'use strict';
// "/" commands typed in the field: handled by the window itself, never sent to
// an agent. Pure logic (parsing and suggestions), shared with the unit tests;
// app.js runs them.
//
// A message is a command only if it starts with "/name" followed by a space or
// the end: "/etc/hosts, what is it?" stays a message. "//text" sends "/text" as is.

(function (root) {
  // arg: kind of argument; required: the command does nothing without it.
  const COMMANDS = [
    { name: 'help' },
    { name: 'new', aliases: ['clear'] },
    { name: 'close' },
    { name: 'agent', arg: 'agent', required: true },
    { name: 'mode', arg: 'mode', required: true },
    { name: 'model', arg: 'model' },
    { name: 'cd', arg: 'path' },
    { name: 'add', arg: 'source' },
    { name: 'sources' },
    { name: 'listen' },
    { name: 'retry' },
    { name: 'copy' },
    { name: 'history' },
    { name: 'settings' },
    { name: 'pin' },
    { name: 'mini' },
  ];
  const DEFAULT_MODEL = 'default'; // "/model default": back to the CLI's default model
  const MAX_ITEMS = 40; // the list scrolls

  const LINE_RE = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/;
  const byName = (name) => COMMANDS.find((c) => c.name === name || (c.aliases || []).includes(name)) || null;

  /**
   * What to do with the text of the field.
   * ctx: { agents: [{ id, label }] (available agents, for "/codex …"),
   *        custom: [{ name, prompt, description?, agent?, mode?, model? }] (commands of the config) }.
   * Aska's commands come first, then the user's, then the agents.
   * Returns { kind: 'send', text } | { kind: 'command', name, arg } | { kind: 'custom', command, arg }
   *       | { kind: 'agent', agentId, rest } | { kind: 'unknown', name }.
   */
  function parse(text, ctx = {}) {
    const s = String(text).trim();
    if (s.startsWith('//')) return { kind: 'send', text: s.slice(1) };
    const m = LINE_RE.exec(s);
    if (!m) return { kind: 'send', text: s };
    const name = m[1].toLowerCase();
    const arg = (m[2] || '').trim();
    const cmd = byName(name);
    if (cmd) return { kind: 'command', name: cmd.name, arg };
    const own = (ctx.custom || []).find((c) => c.name === name);
    if (own) return { kind: 'custom', command: own, arg };
    const a = (ctx.agents || []).find((x) => x.id === name);
    if (a) return { kind: 'agent', agentId: a.id, rest: arg };
    return { kind: 'unknown', name };
  }

  const starts = (value, needle) => value.toLowerCase().startsWith(needle.toLowerCase());

  /**
   * Suggestions while typing a command, for the palette above the field.
   * ctx: { agents: [{ id, label }], modes: [{ id, label }], models: [string] }.
   * Each item: { line, name, desc, descParams, arg, done }. line: what the field
   * becomes; done: running it needs nothing more (otherwise it waits for an argument).
   * Returns null when the text is not a command being typed.
   */
  function suggest(text, ctx = {}) {
    const s = String(text);
    if (!s.startsWith('/') || s.startsWith('//') || s.includes('\n')) return null;
    const m = /^\/([A-Za-z][\w-]*)?(\s+)?(.*)$/s.exec(s);
    if (!m) return null;
    const typed = m[1] || '';
    const agents = ctx.agents || [];

    // Still typing the name: commands, then agents, by prefix.
    if (!m[2]) {
      const items = [];
      for (const c of COMMANDS) {
        for (const name of [c.name, ...(c.aliases || [])]) {
          if (!starts(name, typed)) continue;
          items.push({ line: '/' + name + (c.required ? ' ' : ''), name, desc: c.name, arg: c.arg, done: !c.required });
        }
      }
      for (const c of ctx.custom || []) {
        if (!starts(c.name, typed)) continue;
        const text = c.description || c.prompt.trim().split('\n')[0].slice(0, 80);
        items.push({ line: '/' + c.name, name: c.name, text, arg: 'text', done: true, custom: true });
      }
      for (const a of agents) {
        if (starts(a.id, typed)) items.push({ line: '/' + a.id, name: a.id, desc: 'switchTo', descParams: { agent: a.label }, arg: 'message', done: true });
      }
      return items.slice(0, MAX_ITEMS);
    }

    // Typing the argument: the known values, by prefix.
    const cmd = byName(typed.toLowerCase());
    if (!cmd) return [];
    const needle = m[3];
    if (/\s/.test(needle.trim())) return []; // one argument at most
    const values =
      cmd.arg === 'agent' ? agents.map((a) => ({ value: a.id, label: a.label }))
      : cmd.arg === 'mode' ? (ctx.modes || []).map((x) => ({ value: x.id, label: x.label }))
      : cmd.arg === 'model' ? [{ value: DEFAULT_MODEL, label: null }, ...(ctx.models || []).map((x) => ({ value: x, label: null }))]
      : [];
    return values
      .filter((v) => starts(v.value, needle.trim()))
      .slice(0, MAX_ITEMS)
      .map((v) => ({ line: `/${cmd.name} ${v.value}`, name: v.value, label: v.label, done: true }));
  }

  /**
   * Prompt of a command of the config: "{input}" is replaced by what follows the
   * name; without "{input}", that text is added after a blank line.
   */
  function expand(prompt, input) {
    const s = String(input || '').trim();
    if (prompt.includes('{input}')) return prompt.split('{input}').join(s).trim();
    return s ? prompt.trimEnd() + '\n\n' + s : prompt.trim();
  }

  const api = { COMMANDS, DEFAULT_MODEL, parse, suggest, expand };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AskaCommands = api;
})(typeof window === 'object' ? window : globalThis);
