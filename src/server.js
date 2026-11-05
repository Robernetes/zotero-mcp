// server.js
// Punto de entrada del servidor MCP de Zotero (transporte stdio).
//
// API local de Zotero de solo lectura; zotero_add_item guarda a través del
// conector de Zotero, solo con apply:true. Las herramientas están en src/tools/:
//   library.js   zotero_status, zotero_search, zotero_get_item, zotero_list_collections
//   citations.js zotero_cite, zotero_bibliography (Markdown)
//   word.js      zotero_read_docx, zotero_insert_citation_docx, zotero_remove_citations_docx, zotero_update_bibliography_docx
//   external.js  zotero_find_external (OpenAlex / Crossref), zotero_add_item

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './app.js';

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`[zotero-mcp] Error fatal al iniciar: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
