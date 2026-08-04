// zotero-client.js
// Cliente de la API local de Zotero (http://127.0.0.1:23119/api).
// Solo lectura: nunca modifica la librería.

export const DEFAULT_BASE_URL = 'http://127.0.0.1:23119/api';

export class ZoteroError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZoteroError';
  }
}

export class ZoteroClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 8000 } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async _request(path, { timeoutMs } = {}) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      const reason =
        err && err.name === 'AbortError'
          ? 'la petición superó el tiempo de espera'
          : `error de conexión: ${err && err.message ? err.message : String(err)}`;
      throw new ZoteroError(
        `No se pudo conectar con la API local de Zotero (${url}). ${reason}. ` +
          'Verifica que Zotero esté abierto y que el ajuste "Allow other applications ' +
          'on this computer to communicate with Zotero" esté habilitado (Editar > Configuración > Avanzado).'
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new ZoteroError(`La API de Zotero respondió con HTTP ${res.status} para ${url}.`);
    }
    return res;
  }

  async _getJSON(path) {
    const res = await this._request(path);
    return res.json();
  }

  /** Verifica la conexión. Nunca lanza: devuelve { ok, ... } o { ok: false, error }. */
  async status() {
    try {
      await this._request('/users/0/items?limit=1');
      return { ok: true, baseUrl: this.baseUrl, library: 'local (users/0)' };
    } catch (err) {
      return { ok: false, error: err.message, baseUrl: this.baseUrl };
    }
  }

  /**
   * Busca items en la biblioteca local.
   * @param {object} opts
   * @param {string} [opts.query] Texto de búsqueda (vacío = listar).
   * @param {'titleCreatorYear'|'everything'} [opts.qmode]
   * @param {string} [opts.itemType] Filtro por tipo (journalArticle, book, ...).
   * @param {string} [opts.collectionKey] Filtro por colección.
   * @param {number} [opts.limit=10] Máx. 50.
   * @param {string} [opts.sort] Campo de orden (title, date, dateAdded, ...).
   * @param {'asc'|'desc'} [opts.direction]
   */
  async search({ query, qmode = 'titleCreatorYear', itemType, collectionKey, limit = 10, sort, direction } = {}) {
    const params = new URLSearchParams();
    if (query && String(query).trim()) {
      params.set('q', String(query).trim());
      params.set('qmode', qmode);
    }
    if (itemType) params.set('itemType', itemType);
    if (collectionKey) params.set('collection', collectionKey);
    params.set('limit', String(clampInt(limit, 1, 50, 10)));
    if (sort) params.set('sort', sort);
    if (direction) params.set('direction', direction);
    params.set('format', 'json');
    const data = await this._getJSON(`/users/0/items?${params.toString()}`);
    return Array.isArray(data) ? data.map(itemToSummary) : [];
  }

  /** Devuelve el item completo (JSON de la API) para una key. */
  async getItem(key) {
    const res = await this._request(`/users/0/items/${encodeURIComponent(key)}?format=json`);
    return res.json();
  }

  /**
   * Devuelve items en formato CSL JSON por lista de keys (máx. 100).
   * Los CSL JSON son la entrada directa del motor de citas (citeproc-js).
   */
  async getByKeys(keys) {
    const list = [...new Set((keys || []).filter((k) => k && String(k).trim()))].slice(0, 100);
    if (list.length === 0) return [];
    const params = new URLSearchParams();
    params.set('itemKey', list.join(','));
    params.set('format', 'csljson');
    const data = await this._getJSON(`/users/0/items?${params.toString()}`);
    if (!Array.isArray(data)) return [];
    // La API local devuelve CSL JSON con id = URI completa del item; citeproc-js
    // necesita la key corta como id.
    return data.map(normalizeCslId);
  }

  /** Lista las colecciones de la biblioteca local. */
  async listCollections() {
    const params = new URLSearchParams();
    params.set('format', 'json');
    params.set('limit', '100');
    const data = await this._getJSON(`/users/0/collections?${params.toString()}`);
    return Array.isArray(data)
      ? data.map((c) => {
          const d = c && c.data ? c.data : c || {};
          return {
            key: c.key,
            name: d.name || '(sin nombre)',
            numItems: d.numItems != null ? d.numItems : null,
          };
        })
      : [];
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Reduce el id CSL a la key corta de Zotero si viene como URI completa. */
function normalizeCslId(item) {
  if (item && typeof item.id === 'string') {
    const m = item.id.match(/\/items\/([A-Z0-9]{8})$/i);
    if (m) item.id = m[1];
  }
  return item;
}

function extractYear(date) {
  if (!date) return null;
  const m = String(date).match(/\b(1[0-9]{3}|2[0-9]{3})\b/);
  return m ? m[0] : null;
}

function formatCreator(c) {
  if (!c) return '(sin nombre)';
  if (c.name) return String(c.name);
  const parts = [c.firstName, c.lastName].filter((p) => p && String(p).trim());
  return parts.length > 0 ? parts.join(' ') : '(sin nombre)';
}

function itemToSummary(item) {
  if (!item || typeof item !== 'object') return null;
  const d = item.data && typeof item.data === 'object' ? item.data : item;
  const creators = Array.isArray(d.creators) ? d.creators : [];
  const authorNames = creators
    .filter((c) => !c.creatorType || ['author', 'editor', 'translator'].includes(c.creatorType))
    .map(formatCreator);
  return {
    key: item.key,
    itemType: d.itemType ?? null,
    title: d.title ?? null,
    creators: authorNames.slice(0, 10),
    date: d.date ?? null,
    year: extractYear(d.date),
    doi: d.DOI ?? null,
    url: d.url ?? null,
    publicationTitle: d.publicationTitle ?? null,
  };
}
