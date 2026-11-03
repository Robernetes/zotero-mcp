// external-search.js
// Búsqueda de publicaciones fuera de la biblioteca de Zotero, en fuentes
// abiertas: OpenAlex (https://openalex.org) y Crossref (https://crossref.org).
// Solo lectura: no guarda nada en Zotero.

import { normalizeDoi } from './zotero-client.js';

export const SOURCES = ['auto', 'openalex', 'crossref'];
export const OPENALEX_URL = 'https://api.openalex.org';
export const CROSSREF_URL = 'https://api.crossref.org';
const USER_AGENT = 'zotero-mcp/0.1.0 (https://github.com/Robernetes/zotero-mcp)';
const MAX_AUTHORS = 10;
const ABSTRACT_CHARS = 600;

export class ExternalSearchError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'ExternalSearchError';
    this.status = status;
  }
}

export class ExternalSearch {
  /**
   * @param {object} [opts]
   * @param {string} [opts.openAlexKey] API key de OpenAlex (opcional; sin ella se usa la cuota gratuita compartida por IP).
   * @param {string} [opts.contactEmail] Correo de contacto para el "polite pool" de OpenAlex y Crossref (opcional).
   */
  constructor({ openAlexKey, contactEmail, timeoutMs = 15000, openAlexUrl = OPENALEX_URL, crossrefUrl = CROSSREF_URL } = {}) {
    this.openAlexKey = configValue(openAlexKey);
    const email = configValue(contactEmail);
    this.contactEmail = /^[^\s@]+@[^\s@]+$/.test(email) ? email : '';
    this.timeoutMs = timeoutMs;
    this.openAlexUrl = openAlexUrl.replace(/\/+$/, '');
    this.crossrefUrl = crossrefUrl.replace(/\/+$/, '');
  }

  /**
   * Busca publicaciones por texto libre (título, autores, tema).
   * Con source 'auto' usa OpenAlex y, si falla (cuota agotada, red), Crossref.
   * @returns {Promise<{source: string, total: number|null, results: object[], warnings: string[]}>}
   */
  async search({ query, source = 'auto', limit = 10, yearFrom, yearTo, includeAbstract = false } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new ExternalSearchError('Indica el texto a buscar.');
    const opts = { query: q, limit: clampInt(limit, 1, 25, 10), yearFrom, yearTo, includeAbstract };
    if (source === 'openalex') return { ...(await this._searchOpenAlex(opts)), warnings: [] };
    if (source === 'crossref') return { ...(await this._searchCrossref(opts)), warnings: [] };
    try {
      return { ...(await this._searchOpenAlex(opts)), warnings: [] };
    } catch (err) {
      const res = await this._searchCrossref(opts);
      return { ...res, warnings: [`OpenAlex no respondió (${err.message}); resultados de Crossref.`] };
    }
  }

  /** Busca una publicación por DOI: Crossref y, si no la tiene (p. ej. DOI de DataCite), OpenAlex. */
  async lookupDoi(doi, { includeAbstract = false } = {}) {
    const clean = normalizeDoi(doi);
    if (!clean) throw new ExternalSearchError(`"${doi}" no parece un DOI (formato 10.xxxx/...).`);
    let crossrefError;
    try {
      const data = await this._getJSON(`${this.crossrefUrl}/works/${encodeURIComponent(clean)}${this._crossrefQuery()}`, 'Crossref');
      return { source: 'crossref', result: fromCrossref(data.message, { includeAbstract }) };
    } catch (err) {
      crossrefError = err;
    }
    try {
      const data = await this._getJSON(`${this.openAlexUrl}/works/doi:${encodeURIComponent(clean)}${this._openAlexQuery()}`, 'OpenAlex');
      return { source: 'openalex', result: fromOpenAlex(data, { includeAbstract }) };
    } catch (err) {
      if (crossrefError.status === 404 && err.status === 404) {
        throw new ExternalSearchError(`No se encontró el DOI ${clean} en Crossref ni en OpenAlex.`, { status: 404 });
      }
      throw new ExternalSearchError(`No se pudo consultar el DOI ${clean}: Crossref (${crossrefError.message}); OpenAlex (${err.message}).`);
    }
  }

  async _searchOpenAlex({ query, limit, yearFrom, yearTo, includeAbstract }) {
    const params = new URLSearchParams();
    params.set('search', query);
    params.set('per-page', String(limit));
    const filters = [];
    if (yearFrom) filters.push(`from_publication_date:${yearFrom}-01-01`);
    if (yearTo) filters.push(`to_publication_date:${yearTo}-12-31`);
    if (filters.length) params.set('filter', filters.join(','));
    const fields = ['id', 'doi', 'display_name', 'publication_year', 'type', 'authorships', 'primary_location', 'open_access', 'cited_by_count'];
    if (includeAbstract) fields.push('abstract_inverted_index');
    params.set('select', fields.join(','));
    const data = await this._getJSON(`${this.openAlexUrl}/works?${params}${this._openAlexQuery('&')}`, 'OpenAlex');
    return {
      source: 'openalex',
      total: data.meta && data.meta.count != null ? data.meta.count : null,
      results: (data.results || []).map((w) => fromOpenAlex(w, { includeAbstract })),
    };
  }

  async _searchCrossref({ query, limit, yearFrom, yearTo, includeAbstract }) {
    const params = new URLSearchParams();
    params.set('query.bibliographic', query);
    params.set('rows', String(limit));
    const filters = [];
    if (yearFrom) filters.push(`from-pub-date:${yearFrom}`);
    if (yearTo) filters.push(`until-pub-date:${yearTo}`);
    if (filters.length) params.set('filter', filters.join(','));
    const fields = ['DOI', 'title', 'author', 'issued', 'type', 'container-title', 'publisher', 'URL', 'is-referenced-by-count', 'link', 'license'];
    if (includeAbstract) fields.push('abstract');
    params.set('select', fields.join(','));
    if (this.contactEmail) params.set('mailto', this.contactEmail);
    const data = await this._getJSON(`${this.crossrefUrl}/works?${params}`, 'Crossref');
    const msg = data.message || {};
    return {
      source: 'crossref',
      total: msg['total-results'] != null ? msg['total-results'] : null,
      results: (msg.items || []).map((w) => fromCrossref(w, { includeAbstract })),
    };
  }

  _openAlexQuery(sep = '?') {
    const params = new URLSearchParams();
    if (this.openAlexKey) params.set('api_key', this.openAlexKey);
    if (this.contactEmail) params.set('mailto', this.contactEmail);
    const s = params.toString();
    return s ? `${sep}${s}` : '';
  }

  _crossrefQuery() {
    return this.contactEmail ? `?mailto=${encodeURIComponent(this.contactEmail)}` : '';
  }

  async _getJSON(url, name) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const ua = this.contactEmail ? `${USER_AGENT.slice(0, -1)}; mailto:${this.contactEmail})` : USER_AGENT;
    let res;
    try {
      res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': ua } });
    } catch (err) {
      const reason = err && err.name === 'AbortError' ? 'tiempo de espera agotado' : `sin conexión: ${err && err.message ? err.message : err}`;
      throw new ExternalSearchError(`${name}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      if (res.status === 429) {
        detail += name === 'OpenAlex' && !this.openAlexKey
          ? ', cuota diaria gratuita agotada (configura OPENALEX_API_KEY)'
          : ', demasiadas peticiones';
      } else if (res.status === 404) {
        detail += ', no encontrado';
      }
      throw new ExternalSearchError(`${name}: ${detail}`, { status: res.status });
    }
    return res.json();
  }
}

/** Convierte un "work" de OpenAlex al formato de resultado común. */
export function fromOpenAlex(w, { includeAbstract = false } = {}) {
  const loc = w.primary_location || {};
  const src = loc.source || {};
  const authors = (w.authorships || []).map((a) => (a.author && a.author.display_name) || a.raw_author_name).filter(Boolean);
  const result = {
    title: cleanText(w.display_name || w.title),
    ...authorFields(authors),
    year: w.publication_year ?? null,
    type: w.type ?? null,
    venue: src.display_name ?? null,
    publisher: src.host_organization_name ?? null,
    doi: normalizeDoi(w.doi),
    url: loc.landing_page_url || (w.doi ? String(w.doi) : null) || w.id || null,
    openAccessUrl: (w.open_access && w.open_access.oa_url) || null,
    citedBy: w.cited_by_count ?? null,
    openAlexId: w.id ? String(w.id).replace(/^https?:\/\/openalex\.org\//, '') : null,
  };
  if (includeAbstract) result.abstract = truncate(abstractFromInvertedIndex(w.abstract_inverted_index));
  return result;
}

/** Convierte un "work" de Crossref al formato de resultado común. */
export function fromCrossref(w, { includeAbstract = false } = {}) {
  const authors = (w.author || [])
    .map((a) => a.name || [a.given, a.family].filter(Boolean).join(' '))
    .filter(Boolean);
  const year = firstYear(w.issued) ?? firstYear(w['published-print']) ?? firstYear(w['published-online']);
  const doi = normalizeDoi(w.DOI);
  const result = {
    title: cleanText(first(w.title)),
    ...authorFields(authors),
    year,
    type: w.type ?? null,
    venue: cleanText(first(w['container-title'])),
    publisher: w.publisher ?? null,
    doi,
    url: w.URL || (doi ? `https://doi.org/${doi}` : null),
    openAccessUrl: openAccessFromCrossref(w),
    citedBy: w['is-referenced-by-count'] ?? null,
  };
  if (includeAbstract) result.abstract = truncate(cleanText(w.abstract));
  return result;
}

function authorFields(authors) {
  const out = { authors: authors.slice(0, MAX_AUTHORS) };
  if (authors.length > MAX_AUTHORS) out.moreAuthors = authors.length - MAX_AUTHORS;
  return out;
}

function openAccessFromCrossref(w) {
  const open = (w.license || []).some((l) => /creativecommons\.org/i.test(l.URL || ''));
  if (!open) return null;
  const pdf = (w.link || []).find((l) => /pdf/i.test(l['content-type'] || ''));
  return (pdf && pdf.URL) || w.URL || null;
}

/** Reconstruye el resumen a partir del índice invertido de OpenAlex. */
export function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== 'object') return null;
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const p of positions) words[p] = word;
  }
  const text = words.filter((w) => w !== undefined).join(' ').trim();
  return text || null;
}

function first(v) {
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
}

function firstYear(date) {
  const y = date && date['date-parts'] && date['date-parts'][0] && date['date-parts'][0][0];
  return Number.isInteger(y) ? y : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Quita etiquetas (HTML, JATS) y entidades, y compacta los espacios. */
function cleanText(s) {
  if (s == null) return null;
  const text = String(s)
    .replace(/<jats:title>[^<]*<\/jats:title>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .trim();
  return text || null;
}

function truncate(s) {
  if (!s || s.length <= ABSTRACT_CHARS) return s;
  return `${s.slice(0, ABSTRACT_CHARS).replace(/\s+\S*$/, '')}…`;
}

/** Valor de configuración limpio; '' si está vacío o es un "${VAR}" sin expandir. */
function configValue(value) {
  const s = value == null ? '' : String(value).trim();
  return /^\$\{[^}]*\}$/.test(s) ? '' : s;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
