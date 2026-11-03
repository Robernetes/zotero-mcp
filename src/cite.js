// cite.js
// Motor de citas y bibliografía basado en citeproc-js (CSL).
// Mantiene un registro de citas por documento: al citar en orden se
// asignan números consistentes (estilos numéricos) y la bibliografía
// se regenera automáticamente desde el registro.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import citeprocModule from 'citeproc';

const { Engine } = citeprocModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STYLES_DIR = path.join(__dirname, 'csl');
export const LOCALES_DIR = path.join(__dirname, 'locales');

export const STYLES = [
  'apa',
  'mla',
  'chicago-author-date',
  'harvard-cite-them-right',
  'harvard',
  'ieee',
  'vancouver',
];

const STYLE_ALIASES = { harvard: 'harvard-cite-them-right' };
export const AVAILABLE_STYLES = ['apa', 'mla', 'chicago-author-date', 'harvard-cite-them-right', 'ieee', 'vancouver'];

export const LOCALES = ['es-ES', 'en-US'];
const LOCALE_FALLBACK = 'en-US';

export const FORMATS = ['plaintext', 'markdown', 'html'];

const ZOTERO_STYLE_PREFIX = 'http://www.zotero.org/styles/';

/** Nombre de estilo soportado (resuelve alias y mayúsculas) o error con la lista disponible. */
export function resolveStyleName(style) {
  const s = String(style || 'apa').trim().toLowerCase();
  const name = STYLE_ALIASES[s] || s;
  if (!AVAILABLE_STYLES.includes(name)) {
    throw new Error(`Estilo no soportado: "${style}". Estilos disponibles: ${AVAILABLE_STYLES.join(', ')}.`);
  }
  return name;
}

/** ID de estilo de Zotero (http://www.zotero.org/styles/<nombre>) para un estilo soportado. */
export function zoteroStyleId(style) {
  return ZOTERO_STYLE_PREFIX + resolveStyleName(style);
}

/** Estilo soportado que corresponde a un ID de estilo de Zotero, o null si no está disponible. */
export function styleNameFromZoteroId(styleID) {
  const m = String(styleID || '').match(/^https?:\/\/(?:www\.)?zotero\.org\/styles\/([\w-]+)\/?$/);
  return m && AVAILABLE_STYLES.includes(m[1]) ? m[1] : null;
}

export class CitationManager {
  /**
   * @param {object} opts
   * @param {(keys: string[]) => Promise<Array<object>>} opts.fetchItems
   *   Devuelve items CSL JSON (con `id` = key de Zotero) para las keys pedidas.
   */
  constructor({ fetchItems, stylesDir = STYLES_DIR, localesDir = LOCALES_DIR } = {}) {
    if (typeof fetchItems !== 'function') {
      throw new Error('CitationManager requiere un fetchItems(keys) que devuelva items CSL JSON.');
    }
    this.fetchItems = fetchItems;
    this.stylesDir = stylesDir;
    this.localesDir = localesDir;
    this.itemCache = new Map();
    this.state = null; // { style, locale, engine, citationList, noteIndex }
  }

  _normalizeStyle(style) {
    return resolveStyleName(style);
  }

  _normalizeLocale(locale) {
    let lang = String(locale || 'es-ES');
    if (!LOCALES.includes(lang)) lang = LOCALE_FALLBACK;
    return lang;
  }

  _loadStyle(style) {
    return readFileSync(path.join(this.stylesDir, `${style}.csl`), 'utf8');
  }

  _loadLocale(locale) {
    return readFileSync(path.join(this.localesDir, `locales-${locale}.xml`), 'utf8');
  }

  /** Motor citeproc que resuelve los items desde `itemCache` (por defecto, la caché del manager). */
  _buildEngine(style, locale, itemCache = this.itemCache) {
    const styleXml = this._loadStyle(style);
    const localeXml = this._loadLocale(locale);
    const sys = {
      retrieveLocale: () => localeXml,
      retrieveItem: (id) => {
        const item = itemCache.get(String(id));
        if (!item) {
          throw new Error(`El item "${id}" no está disponible en el registro de citas.`);
        }
        return item;
      },
    };
    // forceLocale = true: usar el locale pedido aunque el estilo tenga otro por defecto.
    return new Engine(sys, styleXml, locale, true);
  }

  _ensureState(style, locale) {
    if (!this.state || this.state.style !== style || this.state.locale !== locale) {
      this.state = {
        style,
        locale,
        engine: this._buildEngine(style, locale),
        citationList: [],
        noteIndex: 0,
      };
    }
    return this.state;
  }

  async _loadItems(keys) {
    const missing = (keys || []).filter((k) => k && !this.itemCache.has(String(k)));
    if (missing.length > 0) {
      const fetched = await this.fetchItems(missing);
      for (const item of fetched || []) {
        if (item && item.id != null) this.itemCache.set(String(item.id), item);
      }
    }
    return keys.map((k) => this.itemCache.get(String(k))).filter(Boolean);
  }

  /** Reinicia el registro de citas (nuevo documento). */
  reset() {
    this.state = null;
    this.itemCache.clear();
  }

  /**
   * Genera una cita textual para un item.
   * Con `register: false` la cita se calcula en un motor temporal (con las citas
   * ya registradas como contexto) y el registro no cambia en absoluto.
   * @returns {Promise<{citation: string, style: string, locale: string, itemKey: string, registered: boolean}>}
   */
  async cite({ key, style = 'apa', locale = 'es-ES', locator, label, prefix, suffix, register = true } = {}) {
    if (!key) throw new Error('Se requiere la key del item de Zotero.');
    const styleName = this._normalizeStyle(style);
    const localeName = this._normalizeLocale(locale);
    const [item] = await this._loadItems([key]);
    if (!item) {
      throw new Error(
        `No se encontró en Zotero un item con key "${key}". Verifica la key con zotero_search o zotero_get_item.`
      );
    }
    const citationItem = { id: key, locator, label, prefix, suffix };
    let rendered;
    if (register) {
      const state = this._ensureState(styleName, localeName);
      const citation = {
        citationID: `CITE-${++state.noteIndex}`,
        citationItems: [citationItem],
        properties: { noteIndex: state.noteIndex },
      };
      const pre = toPreList(state.citationList);
      state.citationList.push(citation);
      const out = state.engine.processCitationCluster(citation, pre, [], 'citation');
      rendered = extractCitationText(out, pre.length);
    } else {
      // Contexto: las citas registradas, solo si son del mismo style/locale.
      const sameState = this.state && this.state.style === styleName && this.state.locale === localeName;
      const before = sameState ? this.state.citationList.map((c) => c.citationItems) : [];
      rendered = this._renderCluster(styleName, localeName, this.itemCache, before, [citationItem], []);
    }
    return {
      citation: rendered,
      style: styleName,
      locale: localeName,
      itemKey: key,
      registered: Boolean(register),
    };
  }

  /**
   * Genera la bibliografía.
   * @param {object} opts
   * @param {string[]} [opts.keys] Si se omite, usa el registro de citas del documento.
   * @param {object[]} [opts.items] Items CSL JSON ya resueltos (p. ej. los incrustados en un .docx),
   *   en orden de cita. Tiene prioridad sobre `keys` y no consulta Zotero ni altera el registro.
   * @param {'plaintext'|'markdown'|'html'} [opts.format=markdown]
   * @returns {Promise<{entries: string[], bibliography: string, format: string, count: number, source: 'registro'|'claves'|'items'}>}
   */
  async bibliography({ style = 'apa', locale = 'es-ES', keys, items, format = 'markdown' } = {}) {
    const styleName = this._normalizeStyle(style);
    const localeName = this._normalizeLocale(locale);
    const outputFormat = FORMATS.includes(format) ? format : 'markdown';

    if (items && items.length > 0) {
      const cache = new Map();
      for (const item of items) {
        if (item && item.id != null && !cache.has(String(item.id))) cache.set(String(item.id), item);
      }
      return this._renderOrdered([...cache.keys()], cache, styleName, localeName, outputFormat, 'items');
    }

    if (keys && keys.length > 0) {
      await this._loadItems(keys);
      const missing = keys.filter((k) => !this.itemCache.has(String(k)));
      if (missing.length > 0) {
        throw new Error(`No se encontraron en Zotero los items con key: ${missing.join(', ')}.`);
      }
      return this._renderOrdered(keys, this.itemCache, styleName, localeName, outputFormat, 'claves');
    }

    const state = this._ensureState(styleName, localeName);
    if (state.citationList.length === 0) {
      return { entries: [], bibliography: '', format: outputFormat, count: 0, source: 'registro' };
    }
    return this._render(state.engine, outputFormat, 'registro');
  }

  /**
   * Cita textual calculada en un motor temporal a partir de items ya resueltos,
   * sin consultar Zotero ni tocar el registro. Pensado para documentos que
   * llevan sus propias citas (p. ej. un .docx).
   * @param {object} opts
   * @param {object[]} opts.items Items CSL JSON (id = el que usan las citas).
   * @param {Array<Array<object>>} [opts.before] Citas del documento anteriores a la nueva,
   *   cada una como lista de citationItems ({id, locator, label, prefix, suffix}).
   * @param {Array<object>} opts.citationItems La cita nueva.
   * @param {Array<Array<object>>} [opts.after] Citas del documento posteriores a la nueva.
   * @returns {{citation: string, style: string, locale: string}}
   */
  renderCitation({ style = 'apa', locale = 'es-ES', items, before = [], citationItems, after = [] } = {}) {
    const styleName = this._normalizeStyle(style);
    const localeName = this._normalizeLocale(locale);
    const cache = new Map();
    for (const item of items || []) {
      if (item && item.id != null) cache.set(String(item.id), item);
    }
    const missing = [...before, citationItems, ...after]
      .flat()
      .filter((ci) => ci && !cache.has(String(ci.id)))
      .map((ci) => ci.id);
    if (missing.length > 0) {
      throw new Error(`Faltan los datos de los items: ${[...new Set(missing)].join(', ')}.`);
    }
    const citation = this._renderCluster(styleName, localeName, cache, before, citationItems, after);
    return { citation, style: styleName, locale: localeName };
  }

  /** Registra `before` y `after` en un motor temporal y devuelve el texto de la cita nueva. */
  _renderCluster(styleName, localeName, itemCache, before, citationItems, after) {
    const engine = this._buildEngine(styleName, localeName, itemCache);
    const existing = processInOrder(engine, [...before, ...after], 'DOC');
    const pre = existing.slice(0, before.length);
    const post = existing.slice(before.length);
    const citation = {
      citationID: 'NEW',
      citationItems: citationItems.map((ci) => ({ ...ci, id: String(ci.id) })),
      properties: { noteIndex: before.length + 1 },
    };
    const out = engine.processCitationCluster(citation, pre, post, 'citation');
    return extractCitationText(out, pre.length);
  }

  /** Bibliografía con un motor temporal: cita las keys en orden sin tocar el registro. */
  _renderOrdered(keys, itemCache, styleName, localeName, format, source) {
    const engine = this._buildEngine(styleName, localeName, itemCache);
    processInOrder(engine, keys.map((k) => [{ id: String(k) }]), 'TEMP');
    return this._render(engine, format, source);
  }

  _render(engine, format, source) {
    const [, bibEntries] = engine.makeBibliography();
    const entries = (bibEntries || []).map((e) => {
      const html = typeof e === 'string' ? e : e && e.entry ? e.entry : '';
      return { html, text: htmlToText(html) };
    });
    const lines = entries.map((e) => (format === 'html' ? e.html : e.text));
    const separator = format === 'html' ? '\n' : '\n\n';
    return {
      entries: lines,
      bibliography: lines.join(separator),
      format,
      count: entries.length,
      source,
    };
  }
}

function toPreList(citationList) {
  return (citationList || []).map((c) => [c.citationID, c.properties.noteIndex]);
}

/**
 * Registra en el motor una lista de citas (cada una, lista de citationItems)
 * en orden y devuelve sus pares [citationID, noteIndex].
 */
function processInOrder(engine, clusters, idPrefix) {
  const done = [];
  clusters.forEach((citationItems, i) => {
    const citation = {
      citationID: `${idPrefix}-${i + 1}`,
      citationItems: citationItems.map((ci) => ({ ...ci, id: String(ci.id) })),
      properties: { noteIndex: i + 1 },
    };
    engine.processCitationCluster(citation, done.slice(), [], 'citation');
    done.push([citation.citationID, citation.properties.noteIndex]);
  });
  return done;
}

// processCitationCluster devuelve [return_data, ret]: ret es una lista de pares
// [índice, texto] con la cita nueva y las ya existentes que cambiaron (p. ej. al
// desambiguar "2020a"/"2020b"). Se toma solo el par de la cita nueva (`index`)
// y se devuelve como texto plano: citeproc genera HTML ("&#38;" para "&").
function extractCitationText(out, index) {
  let html = '';
  if (Array.isArray(out)) {
    if (Array.isArray(out[1])) {
      const pairs = out[1].filter(Array.isArray);
      const own = pairs.find((pair) => pair[0] === index);
      html = own ? String(own[1] ?? '') : pairs.map((pair) => String(pair[1] ?? '')).join('');
    } else if (typeof out[1] === 'string') html = out[1];
    else if (typeof out[0] === 'string') html = out[0];
  } else if (typeof out === 'string') {
    html = out;
  }
  return htmlToText(html);
}

function htmlToText(html) {
  return String(html ?? '')
    // Estilos numéricos: <div class="csl-left-margin">[1]</div><div class="csl-right-inline">…
    // → "[1] …" (sin esto el número queda pegado al autor).
    .replace(/<\/div>\s*<div[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2019;/gi, "'")
    .replace(/&#x201C;/gi, '"')
    .replace(/&#x201D;/gi, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
