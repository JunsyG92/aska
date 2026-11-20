'use strict';
// "Ask about the selection": the text selected in another application, quoted
// in the field, ready for a question. Nothing is sent: the user reads it and
// types the question first. Independent of Electron (the clipboard is passed in).

const MAX_CHARS = 20000;

// Control characters other than \n and \t, and ANSI sequences from a terminal.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** Text as it goes in the field: lines kept, control characters dropped, capped. */
function cleanSelection(text) {
  let s = String(text || '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
  s = s.replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
  const truncated = s.length > MAX_CHARS;
  if (truncated) s = s.slice(0, MAX_CHARS);
  return { text: s, truncated };
}

/**
 * Selected text: on Linux the primary selection (what is highlighted, without
 * copying: Electron's `clipboard.selection`), else the clipboard. Electron's
 * clipboard is asynchronous (readText() returns a promise).
 * Resolves to { text, source, truncated }, source being 'selection',
 * 'clipboard' or null when both are empty.
 */
async function readSelection(clipboard, platform = process.platform) {
  const read = async (board) => {
    try {
      return cleanSelection(await board.readText());
    } catch {
      return { text: '', truncated: false };
    }
  };
  if (platform === 'linux' && clipboard.selection) {
    const primary = await read(clipboard.selection);
    if (primary.text.trim()) return { ...primary, source: 'selection' };
  }
  const copied = await read(clipboard);
  if (copied.text.trim()) return { ...copied, source: 'clipboard' };
  return { text: '', truncated: false, source: null };
}

/** Quote block for the field: "> " in front of each line. */
function quoteSelection(text) {
  return String(text)
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

module.exports = { readSelection, cleanSelection, quoteSelection, MAX_CHARS };
