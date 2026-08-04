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
    const s = String(style || 'apa').toLowerCase();
    const name = STYLE_ALIASES[s] || s;
    if (!STYLES.includes(name)) {
      throw new Error(
        `Estilo no soportado: "${style}". Estilos disponibles: ${AVAILABLE_STYLES.join(', ')}.`
      );
    }
    return name;
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

  _buildEngine(style, locale) {
    const styleXml = this._loadStyle(style);
    const localeXml = this._loadLocale(locale);
    const sys = {
      retrieveLocale: () => localeXml,
      retrieveItem: (id) => {
        const item = this.itemCache.get(String(id));
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
    const state = this._ensureState(styleName, localeName);
    const citation = {
      citationID: `CITE-${++state.noteIndex}`,
      citationItems: [{ id: key, locator, label, prefix, suffix }],
      properties: { noteIndex: state.noteIndex },
    };
    if (register) state.citationList.push(citation);
    // citeproc-js espera las citas previas como pares [citationID, noteIndex].
    const pre = register
      ? toPreList(state.citationList.slice(0, -1))
      : toPreList(state.citationList);
    const out = state.engine.processCitationCluster(citation, pre, [], 'citation');
    const rendered = extractCitationText(out).trim();
    return {
      citation: rendered.trim(),
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
   * @param {'plaintext'|'markdown'|'html'} [opts.format=markdown]
   * @returns {Promise<{entries: string[], bibliography: string, format: string, count: number, source: 'registro'|'claves'}>}
   */
  async bibliography({ style = 'apa', locale = 'es-ES', keys, format = 'markdown' } = {}) {
    const styleName = this._normalizeStyle(style);
    const localeName = this._normalizeLocale(locale);
    const outputFormat = FORMATS.includes(format) ? format : 'markdown';

    if (keys && keys.length > 0) {
      await this._loadItems(keys);
      const missing = keys.filter((k) => !this.itemCache.has(String(k)));
      if (missing.length > 0) {
        throw new Error(`No se encontraron en Zotero los items con key: ${missing.join(', ')}.`);
      }
      // Motor temporal: no altera el registro del documento.
      const temp = new CitationManager({
        fetchItems: this.fetchItems,
        stylesDir: this.stylesDir,
        localesDir: this.localesDir,
      });
      temp.itemCache = this.itemCache;
      const tempState = temp._ensureState(styleName, localeName);
      for (const k of keys) {
        const citation = {
          citationID: `TEMP-${++tempState.noteIndex}`,
          citationItems: [{ id: String(k) }],
          properties: { noteIndex: tempState.noteIndex },
        };
        tempState.citationList.push(citation);
        tempState.engine.processCitationCluster(
          citation,
          toPreList(tempState.citationList.slice(0, -1)),
          [],
          'citation'
        );
      }
      return this._render(tempState.engine, outputFormat, 'claves');
    }

    const state = this._ensureState(styleName, localeName);
    if (state.citationList.length === 0) {
      return { entries: [], bibliography: '', format: outputFormat, count: 0, source: 'registro' };
    }
    return this._render(state.engine, outputFormat, 'registro');
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

// processCitationCluster devuelve [return_data, ret] donde ret es una lista
// de pares [índice, texto]; el texto de la cita es la concatenación de los pares.
function extractCitationText(out) {
  if (Array.isArray(out)) {
    if (Array.isArray(out[1])) {
      return out[1]
        .map((pair) => (Array.isArray(pair) ? String(pair[1] ?? '') : ''))
        .join('');
    }
    if (typeof out[1] === 'string') return out[1];
    if (typeof out[0] === 'string') return out[0];
  }
  return typeof out === 'string' ? out : '';
}

function htmlToText(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2019;/g, "'")
    .replace(/&#x201C;/g, '"')
    .replace(/&#x201D;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
