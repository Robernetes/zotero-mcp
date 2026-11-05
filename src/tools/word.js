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
  locateCitation,
  insertCitationAt,
  upsertBibliography,
  listDocumentCitations,
  readDocumentPrefs,
  ensureDocumentPrefs,
  hasParagraphStyle,
  randomId,
} from '../docx.js';
import { fail, ok, run } from './shared.js';

const CITATION_ITEM_FIELDS = ['locator', 'label', 'prefix', 'suffix'];
const DOCX = { extensions: ['.docx'] };
const PATH_HINT_DOCX = 'Ruta del archivo .docx, dentro de la carpeta de trabajo (las rutas relativas se resuelven desde ella).';

/** Texto alrededor de una cita nueva tal como quedará en el párrafo. */
function citationPreview(loc, citation) {
  const left = loc.text.slice(Math.max(0, loc.pos - 70), loc.pos);
  const right = loc.text.slice(loc.pos, loc.pos + 30);
  return (
    (loc.pos > 70 ? '…' : '') +
    left +
    (loc.spaceBefore ? ' ' : '') +
    citation +
    (loc.spaceAfter ? ' ' : '') +
    right +
    (loc.pos + 30 < loc.text.length ? '…' : '')
  );
}

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
        'Inserta una cita Zotero (campo ADDIN ZOTERO_ITEM CSL_CITATION) en un documento Word, justo después de la frase que respalda. ' +
        'Indica el lugar con afterText (un fragmento exacto del texto de zotero_read_docx) y, si quieres acotar, paragraphIndex; ' +
        'sin afterText la cita va al final del párrafo. La cita se coloca antes de la puntuación que cierra la frase y con su espacio: "…del software (Autor, 2020)." ' +
        'Para varias fuentes que respaldan la misma afirmación usa keys: genera una sola cita agrupada, "(Autor, 2020; Otro, 2021)", en lugar de citas seguidas. ' +
        'El texto de la cita (numeración, desambiguación) se calcula con las citas que ya contiene el documento. Revisa preview en la vista previa antes de escribir con apply:true. ' +
        'Usa siempre el mismo style y locale en todo el documento.',
      inputSchema: {
        filePath: z.string().min(1).describe(PATH_HINT_DOCX),
        key: z.string().min(1).optional().describe('Key del item de Zotero (una fuente). Usa key o keys.'),
        keys: z.array(z.string().min(1)).min(1).max(20).optional().describe('Keys de varias fuentes para una sola cita agrupada.'),
        afterText: z.string().optional().describe('Fragmento exacto del texto tras el que va la cita (la afirmación que respalda). Debe aparecer una sola vez.'),
        paragraphIndex: z.number().int().min(0).optional().describe('Índice del párrafo (0‑based, de zotero_read_docx). Sin afterText, la cita va al final de este párrafo.'),
        style: z.string().optional().describe(`Estilo CSL. Default: el configurado en el documento por Zotero, o ${defaultStyle}.`),
        locale: z.string().optional().describe(`Idioma. Default: el configurado en el documento por Zotero, o ${defaultLocale}.`),
        locator: z.string().optional().describe('Localizador (p. ej. "15"). Solo con una fuente.'),
        label: z.string().optional().describe('Etiqueta del localizador: page, chapter, section, figure, volume… Solo con una fuente.'),
        prefix: z.string().optional().describe('Texto dentro de la cita, antes de la primera fuente (p. ej. "véase"). No lo uses para añadir espacios: se ponen solos.'),
        suffix: z.string().optional().describe('Texto dentro de la cita, después de la última fuente.'),
        apply: z.boolean().optional().describe('Escribir el archivo (default false).'),
      },
    },
    async (args) => run(async () => {
      if (args.key && args.keys) return fail('Usa key o keys, no los dos.');
      const keys = [...new Set((args.keys || (args.key ? [args.key] : [])).map((k) => String(k).trim()).filter(Boolean))];
      if (keys.length === 0) return fail('Indica key (una fuente) o keys (varias fuentes en una cita).');
      if (keys.length > 1 && (args.locator || args.label)) {
        return fail('locator y label solo se pueden usar con una fuente: inserta esa fuente en una cita propia.');
      }
      if (args.paragraphIndex == null && !(args.afterText && args.afterText.trim())) {
        return fail('Indica afterText (la frase tras la que va la cita) o paragraphIndex.');
      }
      const abs = await workspace.resolve(args.filePath, DOCX);

      // Obtener el CSL JSON desde Zotero (con el id normalizado a key corta).
      const fetched = new Map((await zotero.getByKeys(keys)).map((item) => [String(item.id), item]));
      const missing = keys.filter((k) => !fetched.has(k));
      if (missing.length > 0) {
        return fail(`No se encontró en Zotero ningún item con key ${missing.map((k) => `"${k}"`).join(', ')}. Verifícala con zotero_search.`);
      }

      // Abrir el docx (en exclusiva sobre el archivo hasta guardar).
      return withFileLock(abs, async () => {
        const ctx = await openDocx(abs);
        const loc = locateCitation(ctx.doc, { paragraphIndex: args.paragraphIndex, afterText: args.afterText });
        const { style, locale, warnings } = await resolveDocxStyle(ctx, args);

        // El texto de la cita se calcula con las citas que ya contiene el documento
        // (antes y después de la nueva), no con el registro en memoria del servidor:
        // así la numeración y la desambiguación ("2020a") son las del documento.
        const citations = listDocumentCitations(ctx.doc);
        const resolved = await resolveDocumentCitations(citations);
        for (const [k, item] of fetched) resolved.itemsById.set(k, item); // datos recién obtenidos de Zotero
        const before = [];
        const after = [];
        let inParagraph = 0;
        citations.forEach((c, i) => {
          const cluster = resolved.clusters[i].filter((ci) => resolved.itemsById.has(ci.id));
          let isBefore = c.startChild < loc.bodyIndex;
          if (c.startChild === loc.bodyIndex) isBefore = inParagraph++ < loc.citationsBefore;
          if (cluster.length > 0) (isBefore ? before : after).push(cluster);
        });
        const citationItems = keys.map((k, i) => {
          const ci = { id: k };
          if (keys.length === 1) {
            if (args.locator) ci.locator = args.locator;
            if (args.label) ci.label = args.label;
          }
          if (i === 0 && args.prefix) ci.prefix = args.prefix;
          if (i === keys.length - 1 && args.suffix) ci.suffix = args.suffix;
          return ci;
        });
        const citeResult = citationManager.renderCitation({
          style,
          locale,
          items: [...resolved.itemsById.values()],
          before,
          citationItems,
          after,
        });

        // Como el plugin de Zotero: citationID aleatorio y noteIndex 0 (los estilos
        // disponibles citan en el texto; Zotero recalcula noteIndex al refrescar).
        const citationID = randomId(8);
        const noteIndex = 0;

        // Cada itemData lleva un id numérico único en el documento. Va sin la URI
        // (zoteroURI no es enumerable): la URI va en `uris`, y con ella Zotero
        // enlaza la cita con el item de la biblioteca.
        const firstId = countMaxId(ctx) + 1;
        const items = citationItems.map((ci, i) => {
          const cslItem = fetched.get(ci.id);
          return {
            ...ci,
            itemData: { ...cslItem, id: firstId + i },
            uris: [cslItem.zoteroURI || `http://zotero.org/users/0/items/${ci.id}`],
          };
        });

        const { created: prefsCreated } = await ensureDocumentPrefs(ctx, { styleID: zoteroStyleId(style), locale });

        const runs = buildCitationRuns({
          citationID,
          noteIndex,
          formattedCitation: citeResult.citation,
          plainCitation: citeResult.citation,
          items,
        });
        insertCitationAt(ctx.doc, loc, runs);

        const apply = args.apply === true;
        const payload = {
          filePath: abs,
          ...(keys.length === 1 ? { key: keys[0] } : { keys }),
          paragraphIndex: loc.paragraphIndex,
          citationID,
          noteIndex,
          style,
          locale,
          citation: citeResult.citation,
          // Cómo queda el texto alrededor de la cita, para revisarlo antes de escribir.
          preview: citationPreview(loc, citeResult.citation),
          placement: {
            afterText: loc.matchedText,
            beforePunctuation: loc.beforePunctuation,
            spaceAdded: loc.spaceBefore || loc.spaceAfter,
          },
          citationsInDocument: citations.length,
          documentPrefs: !prefsCreated ? 'existentes' : apply ? 'creadas' : 'se crearían',
          apply,
          dryRun: !apply,
        };
        if (resolved.unresolved.length > 0) {
          warnings.push(
            `Algunas citas del documento no se pudieron resolver (${resolved.unresolved.join(', ')}) y no se tuvieron en cuenta para numerar o desambiguar esta cita; el plugin de Zotero la corregirá al refrescar.`
          );
        }
        if (warnings.length > 0) payload.warnings = warnings;

        if (apply) {
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
