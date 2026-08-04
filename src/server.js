// server.js
// Servidor MCP de Zotero (API local, solo lectura).
// Herramientas: zotero_status, zotero_search, zotero_get_item,
// zotero_list_collections, zotero_cite, zotero_bibliography,
// zotero_read_docx, zotero_insert_citation_docx, zotero_update_bibliography_docx.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ZoteroClient } from './zotero-client.js';
import { CitationManager, AVAILABLE_STYLES, FORMATS, LOCALES } from './cite.js';
import { extractBibliographySection, updateBibliographySection } from './bib-section.js';
import {
  openDocx,
  saveDocx,
  readParagraphs,
  countExistingCitations,
  countMaxId,
  buildCitationRuns,
  insertCitationAtParagraph,
  upsertBibliography,
  hashCode,
  validateDocxPath,
} from './docx.js';

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
// 7. zotero_read_docx
// ---------------------------------------------------------------------------
server.tool(
  'zotero_read_docx',
  'Lee los párrafos de un documento Word (.docx). Usa esta herramienta primero para conocer la estructura del documento antes de insertar citas. Devuelve el índice, texto y si cada párrafo ya contiene campos Zotero.',
  {
    filePath: z.string().min(1).describe('Ruta del archivo .docx.'),
  },
  async (args) => run(async () => {
    const abs = validateDocxPath(args.filePath);
    const ctx = await openDocx(abs);
    const paragraphs = readParagraphs(ctx);
    return ok({ filePath: abs, count: paragraphs.length, paragraphs });
  })
);

// ---------------------------------------------------------------------------
// 8. zotero_insert_citation_docx
// ---------------------------------------------------------------------------
server.tool(
  'zotero_insert_citation_docx',
  'Inserta un campo de cita Zotero (ADDIN ZOTERO_ITEM CSL_CITATION) al final del párrafo indicado en un documento Word. La cita se renderizará correctamente al abrir el archivo en Word con el plugin de Zotero. Usa siempre el mismo style y locale en todo el documento.',
  {
    filePath: z.string().min(1).describe('Ruta del archivo .docx.'),
    key: z.string().min(1).describe('Key del item de Zotero.'),
    paragraphIndex: z.number().int().min(0).describe('Índice del párrafo donde insertar la cita (0‑based). Usa zotero_read_docx para ver los índices.'),
    style: z.string().optional().describe(`Estilo CSL. Default: ${DEFAULT_STYLE}.`),
    locale: z.string().optional().describe(`Idioma. Default: ${DEFAULT_LOCALE}.`),
    locator: z.string().optional().describe('Localizador (p. ej. "15").'),
    label: z.string().optional().describe('Etiqueta del localizador: page, chapter, section, figure, volume…'),
    prefix: z.string().optional().describe('Texto antes de la cita.'),
    suffix: z.string().optional().describe('Texto después de la cita.'),
    dryRun: z.boolean().optional().describe('Solo mostrar lo que se insertaría (default true).'),
    apply: z.boolean().optional().describe('Escribir el archivo (default false).'),
  },
  async (args) => run(async () => {
    const abs = validateDocxPath(args.filePath);
    const style = String(args.style || DEFAULT_STYLE).trim();
    const locale = String(args.locale || DEFAULT_LOCALE).trim();
    const key = String(args.key).trim();

    // Obtener el CSL JSON desde Zotero (con el id normalizado a key corta).
    const [cslItem] = await zotero.getByKeys([key]);
    if (!cslItem) {
      return fail(`No se encontró en Zotero un item con key "${key}". Verifícala con zotero_search.`);
    }

    // Generar el texto renderizado de la cita.
    const citeResult = await citationManager.cite({
      key,
      style,
      locale,
      locator: args.locator,
      label: args.label,
      prefix: args.prefix,
      suffix: args.suffix,
      register: false,
    });

    // Abrir el docx y calcular noteIndex.
    const ctx = await openDocx(abs);
    const existingCount = countExistingCitations(ctx);
    const noteIndex = existingCount + 1;
    const citationID = `CITE-${noteIndex}`;

    // Asignar un id numérico único al itemData (debe coincidir con citationItem.id).
    const maxId = countMaxId(ctx);
    const numId = maxId + 1;

    const itemData = { ...cslItem, id: numId };
    const uris = [`http://zotero.org/users/0/items/${key}`];

    const runs = buildCitationRuns({
      citationID,
      noteIndex,
      formattedCitation: citeResult.citation,
      plainCitation: citeResult.citation,
      uris,
      itemData,
      locator: args.locator,
      label: args.label,
      prefix: args.prefix,
      suffix: args.suffix,
    });

    insertCitationAtParagraph(ctx.doc, args.paragraphIndex, runs);

    const payload = {
      filePath: abs,
      key,
      paragraphIndex: args.paragraphIndex,
      citationID,
      noteIndex,
      style,
      locale,
      citation: citeResult.citation,
      apply: args.apply === true,
      dryRun: args.apply !== true,
    };

    if (args.apply === true) {
      await saveDocx(ctx, abs);
      payload.written = true;
    }

    return ok(payload);
  })
);

// ---------------------------------------------------------------------------
// 9. zotero_update_bibliography_docx
// ---------------------------------------------------------------------------
server.tool(
  'zotero_update_bibliography_docx',
  'Inserta o actualiza el campo de bibliografía Zotero (ADDIN ZOTERO_BIBL) en un documento Word, al final del documento. Las referencias se generan desde las citas registradas con zotero_insert_citation_docx. Al abrir el archivo en Word con el plugin de Zotero, la bibliografía se renderiza con el estilo configurado.',
  {
    filePath: z.string().min(1).describe('Ruta del archivo .docx.'),
    style: z.string().optional().describe(`Estilo CSL (para la URL del estilo en el campo BIBL). Default: ${DEFAULT_STYLE}.`),
    dryRun: z.boolean().optional().describe('Solo mostrar lo que cambiaría (default true).'),
    apply: z.boolean().optional().describe('Escribir el archivo (default false).'),
  },
  async (args) => run(async () => {
    const abs = validateDocxPath(args.filePath);
    const style = String(args.style || DEFAULT_STYLE).trim();
    const styleUrl = `http://www.zotero.org/styles/${style}`;

    // Generar la bibliografía desde el registro de citas.
    const bib = await citationManager.bibliography({
      style,
      locale: DEFAULT_LOCALE,
      format: 'plaintext',
    });

    const ctx = await openDocx(abs);
    const result = upsertBibliography(ctx.doc, styleUrl, bib.bibliography);

    const payload = {
      filePath: abs,
      style,
      styleUrl,
      entries: bib.count,
      ...result,
      apply: args.apply === true,
      dryRun: args.apply !== true,
    };
    if (bib.bibliography) payload.bibliography = bib.bibliography;

    if (args.apply === true) {
      await saveDocx(ctx, abs);
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
