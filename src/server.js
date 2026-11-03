// server.js
// Servidor MCP de Zotero (API local de solo lectura; zotero_add_item guarda a
// través del conector de Zotero, solo con apply:true).
// Herramientas: zotero_status, zotero_search, zotero_get_item,
// zotero_list_collections, zotero_cite, zotero_bibliography,
// zotero_read_docx, zotero_insert_citation_docx, zotero_update_bibliography_docx,
// zotero_find_external (búsqueda fuera de la biblioteca: OpenAlex / Crossref),
// zotero_add_item (guardar en la biblioteca).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ZoteroClient } from './zotero-client.js';
import { ExternalSearch, SOURCES } from './external-search.js';
import { ZoteroConnector, collectionPath, findTargetByPath } from './zotero-connector.js';
import { envFlag, readFileForEdit, validateFilePath, withFileLock, writeFileAtomic } from './file-io.js';
import {
  CitationManager,
  AVAILABLE_STYLES,
  FORMATS,
  LOCALES,
  resolveStyleName,
  styleNameFromZoteroId,
  zoteroStyleId,
} from './cite.js';
import { countReferenceEntries, extractBibliographySection, updateBibliographySection } from './bib-section.js';
import {
  openDocx,
  saveDocx,
  readParagraphs,
  countMaxId,
  buildCitationRuns,
  insertCitationAtParagraph,
  upsertBibliography,
  listDocumentCitations,
  paragraphChildIndex,
  readDocumentPrefs,
  ensureDocumentPrefs,
  hasParagraphStyle,
  randomId,
  validateDocxPath,
} from './docx.js';

const env = process.env;
const API_URL = (env.ZOTERO_API_URL || 'http://127.0.0.1:23119/api').trim();
const DEFAULT_STYLE = (env.ZOTERO_DEFAULT_STYLE || 'apa').trim();
const DEFAULT_LOCALE = (env.ZOTERO_LOCALE || 'es-ES').trim();
// Copia <archivo>.bak antes de sobrescribir un documento (default: sí).
const BACKUP = envFlag(env.ZOTERO_MCP_BACKUP, true);

const zotero = new ZoteroClient({ baseUrl: API_URL });

// Guardado de items: servidor del conector de Zotero (mismo host y puerto que la API local).
const zoteroConnector = ZoteroConnector.fromApiUrl(API_URL);

// Búsqueda externa: OPENALEX_API_KEY (opcional) da cuota propia en OpenAlex;
// ZOTERO_MCP_CONTACT_EMAIL (opcional) se envía a OpenAlex/Crossref como contacto.
const externalSearch = new ExternalSearch({
  openAlexKey: env.OPENALEX_API_KEY,
  contactEmail: env.ZOTERO_MCP_CONTACT_EMAIL,
});

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

/**
 * Estilo y locale para un .docx: los indicados en la llamada; si no, los de las
 * preferencias de Zotero del documento (si el estilo está disponible); si no,
 * los valores por defecto. Avisa cuando Zotero vaya a usar otro estilo al refrescar.
 */
async function resolveDocxStyle(ctx, args) {
  const prefs = await readDocumentPrefs(ctx);
  const docStyleID = prefs && prefs.styleID;
  const docStyle = docStyleID ? styleNameFromZoteroId(docStyleID) : null;
  const warnings = [];
  let style;
  if (args.style) {
    style = resolveStyleName(args.style);
    if (docStyleID && docStyleID !== zoteroStyleId(style)) {
      warnings.push(
        `El documento está configurado en Zotero con el estilo ${docStyleID}; al pulsar Refresh en Word, Zotero usará ese estilo y no "${style}".`
      );
    }
  } else if (docStyle) {
    style = docStyle;
  } else {
    style = resolveStyleName(DEFAULT_STYLE);
    if (docStyleID) {
      warnings.push(
        `El documento usa el estilo ${docStyleID}, que zotero-mcp no incluye; el texto se genera en "${style}" y Zotero lo corregirá al pulsar Refresh.`
      );
    }
  }
  const locale = String(args.locale || (prefs && prefs.locale) || DEFAULT_LOCALE).trim();
  return { style, locale, prefs, warnings };
}

const CITATION_ITEM_FIELDS = ['locator', 'label', 'prefix', 'suffix'];

/**
 * Resuelve los datos CSL de las citas de un .docx (de listDocumentCitations):
 * usa el itemData incrustado en cada campo y, si falta, busca la key en Zotero.
 * El id de cada item es su key de Zotero (o `doc-<id>` si el campo no tiene URI).
 * @returns {Promise<{itemsById: Map<string, object>, clusters: Array<Array<object>>, unresolved: string[]}>}
 *   clusters: una lista de citationItems ({id, locator, …}) por cita, en orden.
 */
async function resolveDocumentCitations(citations) {
  const idOf = (i) => i.key || `doc-${i.itemData.id}`;
  const itemsById = new Map();
  for (const i of citations.flatMap((c) => c.items)) {
    const id = idOf(i);
    if (i.itemData && !itemsById.has(id)) itemsById.set(id, { ...i.itemData, id });
  }
  const toFetch = [
    ...new Set(citations.flatMap((c) => c.items).filter((i) => !itemsById.has(idOf(i))).map((i) => i.key)),
  ];
  for (const item of toFetch.length > 0 ? await zotero.getByKeys(toFetch) : []) {
    itemsById.set(String(item.id), item);
  }
  const unresolved = new Set();
  const clusters = citations.map((c) =>
    c.items.map((i) => {
      const ci = { id: idOf(i) };
      for (const f of CITATION_ITEM_FIELDS) if (i[f] != null) ci[f] = i[f];
      if (!itemsById.has(ci.id)) unresolved.add(i.key);
      return ci;
    })
  );
  return { itemsById, clusters, unresolved: [...unresolved] };
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
  'Lista las colecciones de la biblioteca local de Zotero (key, nombre y parentKey de la colección padre).',
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
    register: z.boolean().optional().describe('Registrar la cita para la bibliografía automática (default true). Con false solo devuelve el texto: el registro no cambia.'),
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
    force: z.boolean().optional().describe('Escribir aunque la nueva bibliografía tenga menos referencias que la sección actual (default false).'),
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

    const abs = validateFilePath(args.filePath, {
      extensions: ['.md', '.markdown'],
      hint: 'Para documentos Word (.docx) usa zotero_update_bibliography_docx.',
    });

    // Nunca reescribir la sección con una bibliografía vacía: suele significar
    // que el registro de citas en memoria se perdió (p. ej. el servidor se reinició).
    if (bib.count === 0) {
      return fail(
        'No hay referencias que escribir: el registro de citas está vacío (se pierde al reiniciar el servidor o al cambiar de style/locale). ' +
          'Cita de nuevo con zotero_cite o pasa las keys explícitas en `keys`. No se modificó el archivo.'
      );
    }

    return withFileLock(abs, async () => {
      const { data: original, fingerprint } = readFileForEdit(abs, 'utf8');
      const oldSection = extractBibliographySection(original);
      const oldEntries = countReferenceEntries(oldSection || '');
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
        oldEntries,
        newEntries: bib.count,
        // Diff del documento completo (no solo de la sección), para que el dryRun
        // muestre cualquier línea que se fuera a perder fuera de las referencias.
        diff: result.text === original ? null : simpleDiff(original, result.text),
      };

      // Una bibliografía con menos referencias que la actual probablemente viene de
      // un registro parcial; solo se escribe si se pide explícitamente con force.
      if (bib.count < oldEntries && args.force !== true) {
        payload.warning =
          `La nueva bibliografía tiene ${bib.count} referencias y la sección actual ${oldEntries}. ` +
          'Revisa el diff y repite con force: true si quieres reemplazarla.';
        if (args.apply === true) {
          return fail(`${payload.warning} No se modificó el archivo.`);
        }
      }

      if (args.apply === true && result.text !== original) {
        const { backupPath } = writeFileAtomic(abs, result.text, { expected: fingerprint, backup: BACKUP });
        payload.written = true;
        if (backupPath) payload.backupPath = backupPath;
      }

      return ok(payload);
    });
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
  'Inserta un campo de cita Zotero (ADDIN ZOTERO_ITEM CSL_CITATION) al final del párrafo indicado en un documento Word. El texto de la cita (numeración, desambiguación) se calcula con las citas que ya contiene el documento, no con las de zotero_cite. La cita se renderizará correctamente al abrir el archivo en Word con el plugin de Zotero. Usa siempre el mismo style y locale en todo el documento.',
  {
    filePath: z.string().min(1).describe('Ruta del archivo .docx.'),
    key: z.string().min(1).describe('Key del item de Zotero.'),
    paragraphIndex: z.number().int().min(0).describe('Índice del párrafo donde insertar la cita (0‑based). Usa zotero_read_docx para ver los índices.'),
    style: z.string().optional().describe(`Estilo CSL. Default: el configurado en el documento por Zotero, o ${DEFAULT_STYLE}.`),
    locale: z.string().optional().describe(`Idioma. Default: el configurado en el documento por Zotero, o ${DEFAULT_LOCALE}.`),
    locator: z.string().optional().describe('Localizador (p. ej. "15").'),
    label: z.string().optional().describe('Etiqueta del localizador: page, chapter, section, figure, volume…'),
    prefix: z.string().optional().describe('Texto antes de la cita.'),
    suffix: z.string().optional().describe('Texto después de la cita.'),
    dryRun: z.boolean().optional().describe('Solo mostrar lo que se insertaría (default true).'),
    apply: z.boolean().optional().describe('Escribir el archivo (default false).'),
  },
  async (args) => run(async () => {
    const abs = validateDocxPath(args.filePath);
    const key = String(args.key).trim();

    // Obtener el CSL JSON desde Zotero (con el id normalizado a key corta).
    const [cslItem] = await zotero.getByKeys([key]);
    if (!cslItem) {
      return fail(`No se encontró en Zotero un item con key "${key}". Verifícala con zotero_search.`);
    }

    // Abrir el docx (en exclusiva sobre el archivo hasta guardar).
    return withFileLock(abs, async () => {
      const ctx = await openDocx(abs);
      const insertAt = paragraphChildIndex(ctx.doc, args.paragraphIndex);
      if (insertAt < 0) {
        return fail(
          `No existe el párrafo ${args.paragraphIndex} (el documento tiene ${readParagraphs(ctx).length} párrafos). Usa zotero_read_docx para ver la estructura.`
        );
      }
      const { style, locale, warnings } = await resolveDocxStyle(ctx, args);

      // El texto de la cita se calcula con las citas que ya contiene el documento
      // (antes y después del párrafo), no con el registro en memoria del servidor:
      // así la numeración y la desambiguación ("2020a") son las del documento.
      const citations = listDocumentCitations(ctx.doc);
      const resolved = await resolveDocumentCitations(citations);
      resolved.itemsById.set(key, cslItem); // datos recién obtenidos de Zotero
      const before = [];
      const after = [];
      citations.forEach((c, i) => {
        const cluster = resolved.clusters[i].filter((ci) => resolved.itemsById.has(ci.id));
        if (cluster.length > 0) (c.startChild <= insertAt ? before : after).push(cluster);
      });
      const citeResult = citationManager.renderCitation({
        style,
        locale,
        items: [...resolved.itemsById.values()],
        before,
        citationItems: [
          { id: key, locator: args.locator, label: args.label, prefix: args.prefix, suffix: args.suffix },
        ],
        after,
      });

      // Como el plugin de Zotero: citationID aleatorio y noteIndex 0 (los estilos
      // disponibles citan en el texto; Zotero recalcula noteIndex al refrescar).
      const citationID = randomId(8);
      const noteIndex = 0;

      // Asignar un id numérico único al itemData (debe coincidir con citationItem.id).
      const numId = countMaxId(ctx) + 1;

      // itemData sin la URI (zoteroURI no es enumerable); la URI va en `uris`.
      // Zotero enlaza la cita con el item de la biblioteca a partir de esa URI.
      const itemData = { ...cslItem, id: numId };
      const uris = [cslItem.zoteroURI || `http://zotero.org/users/0/items/${key}`];

      const { created: prefsCreated } = await ensureDocumentPrefs(ctx, { styleID: zoteroStyleId(style), locale });

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
        citationsInDocument: citations.length,
        documentPrefs: prefsCreated ? 'creadas' : 'existentes',
        apply: args.apply === true,
        dryRun: args.apply !== true,
      };
      if (resolved.unresolved.length > 0) {
        warnings.push(
          `Algunas citas del documento no se pudieron resolver (${resolved.unresolved.join(', ')}) y no se tuvieron en cuenta para numerar o desambiguar esta cita; el plugin de Zotero la corregirá al refrescar.`
        );
      }
      if (warnings.length > 0) payload.warnings = warnings;

      if (args.apply === true) {
        const { backupPath } = await saveDocx(ctx, abs, { backup: BACKUP });
        payload.written = true;
        if (backupPath) payload.backupPath = backupPath;
      }

      return ok(payload);
    });
  })
);

// ---------------------------------------------------------------------------
// 9. zotero_update_bibliography_docx
// ---------------------------------------------------------------------------
server.tool(
  'zotero_update_bibliography_docx',
  'Inserta o actualiza el campo de bibliografía Zotero (ADDIN ZOTERO_BIBL) en un documento Word, al final del documento. Las referencias se generan desde los campos de cita Zotero que ya contiene el propio documento (los insertados con zotero_insert_citation_docx o con el plugin de Word). Al abrir el archivo en Word con el plugin de Zotero, la bibliografía se renderiza con el estilo configurado.',
  {
    filePath: z.string().min(1).describe('Ruta del archivo .docx.'),
    style: z.string().optional().describe(`Estilo CSL. Default: el configurado en el documento por Zotero, o ${DEFAULT_STYLE}.`),
    locale: z.string().optional().describe(`Idioma. Default: el configurado en el documento por Zotero, o ${DEFAULT_LOCALE}.`),
    dryRun: z.boolean().optional().describe('Solo mostrar lo que cambiaría (default true).'),
    apply: z.boolean().optional().describe('Escribir el archivo (default false).'),
  },
  async (args) => run(async () => {
    const abs = validateDocxPath(args.filePath);

    return withFileLock(abs, async () => {
      const ctx = await openDocx(abs);
      const { style, locale, warnings } = await resolveDocxStyle(ctx, args);

      // Las referencias salen de las citas Zotero del propio documento: se usa el
      // itemData incrustado en cada campo y, si falta, se busca la key en Zotero.
      const citations = listDocumentCitations(ctx.doc);
      if (citations.length === 0) {
        return fail(
          'El documento no contiene citas de Zotero. Inserta citas con zotero_insert_citation_docx antes de generar la bibliografía.'
        );
      }
      const resolved = await resolveDocumentCitations(citations);
      if (resolved.unresolved.length > 0) {
        return fail(
          `No se pudieron resolver en Zotero las citas del documento con key: ${resolved.unresolved.join(', ')}.`
        );
      }
      const items = resolved.clusters.flat().map((ci) => resolved.itemsById.get(ci.id));

      const bib = await citationManager.bibliography({
        style,
        locale,
        items,
        format: 'plaintext',
      });

      // Un párrafo por referencia, con el estilo "Bibliography" si el documento ya
      // lo tiene (si no, Zotero lo crea y aplica la sangría al pulsar Refresh).
      const pStyle = (await hasParagraphStyle(ctx, 'Bibliography')) ? 'Bibliography' : undefined;
      const result = upsertBibliography(ctx.doc, bib.entries, { pStyle });
      const { created: prefsCreated } = await ensureDocumentPrefs(ctx, { styleID: zoteroStyleId(style), locale });

      const payload = {
        filePath: abs,
        style,
        locale,
        styleID: zoteroStyleId(style),
        citationsInDocument: citations.length,
        entries: bib.count,
        ...result,
        documentPrefs: prefsCreated ? 'creadas' : 'existentes',
        apply: args.apply === true,
        dryRun: args.apply !== true,
      };
      if (bib.bibliography) payload.bibliography = bib.bibliography;
      if (warnings.length > 0) payload.warnings = warnings;

      if (args.apply === true) {
        const { backupPath } = await saveDocx(ctx, abs, { backup: BACKUP });
        payload.written = true;
        if (backupPath) payload.backupPath = backupPath;
      }

      return ok(payload);
    });
  })
);

// ---------------------------------------------------------------------------
// 10. zotero_find_external
// ---------------------------------------------------------------------------
server.tool(
  'zotero_find_external',
  'Busca publicaciones FUERA de la biblioteca de Zotero (OpenAlex y Crossref) por tema, título, autor o DOI. ' +
    'Devuelve título, autores, año, revista, DOI, URL y acceso abierto, e indica en inLibrary si cada una ya está en la biblioteca. ' +
    'No guarda nada: para citar algo que no esté en la biblioteca, guárdalo antes con zotero_add_item (doi u openAlexId).',
  {
    query: z.string().optional().describe('Texto de búsqueda: tema, título, autores. Requerido si no hay doi.'),
    doi: z.string().optional().describe('DOI exacto (10.xxxx/... o https://doi.org/...). Si se indica, se ignora query.'),
    source: z.enum(SOURCES).optional().describe('Fuente: auto (OpenAlex y, si falla, Crossref), openalex o crossref. Default auto.'),
    limit: z.number().int().min(1).max(25).optional().describe('Máximo de resultados (default 10, máx 25).'),
    yearFrom: z.number().int().min(1000).max(2100).optional().describe('Año de publicación mínimo.'),
    yearTo: z.number().int().min(1000).max(2100).optional().describe('Año de publicación máximo.'),
    includeAbstract: z.boolean().optional().describe('Incluir el resumen (recortado) de cada resultado (default false).'),
    checkLibrary: z.boolean().optional().describe('Comprobar en la biblioteca local si cada resultado ya existe (default true).'),
  },
  async (args) => run(async () => {
    if (!args.doi && !(args.query && args.query.trim())) {
      throw new Error('Indica query o doi.');
    }
    if (args.yearFrom && args.yearTo && args.yearFrom > args.yearTo) {
      throw new Error('yearFrom no puede ser mayor que yearTo.');
    }
    let source, total, results, warnings;
    if (args.doi) {
      const found = await externalSearch.lookupDoi(args.doi, { includeAbstract: args.includeAbstract });
      ({ source } = found);
      results = [found.result];
      total = 1;
      warnings = [];
    } else {
      ({ source, total, results, warnings } = await externalSearch.search({
        query: args.query,
        source: args.source || 'auto',
        limit: args.limit,
        yearFrom: args.yearFrom,
        yearTo: args.yearTo,
        includeAbstract: args.includeAbstract,
      }));
    }

    if (args.checkLibrary !== false && results.length > 0) {
      try {
        const existing = await Promise.all(results.map((r) => zotero.findExisting({ doi: r.doi, title: r.title })));
        results = results.map((r, i) => ({
          ...r,
          inLibrary: existing[i] ? { key: existing[i].key, title: existing[i].title } : null,
        }));
      } catch (err) {
        warnings = [...warnings, `No se pudo comprobar la biblioteca local: ${err.message}`];
      }
    }

    const payload = { query: args.doi ? null : args.query, doi: args.doi ?? null, source, total, count: results.length, results };
    if (warnings.length) payload.warnings = warnings;
    return ok(payload);
  })
);

// ---------------------------------------------------------------------------
// 11. zotero_add_item
// ---------------------------------------------------------------------------
server.tool(
  'zotero_add_item',
  'Guarda en la biblioteca de Zotero una publicación encontrada con zotero_find_external, por DOI u openAlexId. ' +
    'Sin apply:true solo muestra qué se guardaría y dónde. Requiere Zotero abierto. ' +
    'Confirma con el usuario antes de guardar. No guarda duplicados salvo allowDuplicate:true.',
  {
    doi: z.string().optional().describe('DOI de la publicación (10.xxxx/... o https://doi.org/...).'),
    openAlexId: z.string().optional().describe('Id de OpenAlex (W123...) para publicaciones sin DOI (campo openAlexId de zotero_find_external).'),
    collectionKey: z.string().optional().describe('Colección destino (key de zotero_list_collections). Si se omite: la colección seleccionada en Zotero.'),
    tags: z.array(z.string().min(1)).max(20).optional().describe('Etiquetas para el item.'),
    allowDuplicate: z.boolean().optional().describe('Guardar aunque ya exista en la biblioteca (default false).'),
    apply: z.boolean().optional().describe('Guardar de verdad (default false: solo vista previa).'),
  },
  async (args) => run(async () => {
    if (!args.doi && !args.openAlexId) throw new Error('Indica doi u openAlexId.');
    const { source, csl } = await externalSearch.fetchCsl({ doi: args.doi, openAlexId: args.openAlexId });
    if (!csl.title) throw new Error('La publicación no tiene título en la fuente; no se puede guardar.');
    const preview = cslSummary(csl);

    const existing = await zotero.findExisting({ doi: csl.DOI, title: csl.title });
    const target = await resolveSaveTarget(args.collectionKey);
    const tags = [...new Set((args.tags || []).map((t) => t.trim()).filter(Boolean))];
    const base = {
      item: preview,
      metadataSource: source,
      target: target.name,
      collectionKey: args.collectionKey ?? null,
      tags,
      inLibrary: existing ? { key: existing.key, title: existing.title } : null,
    };

    if (existing && !args.allowDuplicate) {
      return ok({
        ...base,
        saved: false,
        message: `Ya está en la biblioteca con la key ${existing.key}; no se guarda de nuevo (usa allowDuplicate:true para forzarlo).`,
      });
    }
    if (!args.apply) {
      return ok({ ...base, saved: false, dryRun: true, message: 'Vista previa: repite con apply:true para guardar.' });
    }

    const sessionID = `zotero-mcp-${randomId(10)}`;
    const saved = await zoteroConnector.importCsl([{ ...csl, id: sessionID }], sessionID);
    if (saved.length === 0) throw new Error('Zotero no guardó ningún item.');
    // Lo mueve a la colección elegida (el import guarda en la seleccionada) y pone las etiquetas.
    await zoteroConnector.updateSession(sessionID, target.id, tags);

    let key = saved[0] && saved[0].key;
    if (!key) {
      const found = await zotero.findExisting({ doi: csl.DOI, title: csl.title });
      key = found ? found.key : null;
    }
    return ok({ ...base, saved: true, key, message: `Guardado en "${target.name}"${key ? ` con la key ${key}` : ''}.` });
  })
);

/** Resumen legible del CSL que se va a guardar. */
function cslSummary(csl) {
  const names = (csl.author || []).map((a) => a.literal || [a.given, a.family].filter(Boolean).join(' '));
  return {
    type: csl.type,
    title: csl.title,
    authors: names.slice(0, 10),
    ...(names.length > 10 ? { moreAuthors: names.length - 10 } : {}),
    year: csl.issued && csl.issued['date-parts'] ? csl.issued['date-parts'][0][0] ?? null : null,
    venue: csl['container-title'] ?? null,
    publisher: csl.publisher ?? null,
    doi: csl.DOI ?? null,
    url: csl.URL ?? null,
  };
}

/**
 * Destino de guardado en el conector: la colección de collectionKey (por su
 * ruta de nombres) o, sin ella, la colección seleccionada en Zotero.
 * @returns {Promise<{id: string, name: string}>}
 */
async function resolveSaveTarget(collectionKey) {
  const { selected, library, targets } = await zoteroConnector.getSaveTargets();
  if (!collectionKey) return selected;
  const collections = await zotero.listCollections();
  const path = collectionPath(collectionKey, collections);
  if (path.length === 0) {
    throw new Error(`No existe la colección con key "${collectionKey}" (consúltalas con zotero_list_collections).`);
  }
  const matches = findTargetByPath(targets, path);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Zotero no ofrece la colección "${path.join(' / ')}" como destino en ${library.name}.`
        : `Hay ${matches.length} colecciones llamadas "${path.join(' / ')}"; renombra una en Zotero o guarda sin collectionKey.`
    );
  }
  return { id: matches[0].id, name: path.join(' / ') };
}

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

/** Diff simplificado: primeras líneas añadidas/removidas (y sus totales). */
function simpleDiff(oldText, newText) {
  const oldLines = oldText.split(/\r?\n/).filter((l) => l.trim());
  const newLines = newText.split(/\r?\n/).filter((l) => l.trim());
  const added = newLines.filter((l) => !oldLines.includes(l));
  const removed = oldLines.filter((l) => !newLines.includes(l));
  return {
    addedCount: added.length,
    removedCount: removed.length,
    added: added.slice(0, 10),
    removed: removed.slice(0, 10),
  };
}
