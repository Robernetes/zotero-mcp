// server.js
// Servidor MCP de Zotero (API local, solo lectura).
// Herramientas: zotero_status, zotero_search, zotero_get_item,
// zotero_list_collections, zotero_cite, zotero_bibliography.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ZoteroClient } from './zotero-client.js';
import { CitationManager, AVAILABLE_STYLES, FORMATS, LOCALES } from './cite.js';
import { extractBibliographySection, updateBibliographySection } from './bib-section.js';

const env = process.env;
const API_URL = (env.ZOTERO_API_URL || 'http://127.0.0.1:23119/api').trim();
const DEFAULT_STYLE = (env.ZOTERO_DEFAULT_STYLE || 'apa').trim();
const DEFAULT_LOCALE = (env.ZOTERO_LOCALE || 'es-ES').trim();
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

const zotero = new ZoteroClient({ baseUrl: API_URL });

const citationManager = new CitationManager({
  fetchItems: async (keys) => zotero.getByKeys(keys),
});

const server = new McpServer({ name: 'zotero-mcp', version: '0.1.0' });

/** Convierte un error a una respuesta MCP de error. */
function fail(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** Ejecuta un handler con captura de errores uniforme. */
async function run(handler) {
  try {
    return await handler();
  } catch (err) {
    return fail(err && err.message ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// 1. zotero_status
// ---------------------------------------------------------------------------
server.tool(
  'zotero_status',
  'Verifica la conexión con la API local de Zotero (puerto 23119). Úsala primero para diagnosticar si Zotero está disponible.',
  {},
  async () => run(async () => {
    const status = await zotero.status();
    return ok(status);
  })
);

// ---------------------------------------------------------------------------
// 2. zotero_search
// ---------------------------------------------------------------------------
server.tool(
  'zotero_search',
  'Busca items en la biblioteca local de Zotero. Devuelve key, tipo, título, autores, año, DOI/URL.',
  {
    query: z.string().optional().describe('Texto de búsqueda. Vacío = listar items.'),
    qmode: z.enum(['titleCreatorYear', 'everything']).optional().describe('Modo de búsqueda (default titleCreatorYear).'),
    itemType: z.string().optional().describe('Filtro por tipo (journalArticle, book, thesis, conferencePaper, ...).'),
    collectionKey: z.string().optional().describe('Filtro por colección (consúltala con zotero_list_collections).'),
    limit: z.number().int().min(1).max(50).optional().describe('Máximo de resultados (default 10, máx 50).'),
    sort: z.string().optional().describe('Campo de orden (title, date, dateAdded, dateModified, creator, ...).'),
    direction: z.enum(['asc', 'desc']).optional().describe('Dirección del orden.'),
  },
  async (args) => run(async () => {
    const items = await zotero.search(args);
    return ok({ query: args.query ?? null, count: items.length, items });
  })
);

// ---------------------------------------------------------------------------
// 3. zotero_get_item
// ---------------------------------------------------------------------------
server.tool(
  'zotero_get_item',
  'Devuelve el detalle completo de un item de Zotero por su key.',
  { key: z.string().min(1).describe('Key del item en Zotero.') },
  async (args) => run(async () => {
    const item = await zotero.getItem(args.key);
    return ok({ key: args.key, item });
  })
);

// ---------------------------------------------------------------------------
// 4. zotero_list_collections
// ---------------------------------------------------------------------------
server.tool(
  'zotero_list_collections',
  'Lista las colecciones de la biblioteca local de Zotero (key + nombre).',
  {},
  async () => run(async () => {
    const collections = await zotero.listCollections();
    return ok({ count: collections.length, collections });
  })
);

// ---------------------------------------------------------------------------
// 5. zotero_cite
// ---------------------------------------------------------------------------
server.tool(
  'zotero_cite',
  'Genera una cita textual para un item de Zotero en el estilo indicado (APA, MLA, Chicago, Harvard, IEEE, Vancouver). ' +
    'La cita se registra para que la bibliografía se actualice automáticamente. Usa el mismo style y locale en todo el documento.',
  {
    key: z.string().min(1).describe('Key del item de Zotero.'),
    style: z.string().optional().describe(`Estilo CSL. Default: ${DEFAULT_STYLE}. Disponibles: ${AVAILABLE_STYLES.join(', ')}.`),
    locale: z.string().optional().describe(`Idioma del estilo. Default: ${DEFAULT_LOCALE}. Disponibles: ${LOCALES.join(', ')}.`),
    locator: z.string().optional().describe('Localizador, p. ej. "15" para página 15.'),
    label: z.string().optional().describe('Etiqueta del localizador: page, chapter, section, figure, volume, ...'),
    prefix: z.string().optional().describe('Texto antes de la cita.'),
    suffix: z.string().optional().describe('Texto después de la cita.'),
    register: z.boolean().optional().describe('Registrar la cita para la bibliografía automática (default true).'),
  },
  async (args) => run(async () => {
    const result = await citationManager.cite({
      key: args.key,
      style: args.style || DEFAULT_STYLE,
      locale: args.locale || DEFAULT_LOCALE,
      locator: args.locator,
      label: args.label,
      prefix: args.prefix,
      suffix: args.suffix,
      register: args.register !== false,
    });
    return ok(result);
  })
);

// ---------------------------------------------------------------------------
// 6. zotero_bibliography
// ---------------------------------------------------------------------------
server.tool(
  'zotero_bibliography',
  'Genera la bibliografía (lista de referencias) desde el registro de citas o desde keys explícitas. ' +
    'Con filePath y apply:true actualiza la sección de referencias de un documento Markdown, de modo que la bibliografía se renueva sola al añadir citas.',
  {
    keys: z.array(z.string()).optional().describe('Keys de Zotero. Si se omite, usa las citas registradas con zotero_cite.'),
    style: z.string().optional().describe(`Estilo CSL. Default: ${DEFAULT_STYLE}.`),
    locale: z.string().optional().describe(`Idioma. Default: ${DEFAULT_LOCALE}.`),
    format: z.enum(FORMATS).optional().describe('Formato de salida (default markdown).'),
    filePath: z.string().optional().describe('Ruta de un archivo .md/.markdown cuya sección de referencias se actualizará.'),
    dryRun: z.boolean().optional().describe('Solo mostrar el diff sin escribir (default true).'),
    apply: z.boolean().optional().describe('Escribir el archivo (requiere filePath; default false).'),
    createSection: z.boolean().optional().describe('Si el documento no tiene sección de referencias, crearla al final (default false).'),
  },
  async (args) => run(async () => {
    const style = args.style || DEFAULT_STYLE;
    const locale = args.locale || DEFAULT_LOCALE;
    const format = args.format || 'markdown';

    const bib = await citationManager.bibliography({
      style,
      locale,
      keys: args.keys,
      format,
    });

    if (!args.filePath) {
      return ok({ ...bib, style, locale });
    }

    const filePath = args.filePath;
    const ext = path.extname(filePath).toLowerCase();
    if (!['.md', '.markdown'].includes(ext)) {
      return fail(
        `filePath debe ser un archivo .md o .markdown (se recibió "${ext || '(sin extensión)'}"). ` +
          'La actualización de documentos Word (.docx) no está soportada en v1.'
      );
    }
    const abs = path.resolve(filePath);
    if (!existsSync(abs)) return fail(`El archivo no existe: ${abs}`);
    const st = statSync(abs);
    if (!st.isFile()) return fail(`La ruta no es un archivo: ${abs}`);
    if (st.size > MAX_FILE_BYTES) return fail('El archivo supera el límite de 2 MB; no se modifica.');

    const original = readFileSync(abs, 'utf8');
    const oldSection = extractBibliographySection(original);
    const result = updateBibliographySection(original, bib.bibliography, {
      createSection: args.createSection === true,
    });

    if (!result.applied) {
      return fail(
        `${result.reason || 'No se encontró una sección de referencias.'} Pasa createSection: true para crearla al final del documento.`
      );
    }

    const payload = {
      ...bib,
      style,
      locale,
      filePath: abs,
      sectionFound: result.sectionFound,
      heading: result.heading,
      apply: args.apply === true,
      dryRun: args.apply !== true,
      oldSection: oldSection || '',
      diff: result.text === original ? null : simpleDiff(oldSection || '', bib.bibliography),
    };

    if (args.apply === true && result.text !== original) {
      writeFileSync(abs, result.text, 'utf8');
      payload.written = true;
    }

    return ok(payload);
  })
);

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(`[zotero-mcp] Error fatal al iniciar: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

/** Diff simplificado: primeras líneas añadidas/removidas. */
function simpleDiff(oldText, newText) {
  const oldLines = oldText.split('\n').filter((l) => l.trim());
  const newLines = newText.split('\n').filter((l) => l.trim());
  return {
    added: newLines.filter((l) => !oldLines.includes(l)).slice(0, 10),
    removed: oldLines.filter((l) => !newLines.includes(l)).slice(0, 10),
  };
}
