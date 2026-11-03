// tools/word.js
// Documentos Word (.docx) con campos del plugin de Zotero: zotero_read_docx,
// zotero_insert_citation_docx, zotero_update_bibliography_docx.

import { z } from 'zod';
import { resolveStyleName, styleNameFromZoteroId, zoteroStyleId } from '../cite.js';
import { withFileLock } from '../file-io.js';
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
} from '../docx.js';
import { fail, ok, run } from './shared.js';

const CITATION_ITEM_FIELDS = ['locator', 'label', 'prefix', 'suffix'];
const DOCX = { extensions: ['.docx'] };
const PATH_HINT_DOCX = 'Ruta del archivo .docx, dentro de la carpeta de trabajo (las rutas relativas se resuelven desde ella).';

/** @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server @param {import('../context.js').ToolContext} ctx */
export function registerWordTools(server, { zotero, citationManager, config, workspace }) {
  const { defaultStyle, defaultLocale, backup } = config;

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
      style = resolveStyleName(defaultStyle);
      if (docStyleID) {
        warnings.push(
          `El documento usa el estilo ${docStyleID}, que zotero-mcp no incluye; el texto se genera en "${style}" y Zotero lo corregirá al pulsar Refresh.`
        );
      }
    }
    const locale = String(args.locale || (prefs && prefs.locale) || defaultLocale).trim();
    return { style, locale, prefs, warnings };
  }

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
  // zotero_read_docx
  // ---------------------------------------------------------------------------
  server.registerTool(
    'zotero_read_docx',
    {
      description:
        'Lee los párrafos de un documento Word (.docx). Usa esta herramienta primero para conocer la estructura del documento antes de insertar citas. Devuelve el índice, texto y si cada párrafo ya contiene campos Zotero.',
      inputSchema: {
        filePath: z.string().min(1).describe(PATH_HINT_DOCX),
      },
    },
    async (args) => run(async () => {
      const abs = await workspace.resolve(args.filePath, DOCX);
      const ctx = await openDocx(abs);
      const paragraphs = readParagraphs(ctx);
      return ok({ filePath: abs, count: paragraphs.length, paragraphs });
    })
  );

  // ---------------------------------------------------------------------------
  // zotero_insert_citation_docx
  // ---------------------------------------------------------------------------
  server.registerTool(
    'zotero_insert_citation_docx',
    {
      description:
        'Inserta un campo de cita Zotero (ADDIN ZOTERO_ITEM CSL_CITATION) al final del párrafo indicado en un documento Word. El texto de la cita (numeración, desambiguación) se calcula con las citas que ya contiene el documento, no con las de zotero_cite. La cita se renderizará correctamente al abrir el archivo en Word con el plugin de Zotero. Usa siempre el mismo style y locale en todo el documento.',
      inputSchema: {
        filePath: z.string().min(1).describe(PATH_HINT_DOCX),
        key: z.string().min(1).describe('Key del item de Zotero.'),
        paragraphIndex: z.number().int().min(0).describe('Índice del párrafo donde insertar la cita (0‑based). Usa zotero_read_docx para ver los índices.'),
        style: z.string().optional().describe(`Estilo CSL. Default: el configurado en el documento por Zotero, o ${defaultStyle}.`),
        locale: z.string().optional().describe(`Idioma. Default: el configurado en el documento por Zotero, o ${defaultLocale}.`),
        locator: z.string().optional().describe('Localizador (p. ej. "15").'),
        label: z.string().optional().describe('Etiqueta del localizador: page, chapter, section, figure, volume…'),
        prefix: z.string().optional().describe('Texto antes de la cita.'),
        suffix: z.string().optional().describe('Texto después de la cita.'),
        dryRun: z.boolean().optional().describe('Solo mostrar lo que se insertaría (default true).'),
        apply: z.boolean().optional().describe('Escribir el archivo (default false).'),
      },
    },
    async (args) => run(async () => {
      const abs = await workspace.resolve(args.filePath, DOCX);
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
          const { backupPath } = await saveDocx(ctx, abs, { backup });
          payload.written = true;
          if (backupPath) payload.backupPath = backupPath;
        }

        return ok(payload);
      });
    })
  );

  // ---------------------------------------------------------------------------
  // zotero_update_bibliography_docx
  // ---------------------------------------------------------------------------
  server.registerTool(
    'zotero_update_bibliography_docx',
    {
      description:
        'Inserta o actualiza el campo de bibliografía Zotero (ADDIN ZOTERO_BIBL) en un documento Word, al final del documento. Las referencias se generan desde los campos de cita Zotero que ya contiene el propio documento (los insertados con zotero_insert_citation_docx o con el plugin de Word). Al abrir el archivo en Word con el plugin de Zotero, la bibliografía se renderiza con el estilo configurado.',
      inputSchema: {
        filePath: z.string().min(1).describe(PATH_HINT_DOCX),
        style: z.string().optional().describe(`Estilo CSL. Default: el configurado en el documento por Zotero, o ${defaultStyle}.`),
        locale: z.string().optional().describe(`Idioma. Default: el configurado en el documento por Zotero, o ${defaultLocale}.`),
        dryRun: z.boolean().optional().describe('Solo mostrar lo que cambiaría (default true).'),
        apply: z.boolean().optional().describe('Escribir el archivo (default false).'),
      },
    },
    async (args) => run(async () => {
      const abs = await workspace.resolve(args.filePath, DOCX);

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
          const { backupPath } = await saveDocx(ctx, abs, { backup });
          payload.written = true;
          if (backupPath) payload.backupPath = backupPath;
        }

        return ok(payload);
      });
    })
  );
}
