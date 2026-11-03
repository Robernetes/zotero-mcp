// context.js
// Configuración (variables de entorno) y clientes compartidos por las herramientas.

import { ZoteroClient } from './zotero-client.js';
import { ExternalSearch } from './external-search.js';
import { ZoteroConnector } from './zotero-connector.js';
import { CitationManager } from './cite.js';
import { envFlag } from './file-io.js';
import { Workspace, parseAllowedDirs } from './workspace.js';

/**
 * @typedef {object} ToolContext
 * @property {{apiUrl: string, defaultStyle: string, defaultLocale: string, backup: boolean}} config
 * @property {ZoteroClient} zotero                 API local de Zotero (lectura).
 * @property {ZoteroConnector} zoteroConnector     Servidor del conector (guardar items).
 * @property {ExternalSearch} externalSearch       OpenAlex / Crossref.
 * @property {CitationManager} citationManager     Motor de citas y registro en memoria.
 * @property {Workspace} workspace                 Carpetas donde se pueden leer y escribir documentos.
 */

/**
 * Valor de una variable de entorno, o undefined si está vacía o llega como un
 * "${VAR}" sin expandir (p. ej. si se copia mcp_config.json a un cliente que no
 * expande variables): así se usa el valor por defecto en lugar del texto literal.
 */
export function envValue(value) {
  const s = value == null ? '' : String(value).trim();
  return s && !/^\$\{[^}]*\}$/.test(s) ? s : undefined;
}

/** Lee la configuración de las variables de entorno. */
export function loadConfig(env = process.env) {
  const get = (name) => envValue(env[name]);
  return {
    apiUrl: get('ZOTERO_API_URL') || 'http://127.0.0.1:23119/api',
    defaultStyle: get('ZOTERO_DEFAULT_STYLE') || 'apa',
    defaultLocale: get('ZOTERO_LOCALE') || 'es-ES',
    // Copia <archivo>.bak antes de sobrescribir un documento (default: sí).
    backup: envFlag(get('ZOTERO_MCP_BACKUP'), true),
    // Carpetas donde se pueden leer y escribir documentos; si no se indican, las
    // carpetas de trabajo del cliente MCP (roots) o la carpeta de arranque.
    allowedDirs: parseAllowedDirs(get('ZOTERO_MCP_ALLOWED_DIRS')),
    // Búsqueda externa: OPENALEX_API_KEY (opcional) da cuota propia en OpenAlex;
    // ZOTERO_MCP_CONTACT_EMAIL (opcional) se envía a OpenAlex/Crossref como contacto.
    openAlexKey: get('OPENALEX_API_KEY'),
    contactEmail: get('ZOTERO_MCP_CONTACT_EMAIL'),
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
    workspace: new Workspace({ allowedDirs: config.allowedDirs || [] }),
  };
}
