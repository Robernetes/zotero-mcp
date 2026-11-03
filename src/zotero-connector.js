// zotero-connector.js
// Guarda items en la biblioteca a través del servidor del conector de Zotero
// (http://127.0.0.1:23119/connector), el mismo que usa la extensión del
// navegador. Es una interfaz interna de Zotero: requiere Zotero abierto.
//
// Flujo de guardado (como "Importar" en Zotero):
//   1. POST /connector/import?session=ID  con CSL JSON (text/plain). Zotero lo
//      convierte con su traductor "CSL JSON" y guarda en la colección
//      seleccionada en ese momento.
//   2. POST /connector/updateSession  {sessionID, target, tags}  mueve el item
//      a la colección indicada y le pone las etiquetas.

export const CONNECTOR_API_VERSION = 3;
const USER_LIBRARY = 'L1';

export class ZoteroConnectorError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'ZoteroConnectorError';
    this.status = status;
  }
}

export class ZoteroConnector {
  /** @param {object} opts @param {string} opts.baseUrl URL del servidor de Zotero (p. ej. http://127.0.0.1:23119). */
  constructor({ baseUrl = 'http://127.0.0.1:23119', timeoutMs = 20000 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  /** URL base del conector a partir de ZOTERO_API_URL (http://host:puerto/api → http://host:puerto). */
  static fromApiUrl(apiUrl, opts = {}) {
    return new ZoteroConnector({ ...opts, baseUrl: new URL(apiUrl).origin });
  }

  /**
   * Destinos de guardado de la biblioteca personal y el seleccionado en Zotero.
   * @returns {Promise<{selected: {id: string, name: string}, library: {id: string, name: string}, targets: Array<{id: string, name: string, level: number}>}>}
   *   id: "L<n>" (biblioteca) o "C<n>" (colección); targets en orden de árbol.
   */
  async getSaveTargets() {
    const data = await this._post('/connector/getSelectedCollection', { json: {} });
    const all = Array.isArray(data.targets) ? data.targets : [];
    // Solo la biblioteca personal (libraryID 1, la de la API local users/0):
    // desde su "L1" hasta la siguiente biblioteca (grupos).
    const from = all.findIndex((t) => t.id === USER_LIBRARY);
    const targets = [];
    for (let i = from; i >= 0 && i < all.length; i++) {
      if (i > from && all[i].level === 0) break;
      targets.push({ id: all[i].id, name: all[i].name, level: all[i].level });
    }
    const library = targets[0] || { id: USER_LIBRARY, name: 'My Library' };
    // Si en Zotero está seleccionada una biblioteca de grupo, se usa la raíz de la personal.
    const selected =
      data.libraryID === 1 && data.id != null ? { id: `C${data.id}`, name: data.name } : { id: library.id, name: library.name };
    return { selected, library: { id: library.id, name: library.name }, targets };
  }

  /**
   * Importa items CSL JSON. Devuelve el JSON de los items guardados (con key si Zotero la incluye).
   * @param {object[]} cslItems
   * @param {string} sessionID
   */
  async importCsl(cslItems, sessionID) {
    const body = JSON.stringify(cslItems);
    const data = await this._post(`/connector/import?session=${encodeURIComponent(sessionID)}`, { text: body });
    return Array.isArray(data) ? data : [];
  }

  /** Mueve los items de la sesión al destino (id "C<n>"/"L<n>") y les pone etiquetas. */
  async updateSession(sessionID, target, tags = []) {
    await this._post('/connector/updateSession', { json: { sessionID, target, tags } });
  }

  async _post(path, { json, text }) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': json !== undefined ? 'application/json' : 'text/plain',
          'X-Zotero-Connector-API-Version': String(CONNECTOR_API_VERSION),
        },
        body: json !== undefined ? JSON.stringify(json) : text,
      });
    } catch (err) {
      const reason = err && err.name === 'AbortError' ? 'la petición superó el tiempo de espera' : `error de conexión: ${err && err.message ? err.message : err}`;
      throw new ZoteroConnectorError(`No se pudo conectar con Zotero (${url}): ${reason}. Verifica que Zotero esté abierto.`);
    } finally {
      clearTimeout(timer);
    }
    const raw = await res.text();
    if (!res.ok) {
      let code = '';
      try {
        code = JSON.parse(raw).error || '';
      } catch {
        // cuerpo no JSON
      }
      const hint =
        path.startsWith('/connector/import') && res.status === 400
          ? ': Zotero no reconoció los datos del item'
          : res.status === 500
            ? ': error interno de Zotero (¿biblioteca de solo lectura?)'
            : '';
      throw new ZoteroConnectorError(`Zotero respondió HTTP ${res.status}${code ? ` (${code})` : ''} en ${path.split('?')[0]}${hint}.`, { status: res.status });
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

/**
 * Ruta de nombres de una colección de la API local (["Tesis", "Capítulo 1"]).
 * @param {string} key
 * @param {Array<{key: string, name: string, parentKey: string|null}>} collections
 */
export function collectionPath(key, collections) {
  const byKey = new Map(collections.map((c) => [c.key, c]));
  const path = [];
  const seen = new Set();
  for (let c = byKey.get(key); c && !seen.has(c.key); c = c.parentKey ? byKey.get(c.parentKey) : null) {
    seen.add(c.key);
    path.unshift(c.name);
  }
  return path;
}

/**
 * Busca en los destinos del conector (en orden de árbol, con nivel) la
 * colección cuya ruta de nombres coincide.
 * @returns {Array<{id: string, name: string}>} Coincidencias (vacío o más de una si hay nombres repetidos).
 */
export function findTargetByPath(targets, path) {
  const matches = [];
  const stack = [];
  for (const t of targets) {
    if (t.level === 0) {
      stack.length = 0;
      continue;
    }
    stack.length = t.level - 1;
    stack.push(t.name);
    if (stack.length === path.length && stack.every((n, i) => n === path[i])) matches.push({ id: t.id, name: t.name });
  }
  return matches;
}
