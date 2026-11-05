// app.js
// Construye el servidor MCP con todas las herramientas registradas.
// Separado de server.js (que solo arranca el transporte stdio) para poder
// probar el servidor completo en memoria.

import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createContext } from './context.js';
import { registerLibraryTools } from './tools/library.js';
import { registerCitationTools } from './tools/citations.js';
import { registerWordTools } from './tools/word.js';
import { registerExternalTools } from './tools/external.js';
import { NAME, VERSION } from './version.js';

export const SERVER_INFO = { name: NAME, version: VERSION };

/**
 * @param {import('./context.js').ToolContext} [ctx] Clientes y configuración (por defecto, de las variables de entorno).
 * @returns {McpServer}
 */
export function createServer(ctx = createContext()) {
  const server = new McpServer(SERVER_INFO);
  connectWorkspaceRoots(server, ctx.workspace);
  registerLibraryTools(server, ctx); // zotero_status, zotero_search, zotero_get_item, zotero_list_collections
  registerCitationTools(server, ctx); // zotero_cite, zotero_bibliography (Markdown)
  registerWordTools(server, ctx); // zotero_read_docx, zotero_insert_citation_docx, zotero_remove_citations_docx, zotero_update_bibliography_docx
  registerExternalTools(server, ctx); // zotero_find_external, zotero_add_item
  return server;
}

/**
 * Las carpetas permitidas salen de los roots del cliente MCP (sus carpetas de
 * trabajo) cuando no se configura ZOTERO_MCP_ALLOWED_DIRS. Se piden la primera
 * vez que hacen falta y se vuelven a pedir cuando el cliente avisa de un cambio.
 */
function connectWorkspaceRoots(server, workspace) {
  workspace.setRootsProvider(async () => {
    if (!server.server.getClientCapabilities()?.roots) return null;
    const { roots } = await server.server.listRoots();
    return roots.filter((r) => r.uri.startsWith('file:')).map((r) => fileURLToPath(r.uri));
  });
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => workspace.invalidate());
}
