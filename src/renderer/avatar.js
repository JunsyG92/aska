'use strict';
// Generated bot avatars: a holographic robot drawn from the bot's name (same
// name and variant, same robot), with an emblem guessed from its name. Pure SVG
// built as a string, no image and no network; shown through <img src="data:…">,
// where an SVG never runs scripts. Shared with the main process (default
// color of a bot) and the unit tests.

(function (root) {
  // FNV-1a hash, then mulberry32: the same seed always draws the same robot.
  function hash(str) {
    let h = 2166136261 >>> 0;
    for (const ch of str) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const rr = (x, y, w, h, r) =>
    `M${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;

  // Head shapes: outline, top (antennas), sides at eye level (ears).
  const SHAPES = {
    square: { d: rr(15, 19, 34, 32, 6), top: 19, l: 15, r: 49 },
    dome: { d: 'M15 51 V35 A17 17 0 0 1 49 35 V51 Z', top: 18, l: 15, r: 49 },
    hexagon: { d: 'M32 17 L49 26 V44 L32 53 L15 44 V26 Z', top: 17, l: 15, r: 49 },
    trapeze: { d: 'M12 20 H52 L46 51 H18 Z', top: 20, l: 15, r: 49 },
    capsule: { d: rr(19, 15, 26, 38, 13), top: 15, l: 19, r: 45 },
    octagon: { d: 'M23 18 H41 L50 27 V43 L41 52 H23 L14 43 V27 Z', top: 18, l: 14, r: 50 },
    screen: { d: rr(12, 21, 40, 29, 4), top: 21, l: 12, r: 52 },
    shield: { d: 'M15 19 H49 V36 Q49 48 32 54 Q15 48 15 36 Z', top: 19, l: 15, r: 49 },
  };

  // Emblems: small line pictograms (16 x 16 grid) and the word starts that pick them
  // (French and English, without accents).
  const EMBLEMS = {
    translation: { keys: ['trad', 'transl', 'langu', 'lingu'], d: '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.6" ry="6"/><path d="M2 8 H14"/>' },
    check: { keys: ['correct', 'ortho', 'gramm', 'fix'], d: '<path d="M2.5 8.5 L6.5 12.5 L13.5 4"/>' },
    search: { keys: ['relect', 'review', 'revis', 'audit', 'cherch', 'search'], d: '<circle cx="6.8" cy="6.8" r="4.3"/><path d="M10 10 L14 14"/>' },
    question: { keys: ['expli', 'explain', 'tuteur', 'tutor', 'prof', 'learn', 'appren'], d: '<path d="M5.5 6 Q5.5 2.8 8 2.8 Q10.6 2.8 10.6 5.4 Q10.6 7.4 8 8.4 V10"/><circle cx="8" cy="13.2" r=".6"/>' },
    git: { keys: ['commit', 'git', 'merge', 'branch'], d: '<circle cx="4.5" cy="3.5" r="1.8"/><circle cx="4.5" cy="12.5" r="1.8"/><circle cx="11.5" cy="5.5" r="1.8"/><path d="M4.5 5.3 V10.7 M11.5 7.3 Q11.5 10 4.5 10.8"/>' },
    terminal: { keys: ['shell', 'term', 'bash', 'cli', 'command', 'devops', 'ops', 'sysadmin'], d: '<path d="M2.5 4 L6.5 8 L2.5 12 M8 12.5 H13.5"/>' },
    bug: { keys: ['debug', 'bug', 'test', 'qa'], d: '<ellipse cx="8" cy="9" rx="3.4" ry="4.4"/><path d="M8 4.6 V13.4 M4.6 7 L2 5.5 M11.4 7 L14 5.5 M4.6 10.5 L2 11.5 M11.4 10.5 L14 11.5 M6.5 4.8 L5.5 2.5 M9.5 4.8 L10.5 2.5"/>' },
    watch: { keys: ['veill', 'watch', 'monit', 'surveil', 'guet', 'news'], d: '<path d="M1.5 8 Q8 1.8 14.5 8 Q8 14.2 1.5 8 Z"/><circle cx="8" cy="8" r="2"/>' },
    pen: { keys: ['redac', 'writ', 'ecri', 'blog', 'copy', 'auteur', 'author', 'story'], d: '<path d="M3 13 L4 9.5 L11 2.5 L13.5 5 L6.5 12 Z M9.5 4 L12 6.5"/>' },
    archive: { keys: ['archiv', 'stock', 'doc', 'biblio', 'notes'], d: '<path d="M2.5 5.5 H13.5 V13 H2.5 Z M2 3 H14 V5.5 H2 Z M6.5 8 H9.5"/>' },
    star: { keys: ['coach', 'motiv', 'mentor', 'sport'], d: '<path d="M8 1.8 L9.8 5.9 L14.2 6.3 L10.9 9.2 L11.9 13.6 L8 11.3 L4.1 13.6 L5.1 9.2 L1.8 6.3 L6.2 5.9 Z"/>' },
    chef: { keys: ['cuisin', 'chef', 'recet', 'cook', 'recipe'], d: '<path d="M4.5 10 Q1.5 8.5 2.8 5.5 Q4 3 6.4 4 Q8 1.2 9.8 4 Q12.2 3 13.3 5.5 Q14.5 8.5 11.5 10 Z M4.5 10 V13.5 H11.5 V10"/>' },
    lock: { keys: ['secu', 'secur', 'pentest', 'vault', 'crypt'], d: '<rect x="3.5" y="7.5" width="9" height="6.5" rx="1"/><path d="M5.5 7.5 V5.5 Q5.5 2.8 8 2.8 Q10.5 2.8 10.5 5.5 V7.5"/>' },
    mail: { keys: ['mail', 'courri', 'inbox', 'messag'], d: '<rect x="2" y="3.5" width="12" height="9" rx="1"/><path d="M2.5 4.5 L8 8.8 L13.5 4.5"/>' },
    calendar: { keys: ['agenda', 'calend', 'plann', 'sched', 'rdv'], d: '<rect x="2.5" y="3.5" width="11" height="10" rx="1"/><path d="M2.5 6.5 H13.5 M5.5 2 V5 M10.5 2 V5"/>' },
    chart: { keys: ['financ', 'budget', 'stat', 'data', 'analy', 'compta', 'money'], d: '<path d="M3 13.5 V9 M6.3 13.5 V5.5 M9.6 13.5 V7.5 M12.9 13.5 V3"/>' },
  };
  const HUES = [186, 200, 168, 285, 312, 42, 132, 222];

  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  /** Emblem guessed from the words of the name, or null (no known job: the initial). */
  function guessEmblem(name) {
    const words = norm(name).split(/[^a-z0-9]+/).filter(Boolean);
    for (const [id, e] of Object.entries(EMBLEMS)) {
      if (words.some((w) => e.keys.some((k) => w.startsWith(k)))) return id;
    }
    return null;
  }

  // The first draws of the seed: hue, then shape (as in the avatar itself).
  const seedOf = (name, variant) => rng(hash(norm(name).trim() + '#' + (variant || 0)));

  /** Neon color of the avatar, as #rrggbb: a bot's color when bot.json gives none. */
  function avatarColor(name, variant = 0) {
    const h = pick(seedOf(name, variant), HUES);
    // hsl(h 100% 62%) in RGB.
    const l = 0.62;
    const a = 1 - Math.abs(2 * l - 1);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const v = l - (a / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(v * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  /** Hue (0-359) of a #rrggbb color, or null. */
  function hueOf(color) {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return null;
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return Math.round((h * 60 + 360) % 360);
  }

  /**
   * name: the bot's name; opts: { variant, shape ('auto' | id), emblem ('auto' | id | 'none'),
   * badge (emblem shown), animate (scan line while the bot works),
   * color (#rrggbb: the robot takes its hue; else one drawn from the name) }.
   * Returns a standalone SVG (viewBox 64 x 64).
   */
  function avatar(name, opts = {}) {
    const { variant = 0, shape = 'auto', emblem = 'auto', badge = true, animate = false, color = null } = opts;
    const r = seedOf(name, variant);
    const drawn = pick(r, HUES); // always drawn: the rest of the robot stays the same
    const h = hueOf(color) ?? drawn;
    const shapeId = pick(r, Object.keys(SHAPES));
    const S = SHAPES[shape !== 'auto' && Object.hasOwn(SHAPES, shape) ? shape : shapeId];
    const neon = `hsl(${h} 100% 62%)`;
    const glowc = `hsl(${h} 100% 84%)`;
    const ghost = `hsl(${(h + 150) % 360} 100% 64%)`;
    const id = 'a'; // one SVG per image: ids never meet another avatar's
    const dx = pick(r, [-1, 0, 1]);

    const ant = pick(r, ['one', 'two', 'bolt', 'dish', 'none']);
    const ears = pick(r, ['plate', 'ring', 'fin', 'none']);
    const eyes = pick(r, ['round', 'visor', 'cyclops', 'led', 'happy']);
    const mouth = pick(r, ['smile', 'grin', 'teeth', 'cat']);
    const cheeks = r() < 0.5;

    const T = S.top;
    const cx = 32;
    let parts = '';
    // antennas
    if (ant === 'one') parts += `<path d="M${cx} ${T} V${T - 8}" class="ln"/><circle cx="${cx}" cy="${T - 10}" r="2.6" class="dot"/>`;
    if (ant === 'two') parts += `<path d="M26 ${T + 1} L21 ${T - 8} M38 ${T + 1} L43 ${T - 8}" class="ln"/><circle cx="21" cy="${T - 9.5}" r="2.2" class="dot"/><circle cx="43" cy="${T - 9.5}" r="2.2" class="dot"/>`;
    if (ant === 'bolt') parts += `<path d="M33 ${T} L29 ${T - 5} L35 ${T - 6} L31 ${T - 12}" class="ln"/>`;
    if (ant === 'dish') parts += `<path d="M${cx} ${T} V${T - 5} M${cx - 6} ${T - 9} Q${cx} ${T - 3} ${cx + 6} ${T - 9}" class="ln"/><circle cx="${cx}" cy="${T - 9.5}" r="1.3" class="dot"/>`;
    // ears
    if (ears === 'plate') parts += `<rect x="${S.l - 5}" y="29" width="5" height="11" rx="1.5" class="sh"/><rect x="${S.r}" y="29" width="5" height="11" rx="1.5" class="sh"/>`;
    if (ears === 'ring') parts += `<circle cx="${S.l - 2.5}" cy="34.5" r="3.6" class="sh"/><circle cx="${S.r + 2.5}" cy="34.5" r="3.6" class="sh"/>`;
    if (ears === 'fin') parts += `<path d="M${S.l} 29 L${S.l - 6} 25 V40 L${S.l} 39 Z M${S.r} 29 L${S.r + 6} 25 V40 L${S.r} 39 Z" class="sh"/>`;
    // head
    parts += `<path d="${S.d}" class="hd"/>`;
    // eyes (y = 34)
    if (eyes === 'round') parts += [25, 39].map((x) => `<circle cx="${x}" cy="34" r="4.6" class="eo"/><circle cx="${x + dx}" cy="34" r="2" class="ei"/>`).join('');
    if (eyes === 'visor') parts += `<rect x="19" y="29.5" width="26" height="9" rx="4.5" class="eo"/><rect x="${23 + dx * 2}" y="32.5" width="8" height="3" rx="1.5" class="ei"/><rect x="${34 + dx * 2}" y="32.5" width="5" height="3" rx="1.5" class="ei"/>`;
    if (eyes === 'cyclops') parts += `<circle cx="32" cy="34" r="7" class="eo"/><circle cx="32" cy="34" r="4" class="eo"/><circle cx="${32 + dx}" cy="34" r="2" class="ei"/>`;
    if (eyes === 'led') parts += [20.5, 34.5].map((x) => `<rect x="${x}" y="29.5" width="9" height="9" rx="1.5" class="eo"/><rect x="${x + 2.5 + dx}" y="32" width="4" height="4" class="ei"/>`).join('');
    if (eyes === 'happy') parts += '<path d="M21 35.5 Q25 30.5 29 35.5 M35 35.5 Q39 30.5 43 35.5" class="ln ei-ln"/>';
    // mouth (y = 43), always smiling
    if (mouth === 'smile') parts += '<path d="M25.5 41.5 Q32 48.5 38.5 41.5" class="ln"/>';
    if (mouth === 'grin') parts += '<path d="M25 41 Q32 42 39 41 Q37.5 48.5 32 48.5 Q26.5 48.5 25 41 Z" class="eo"/><path d="M28.5 46.6 Q32 45 35.5 46.6" class="fine"/>';
    if (mouth === 'teeth') parts += '<path d="M25 41 Q32 42 39 41 Q37.5 48.5 32 48.5 Q26.5 48.5 25 41 Z" class="eo"/><path d="M28.7 41.6 V47 M32 41.8 V48.3 M35.3 41.6 V47" class="fine"/>';
    if (mouth === 'cat') parts += '<path d="M25.5 42 Q28.8 46.5 32 42.5 Q35.2 46.5 38.5 42" class="ln"/>';
    if (cheeks) parts += '<path d="M18.5 40 L21 38.5 M18.5 42.5 L21 41 M45.5 38.5 L43 40 M45.5 41 L43 42.5" class="fine"/>';

    // emblem in a badge (bottom right); none at small sizes (badge: false)
    let badgeSvg = '';
    const em = emblem === 'auto' ? guessEmblem(name) : emblem;
    if (badge && em !== 'none') {
      const inner =
        em && Object.hasOwn(EMBLEMS, em)
          ? `<g transform="translate(43.2 43.2) scale(.73)" class="em">${EMBLEMS[em].d}</g>`
          : `<text x="49" y="52.6" text-anchor="middle" class="ini">${esc((norm(name).match(/[a-z0-9]/) || ['?'])[0].toUpperCase())}</text>`;
      badgeSvg = `<path d="M49 40.5 L56.4 44.7 V53.3 L49 57.5 L41.6 53.3 V44.7 Z" class="bd"/>${inner}`;
    }

    const anim = animate ? `<rect x="0" y="-8" width="64" height="8" fill="url(#${id}sb)"><animate attributeName="y" values="-8;64" dur="2.2s" repeatCount="indefinite"/></rect>` : '';
    const flicker = animate ? '<animate attributeName="opacity" values="1;.82;1;1;.9;1" dur="1.6s" repeatCount="indefinite"/>' : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${esc(name)}">
<defs>
<radialGradient id="${id}bg" cx="50%" cy="38%" r="65%"><stop offset="0" stop-color="hsl(${h} 70% 17%)"/><stop offset="1" stop-color="#05070d"/></radialGradient>
<linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${neon}" stop-opacity=".42"/><stop offset="1" stop-color="${neon}" stop-opacity=".06"/></linearGradient>
<linearGradient id="${id}bm" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${neon}" stop-opacity=".38"/><stop offset="1" stop-color="${neon}" stop-opacity="0"/></linearGradient>
<linearGradient id="${id}sb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${glowc}" stop-opacity="0"/><stop offset=".5" stop-color="${glowc}" stop-opacity=".35"/><stop offset="1" stop-color="${glowc}" stop-opacity="0"/></linearGradient>
<pattern id="${id}sc" width="4" height="2.2" patternUnits="userSpaceOnUse"><rect width="4" height=".8" fill="#000" opacity=".32"/></pattern>
<filter id="${id}g" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<clipPath id="${id}c"><circle cx="32" cy="32" r="32"/></clipPath>
<style>
.ln{fill:none;stroke:${neon};stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.fine{fill:none;stroke:${glowc};stroke-width:.9;stroke-linecap:round;opacity:.8}
.dot{fill:${glowc}}
.sh{fill:url(#${id}f);stroke:${neon};stroke-width:1.2}
.hd{fill:url(#${id}f);stroke:${neon};stroke-width:1.6;stroke-linejoin:round}
.eo{fill:#05070d;fill-opacity:.55;stroke:${neon};stroke-width:1.2}
.ei{fill:${glowc}}
.ei-ln{stroke:${glowc};stroke-width:2.4}
.bd{fill:#05070d;stroke:${neon};stroke-width:1.3;stroke-linejoin:round}
.em{fill:none;stroke:${glowc};stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.ini{font:700 9.5px ui-monospace,Consolas,monospace;fill:${glowc}}
</style>
</defs>
<g clip-path="url(#${id}c)">
<rect width="64" height="64" fill="url(#${id}bg)"/>
<path d="M22 64 H42 L54 14 H10 Z" fill="url(#${id}bm)" opacity=".55"/>
<ellipse cx="32" cy="60.5" rx="11" ry="2.2" fill="${neon}" opacity=".75" filter="url(#${id}g)"/>
<g transform="translate(-1 .3)" opacity=".38"><path d="${S.d}" fill="none" stroke="${ghost}" stroke-width="1.2"/></g>
<g filter="url(#${id}g)">${flicker}${parts}</g>
${anim}
<rect width="64" height="64" fill="url(#${id}sc)"/>
${badgeSvg ? `<g filter="url(#${id}g)">${badgeSvg}</g>` : ''}
<circle cx="32" cy="32" r="31.4" fill="none" stroke="${neon}" stroke-opacity=".35"/>
</g>
</svg>`;
  }

  // data: URLs, built once per combination (the thread redraws often).
  const cache = new Map();
  function avatarDataUrl(name, opts = {}) {
    const o = { variant: 0, shape: 'auto', emblem: 'auto', badge: true, animate: false, color: null, ...opts };
    const key = JSON.stringify([name, o.variant, o.shape, o.emblem, o.badge, o.animate, o.color]);
    let url = cache.get(key);
    if (!url) {
      if (cache.size > 300) cache.clear();
      url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(avatar(name, o));
      cache.set(key, url);
    }
    return url;
  }

  const api = { avatar, avatarDataUrl, avatarColor, guessEmblem, SHAPES: Object.keys(SHAPES), EMBLEMS: Object.keys(EMBLEMS) };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AskaAvatar = api;
})(typeof window === 'object' ? window : globalThis);
