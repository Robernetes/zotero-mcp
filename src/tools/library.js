// tools/library.js
// Lectura de la biblioteca local: zotero_status, zotero_search,
// zotero_get_item, zotero_list_collections.

import { z } from 'zod';
import { ok, run } from './shared.js';

/** @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server @param {import('../context.js').ToolContext} ctx */
export function registerLibraryTools(server, { zotero, workspace }) {
  // ---------------------------------------------------------------------------
  // zotero_status
  // ---------------------------------------------------------------------------
  server.registerTool(
    'zotero_status',
    {
      description:
        'Verifica la conexión con la API local de Zotero (puerto 23119). Úsala primero para diagnosticar si Zotero está disponible. ' +
        'Indica también en workspace las carpetas donde se pueden leer y escribir documentos .md/.docx.',
      inputSchema: {},
    },
    async () => run(async () => {
      const status = await zotero.status();
      return ok({ ...status, workspace: await workspace.describe() });
    })
  );

  // ---------------------------------------------------------------------------
  // zotero_search
  // ---------------------------------------------------------------------------
  server.registerTool(
    'zotero_search',
    {
      description: 'Busca items en la biblioteca local de Zotero. Devuelve key, tipo, título, autores, año, DOI/URL.',
      inputSchema: {
        query: z.string().optional().describe('Texto de búsqueda. Vacío = listar items.'),
        qmode: z.enum(['titleCreatorYear', 'everything']).optional().describe('Modo de búsqueda (default titleCreatorYear).'),
        itemType: z.string().optional().describe('Filtro por tipo (journalArticle, book, thesis, conferencePaper, ...).'),
        collectionKey: z.string().optional().describe('Filtro por colección (consúltala con zotero_list_collections).'),
        limit: z.number().int().min(1).max(50).optional().describe('Máximo de resultados (default 10, máx 50).'),
        sort: z.string().optional().describe('Campo de orden (title, date, dateAdded, dateModified, creator, ...).'),
        direction: z.enum(['asc', 'desc']).optional().describe('Dirección del orden.'),
      },
    },
    async (args) => run(async () => {
      const items = await zotero.search(args);
      return ok({ query: args.query ?? null, count: items.length, items });
    })
  );

  // ---------------------------------------------------------------------------
  // zotero_get_item
  // ---------------------------------------------------------------------------
  server.registerTool(
    'zotero_get_item',
    {
      description: 'Devuelve el detalle completo de un item de Zotero por su key.',
      inputSchema: { key: z.string().min(1).describe('Key del item en Zotero.') },
    },
    async (args) => run(async () => {
      const item = await zotero.getItem(args.key);
      return ok({ key: args.key, item });
    })
  );

  // ---------------------------------------------------------------------------
  // zotero_list_collections
  // ---------------------------------------------------------------------------
  server.registerTool(
    'zotero_list_collections',
    {
      description: 'Lista las colecciones de la biblioteca local de Zotero (key, nombre y parentKey de la colección padre).',
      inputSchema: {},
    },
    async () => run(async () => {
      const collections = await zotero.listCollections();
      return ok({ count: collections.length, collections });
    })
  );
}
