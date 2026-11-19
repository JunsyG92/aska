'use strict';
// Translations, independent of Electron (also used by "aska --help").
// The language is decided where the config is loaded: "language" in the
// config ("auto" by default), else the first supported system language,
// else English.

const DICTS = { en: require('./en'), fr: require('./fr') };
const LANGUAGES = Object.keys(DICTS);
const FALLBACK = 'en';

let current = FALLBACK;

// "fr_FR.UTF-8", "fr-CA", "fr" -> "fr"; "C", "POSIX", "C.UTF-8" -> null.
function primary(tag) {
  if (typeof tag !== 'string') return null;
  const p = tag.trim().split(/[-_.@]/)[0].toLowerCase();
  return !p || p === 'c' || p === 'posix' ? null : p;
}

/** Language to use: explicit preference, else the first supported system language, else English. */
function resolveLanguage(pref, systemLangs = []) {
  if (LANGUAGES.includes(pref)) return pref;
  for (const tag of systemLangs) {
    const p = primary(tag);
    if (p && LANGUAGES.includes(p)) return p;
  }
  return FALLBACK;
}

/** System languages outside Electron, most important first. */
function systemLanguages(env = process.env) {
  const tags = [env.LC_ALL, env.LC_MESSAGES, env.LANG, ...(env.LANGUAGE || '').split(':')];
  try {
    tags.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch { /* no Intl locale */ }
  return tags.filter((tag) => primary(tag));
}

function setLanguage(lang) {
  current = LANGUAGES.includes(lang) ? lang : FALLBACK;
  return current;
}

const getLanguage = () => current;

const lookup = (dict, key) =>
  key.split('.').reduce((o, k) => (o && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), dict);

// Shortcut of each configurable action ({key:newTab} in a string), set from the config (see keys.js).
let keyLabels = {};
function setKeyLabels(labels) {
  keyLabels = { ...labels };
}

const format = (s, params) =>
  s.replace(/\{(key:)?(\w+)\}/g, (m, isKey, k) => {
    if (isKey) return Object.hasOwn(keyLabels, k) ? keyLabels[k] : m;
    return Object.hasOwn(params, k) ? String(params[k]) : m;
  });

/** Translated string; plural objects are picked with params.count. Falls back to English, then to the key. */
function t(key, params = {}) {
  let lang = current;
  let v = lookup(DICTS[lang], key);
  if (v === undefined) {
    lang = FALLBACK;
    v = lookup(DICTS[lang], key);
  }
  if (v && typeof v === 'object' && typeof params.count === 'number') {
    v = v[new Intl.PluralRules(lang).select(params.count)] ?? v.other;
  }
  return typeof v === 'string' ? format(v, params) : key;
}

// English strings completed (or replaced) by those of the current language.
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && base[k] && typeof base[k] === 'object' && !('other' in v) ? merge(base[k], v) : v;
  }
  return out;
}

/** UI strings for the renderer (plain data, sent over IPC). */
const uiStrings = () => merge(DICTS[FALLBACK].ui, DICTS[current].ui);

module.exports = { LANGUAGES, DICTS, resolveLanguage, systemLanguages, setLanguage, getLanguage, t, uiStrings, setKeyLabels };
