'use strict';
// Lance un CLI d'agent sans shell, diffuse sa sortie, et garantit son arrêt
// (annulation, délai dépassé, sortie trop volumineuse).

const { spawn, execFile } = require('child_process');

const WIN = process.platform === 'win32';
const { StringDecoder } = require('string_decoder');

// Séquences ANSI/OSC et caractères de contrôle (hors \n et \t).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
const clean = (s) => s.replace(/\r\n?/g, '\n').replace(ANSI, '');

function short(v, n = 90) {
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const detail = i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.description;
  return detail ? `${name} · ${short(detail)}` : String(name);
}

/**
 * Interprète le format « stream-json » (une ligne JSON par événement) de
 * Claude Code et du CLI Cursor. Tolérant : tout événement inconnu est ignoré.
 */
function createStreamJsonParser(emit) {
  let buf = '';
  let sawDelta = false;
  let shown = false;
  let pendingSep = false;

  const text = (t) => {
    if (!t) return;
    if (pendingSep && shown) emit({ type: 'text', text: '\n\n' });
    pendingSep = false;
    shown = true;
    emit({ type: 'text', text: t });
  };

  function handle(o) {
    if (!o || typeof o !== 'object') return;
    if (o.parent_tool_use_id) return; // sortie interne d'un sous-agent
    switch (o.type) {
      case 'system':
        if (o.subtype === 'init' && o.model) emit({ type: 'meta', model: String(o.model) });
        if (typeof o.session_id === 'string') emit({ type: 'session', id: o.session_id });
        break;
      case 'stream_event': {
        const e = o.event || {};
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') pendingSep = shown;
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          sawDelta = true;
          text(e.delta.text);
        }
        break;
      }
      case 'assistant': {
        const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
        for (const b of blocks) {
          if (b.type === 'text' && !sawDelta) {
            pendingSep = shown;
            text(b.text);
          } else if (b.type === 'tool_use') {
            emit({ type: 'activity', text: describeTool(b.name, b.input) });
          }
        }
        break;
      }
      case 'tool_call': {
        if (o.subtype && o.subtype !== 'started') break;
        const tc = o.tool_call && typeof o.tool_call === 'object' ? o.tool_call : {};
        const key = Object.keys(tc)[0];
        if (key) emit({ type: 'activity', text: describeTool(key.replace(/ToolCall$/, ''), tc[key]?.args) });
        break;
      }
      case 'result': {
        if (typeof o.session_id === 'string') emit({ type: 'session', id: o.session_id });
        const denials = Array.isArray(o.permission_denials) ? o.permission_denials : [];
        if (denials.length) {
          emit({ type: 'denied', count: denials.length, tools: [...new Set(denials.map((d) => String(d.tool_name || '?')))].slice(0, 5) });
        }
        if (o.is_error || (o.subtype && o.subtype !== 'success')) {
          emit({ type: 'error', text: short(o.result || o.subtype || 'erreur', 400) });
        } else if (!shown && typeof o.result === 'string') {
          text(o.result);
        }
        break;
      }
      default:
    }
  }

  function line(l) {
    const s = l.trim();
    if (!s) return;
    if (s[0] === '{') {
      try {
        handle(JSON.parse(s));
        return;
      } catch { /* pas du JSON : affiché tel quel */ }
    }
    text(clean(l) + '\n');
  }

  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      if (buf) line(buf);
      buf = '';
    },
  };
}

function createTextParser(emit) {
  return {
    push(chunk) {
      const t = clean(chunk);
      if (t) emit({ type: 'text', text: t });
    },
    end() {},
  };
}

/**
 * @returns {{ cancel: () => void, done: Promise<object> }}
 */
function runAgent({ bin, argv, cwd, env, stdin, output = 'text', timeoutMs = 600000, maxBytes = 2 * 1024 * 1024, verbatim = false }, onEvent) {
  const started = Date.now();
  let reason = null;
  let bytes = 0;
  let stderrTail = '';
  let killTimer = null;
  let settled = false;

  const emit = (ev) => {
    if (!settled) onEvent(ev);
  };

  let child;
  try {
    child = spawn(bin, argv, {
      cwd,
      env,
      shell: false,
      // Linux : groupe de processus dédié, pour tuer toute la descendance.
      // Windows : « detached » ouvrirait une console ; l'arbre est tué par taskkill.
      detached: !WIN,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    return {
      cancel() {},
      done: Promise.resolve({ ok: false, reason: 'spawn-error', error: e.message, durationMs: 0 }),
    };
  }

  let treeKilled = false;
  const killGroup = (sig) => {
    if (WIN) {
      // Windows n'a pas de signaux : on termine l'arbre de processus d'un coup.
      if (treeKilled || !child.pid) return;
      treeKilled = true;
      const sys = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
      execFile(`${sys}\\System32\\taskkill.exe`, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
        try { child.kill(); } catch { /* déjà terminé */ }
      });
      return;
    }
    try {
      process.kill(-child.pid, sig);
    } catch {
      try { child.kill(sig); } catch { /* déjà terminé */ }
    }
  };
  const stop = (why) => {
    if (reason) return;
    reason = why;
    killGroup('SIGTERM');
    killTimer = setTimeout(() => killGroup('SIGKILL'), 2500);
  };

  const timeout = setTimeout(() => stop('timeout'), timeoutMs);
  const parser = output === 'stream-json' ? createStreamJsonParser(emit) : createTextParser(emit);
  const outDec = new StringDecoder('utf8');
  const errDec = new StringDecoder('utf8');

  child.stdout.on('data', (d) => {
    bytes += d.length;
    if (bytes > maxBytes) return stop('overflow');
    if (!reason) parser.push(outDec.write(d));
  });
  child.stderr.on('data', (d) => {
    bytes += d.length;
    if (bytes > maxBytes) return stop('overflow');
    const t = clean(errDec.write(d));
    stderrTail = (stderrTail + t).slice(-4000);
    if (t.trim() && !reason) emit({ type: 'stderr', text: t });
  });

  child.stdin.on('error', () => {}); // EPIPE si le CLI ne lit pas stdin
  child.stdin.end(stdin ?? '');

  const done = new Promise((resolve) => {
    const finish = (res) => {
      if (settled) return;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (!reason) parser.end();
      settled = true;
      resolve({ durationMs: Date.now() - started, stderrTail: stderrTail.trim(), ...res });
    };
    child.on('error', (e) => finish({ ok: false, reason: 'spawn-error', error: e.message }));
    child.on('close', (code, signal) => {
      if (reason) killGroup('SIGKILL'); // ne laisse aucun descendant derrière
      finish({ ok: !reason && code === 0, reason: reason || 'exit', code, signal });
    });
  });

  return { cancel: () => stop('cancel'), done };
}

module.exports = { runAgent, createStreamJsonParser, createTextParser, clean, describeTool };
