'use strict';
// Rendu Markdown minimal et sûr : uniquement createElement/textContent, jamais
// d'innerHTML. La sortie d'un agent ne peut donc injecter ni balise ni script.
// Les liens restent du texte (rien n'est cliquable).

(function () {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function inline(parent, text) {
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const tok = m[0];
      parent.append(tok[0] === '`' ? el('code', null, tok.slice(1, -1)) : el('strong', null, tok.slice(2, -2)));
      last = m.index + tok.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function render(src) {
    const frag = document.createDocumentFragment();
    const lines = src.split('\n');
    let para = [];
    let list = null;
    const flushPara = () => {
      if (!para.length) return;
      const p = el('p');
      inline(p, para.join('\n'));
      frag.append(p);
      para = [];
    };
    const flushList = () => { list = null; };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([\w+-]*)/);
      if (fence) {
        flushPara(); flushList();
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        const pre = el('pre');
        if (fence[1]) pre.dataset.lang = fence[1];
        pre.append(el('code', null, body.join('\n')));
        frag.append(pre);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushPara(); flushList();
        const n = el('h' + Math.min(h[1].length + 2, 6));
        inline(n, h[2]);
        frag.append(n);
        continue;
      }
      const li = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/);
      if (li) {
        flushPara();
        const tag = li[1] ? 'ul' : 'ol';
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = el(tag);
          frag.append(list);
        }
        const item = el('li');
        inline(item, li[3]);
        list.append(item);
        continue;
      }
      if (!line.trim()) {
        flushPara(); flushList();
        continue;
      }
      flushList();
      para.push(line);
    }
    flushPara();
    return frag;
  }

  window.renderMarkdown = render;
})();
