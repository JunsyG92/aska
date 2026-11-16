'use strict';
// Rendu Markdown sûr : uniquement createElement/textContent, jamais d'innerHTML.
// La sortie d'un agent ne peut donc injecter ni balise ni script ; le HTML
// éventuel reste du texte, et les images distantes ne sont jamais chargées.
// Pris en charge : titres, paragraphes, listes (imbriquées, numérotées, cases à
// cocher), citations, tableaux, blocs de code, filets, gras, italique, barré,
// code en ligne, liens http(s).

(function () {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // ---------- en ligne ----------

  const INLINE = new RegExp(
    [
      '\\\\([\\\\`*_{}\\[\\]()#+\\-.!~|>])', // 1 : caractère échappé
      '(`+)([\\s\\S]*?[^`])\\2(?!`)', // 2,3 : code
      '!?\\[([^\\]\\n]*)\\]\\(\\s*<?([^\\s)>]+)>?(?:\\s+"[^"\\n]*")?\\s*\\)', // 4,5 : lien ou image
      '<(https?:\\/\\/[^\\s<>]+)>', // 6 : lien entre chevrons
      '(https?:\\/\\/[^\\s<>()\\[\\]]*[^\\s<>()\\[\\].,;:!?\'"*_])', // 7 : URL nue
      '\\*\\*(?=\\S)([^\\n]+?)\\*\\*', // 8 : gras
      '(?<![\\w])__(?=\\S)([^\\n]+?)__(?![\\w])', // 9 : gras
      '~~(?=\\S)([^\\n]+?)~~', // 10 : barré
      '\\*(?=[^\\s*])([^*\\n]+?)\\*', // 11 : italique
      '(?<![\\w])_(?=[^\\s_])([^_\\n]+?)_(?![\\w])', // 12 : italique
    ].join('|'),
    'g'
  );

  const safeUrl = (u) => (/^https?:\/\/[^\s]+$/i.test(u) && u.length < 2000 ? u : null);

  function link(parent, url, label, depth) {
    const href = safeUrl(url);
    if (!href) {
      parent.append(label || url);
      return;
    }
    const a = el('a', 'md-link');
    a.href = href;
    a.title = href; // la destination réelle est toujours visible au survol
    if (label && label !== url) inline(a, label, depth + 1);
    else a.textContent = url;
    parent.append(a);
  }

  function inline(parent, text, depth = 0) {
    if (depth > 6) {
      parent.append(text);
      return;
    }
    INLINE.lastIndex = 0;
    const re = new RegExp(INLINE.source, 'g');
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] !== undefined) parent.append(m[1]);
      else if (m[3] !== undefined) parent.append(el('code', null, m[3].replace(/^ (.+) $/, '$1')));
      else if (m[5] !== undefined) link(parent, m[5], m[4] || (m[0][0] === '!' ? 'image' : ''), depth);
      else if (m[6] !== undefined) link(parent, m[6], '', depth);
      else if (m[7] !== undefined) link(parent, m[7], '', depth);
      else {
        const [tag, body] =
          m[8] !== undefined ? ['strong', m[8]]
          : m[9] !== undefined ? ['strong', m[9]]
          : m[10] !== undefined ? ['del', m[10]]
          : m[11] !== undefined ? ['em', m[11]]
          : ['em', m[12]];
        const n = el(tag);
        inline(n, body, depth + 1);
        parent.append(n);
      }
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  // ---------- blocs ----------

  const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const ITEM = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
  const QUOTE = /^\s{0,3}>\s?(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  const cells = (line) => {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  };

  function codeBlock(lang, body) {
    const box = el('div', 'codeblock');
    const head = el('div', 'code-head');
    head.append(el('span', 'code-lang', lang || 'code'));
    const copy = el('button', 'code-copy', 'Copier');
    copy.type = 'button';
    head.append(copy);
    const pre = el('pre');
    pre.append(el('code', null, body));
    box.append(head, pre);
    return box;
  }

  function table(header, aligns, rows) {
    const wrap = el('div', 'table-wrap');
    const t = el('table');
    const row = (tag, vals) => {
      const tr = el('tr');
      for (let i = 0; i < header.length; i++) {
        const c = el(tag);
        if (aligns[i]) c.dataset.align = aligns[i];
        inline(c, vals[i] || '');
        tr.append(c);
      }
      return tr;
    };
    const thead = el('thead');
    thead.append(row('th', header));
    const tbody = el('tbody');
    for (const r of rows) tbody.append(row('td', r));
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }

  const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;

  /** Lit une liste à partir de la ligne i ; renvoie [élément, index suivant]. */
  function list(lines, i, depth) {
    const first = lines[i].match(ITEM);
    const base = indentOf(lines[i]);
    const ordered = /\d/.test(first[2]);
    const node = el(ordered ? 'ol' : 'ul');
    if (ordered) {
      const start = parseInt(first[2], 10);
      if (start !== 1) node.start = start;
    }
    while (i < lines.length) {
      const m = lines[i].match(ITEM);
      if (!m || indentOf(lines[i]) !== base || /\d/.test(m[2]) !== ordered) break;
      const body = [m[3]];
      const inner = base + m[2].length + 1;
      i++;
      // Suite de l'élément : lignes plus indentées, ou vides suivies d'une ligne indentée.
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          const next = lines.slice(i + 1).find((x) => x.trim());
          if (next !== undefined && indentOf(next) > base) { body.push(''); i++; continue; }
          break;
        }
        if (indentOf(l) > base) { body.push(l.slice(Math.min(inner, indentOf(l)))); i++; continue; }
        break;
      }
      const li = el('li');
      const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        li.className = 'task';
        li.append(el('span', 'check' + (task[1] === ' ' ? '' : ' on')));
        body[0] = task[2];
      }
      const content = blocks(body, depth + 1);
      // Un élément simple n'a pas besoin d'un paragraphe autour de son texte.
      const firstChild = content.firstChild;
      if (firstChild && firstChild.tagName === 'P') {
        li.append(...firstChild.childNodes);
        firstChild.remove();
      }
      li.append(content);
      node.append(li);
      while (i < lines.length && !lines[i].trim()) {
        const next = lines.slice(i + 1).find((x) => x.trim());
        if (next !== undefined && ITEM.test(next) && indentOf(next) === base) i++;
        else break;
      }
    }
    return [node, i];
  }

  function blocks(lines, depth = 0) {
    const frag = document.createDocumentFragment();
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el('p');
      inline(p, para.join('\n'));
      frag.append(p);
      para = [];
    };
    if (depth > 8) {
      frag.append(el('p', null, lines.join('\n')));
      return frag;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const fence = line.match(FENCE);
      if (fence) {
        flush();
        const strip = fence[1].length;
        const body = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${fence[2][0]}{${fence[2].length},}\\s*$`).test(lines[i])) {
          body.push(lines[i].slice(Math.min(strip, indentOf(lines[i]))));
          i++;
        }
        frag.append(codeBlock(fence[3], body.join('\n')));
        continue;
      }
      if (!line.trim()) { flush(); continue; }

      const h = line.match(HEADING);
      if (h) {
        flush();
        const n = el('h' + Math.min(h[1].length + 2, 6));
        inline(n, h[2]);
        frag.append(n);
        continue;
      }
      if (HR.test(line) && !para.length) { frag.append(el('hr')); continue; }

      if (QUOTE.test(line)) {
        flush();
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)[1]);
        i--;
        const q = el('blockquote');
        q.append(blocks(body, depth + 1));
        frag.append(q);
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const header = cells(line);
        const seps = cells(lines[i + 1]);
        if (header.length === seps.length) {
          flush();
          const aligns = seps.map((s) => (s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : ''));
          const rows = [];
          i += 2;
          while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
          i--;
          frag.append(table(header, aligns, rows));
          continue;
        }
      }

      if (ITEM.test(line)) {
        flush();
        const [node, next] = list(lines, i, depth);
        frag.append(node);
        i = next - 1;
        continue;
      }

      para.push(line.trim());
    }
    flush();
    return frag;
  }

  window.renderMarkdown = (src) => blocks(String(src).replace(/\r\n?/g, '\n').split('\n'));
})();
