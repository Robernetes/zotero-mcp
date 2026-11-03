// app.js
// Construye el servidor MCP con todas las herramientas registradas.
// Separado de server.js (que solo arranca el transporte stdio) para poder
// probar el servidor completo en memoria.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createContext } from './context.js';
import { registerLibraryTools } from './tools/library.js';
import { registerCitationTools } from './tools/citations.js';
import { registerWordTools } from './tools/word.js';
import { registerExternalTools } from './tools/external.js';

export const SERVER_INFO = { name: 'zotero-mcp', version: '0.1.0' };

/**
 * @param {import('./context.js').ToolContext} [ctx] Clientes y configuración (por defecto, de las variables de entorno).
 * @returns {McpServer}
 */
export function createServer(ctx = createContext()) {
  const server = new McpServer(SERVER_INFO);
  registerLibraryTools(server, ctx); // zotero_status, zotero_search, zotero_get_item, zotero_list_collections
  registerCitationTools(server, ctx); // zotero_cite, zotero_bibliography (Markdown)
  registerWordTools(server, ctx); // zotero_read_docx, zotero_insert_citation_docx, zotero_update_bibliography_docx
  registerExternalTools(server, ctx); // zotero_find_external, zotero_add_item
  return server;
}
