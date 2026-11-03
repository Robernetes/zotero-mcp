// context.js
// Configuración (variables de entorno) y clientes compartidos por las herramientas.

import { ZoteroClient } from './zotero-client.js';
import { ExternalSearch } from './external-search.js';
import { ZoteroConnector } from './zotero-connector.js';
import { CitationManager } from './cite.js';
import { envFlag } from './file-io.js';

/**
 * @typedef {object} ToolContext
 * @property {{apiUrl: string, defaultStyle: string, defaultLocale: string, backup: boolean}} config
 * @property {ZoteroClient} zotero                 API local de Zotero (lectura).
 * @property {ZoteroConnector} zoteroConnector     Servidor del conector (guardar items).
 * @property {ExternalSearch} externalSearch       OpenAlex / Crossref.
 * @property {CitationManager} citationManager     Motor de citas y registro en memoria.
 */

/** Lee la configuración de las variables de entorno. */
export function loadConfig(env = process.env) {
  return {
    apiUrl: (env.ZOTERO_API_URL || 'http://127.0.0.1:23119/api').trim(),
    defaultStyle: (env.ZOTERO_DEFAULT_STYLE || 'apa').trim(),
    defaultLocale: (env.ZOTERO_LOCALE || 'es-ES').trim(),
    // Copia <archivo>.bak antes de sobrescribir un documento (default: sí).
    backup: envFlag(env.ZOTERO_MCP_BACKUP, true),
    // Búsqueda externa: OPENALEX_API_KEY (opcional) da cuota propia en OpenAlex;
    // ZOTERO_MCP_CONTACT_EMAIL (opcional) se envía a OpenAlex/Crossref como contacto.
    openAlexKey: env.OPENALEX_API_KEY,
    contactEmail: env.ZOTERO_MCP_CONTACT_EMAIL,
  };
}

/**
 * Crea los clientes a partir de la configuración.
 * @returns {ToolContext}
 */
export function createContext(config = loadConfig()) {
  const zotero = new ZoteroClient({ baseUrl: config.apiUrl });
  return {
    config,
    zotero,
    // Guardado de items: servidor del conector de Zotero (mismo host y puerto que la API local).
    zoteroConnector: ZoteroConnector.fromApiUrl(config.apiUrl),
    externalSearch: new ExternalSearch({ openAlexKey: config.openAlexKey, contactEmail: config.contactEmail }),
    citationManager: new CitationManager({ fetchItems: async (keys) => zotero.getByKeys(keys) }),
  };
}
