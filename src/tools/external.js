// tools/external.js
// Fuera de la biblioteca: zotero_find_external (OpenAlex / Crossref) y
// zotero_add_item (guardar en la biblioteca a través del conector de Zotero).

import { z } from 'zod';
import { SOURCES } from '../external-search.js';
import { collectionPath, findTargetByPath } from '../zotero-connector.js';
import { randomId } from '../docx.js';
import { ok, run } from './shared.js';

/** @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server @param {import('../context.js').ToolContext} ctx */
export function registerExternalTools(server, { zotero, zoteroConnector, externalSearch }) {
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
  // zotero_find_external
  // ---------------------------------------------------------------------------
  server.registerTool(
    'zotero_find_external',
    {
      description:
        'Busca publicaciones FUERA de la biblioteca de Zotero (OpenAlex y Crossref) por tema, título, autor o DOI. ' +
        'Devuelve título, autores, año, revista, DOI, URL y acceso abierto, e indica en inLibrary si cada una ya está en la biblioteca. ' +
        'No guarda nada: para citar algo que no esté en la biblioteca, guárdalo antes con zotero_add_item (doi u openAlexId).',
      inputSchema: {
        query: z.string().optional().describe('Texto de búsqueda: tema, título, autores. Requerido si no hay doi.'),
        doi: z.string().optional().describe('DOI exacto (10.xxxx/... o https://doi.org/...). Si se indica, se ignora query.'),
        source: z.enum(SOURCES).optional().describe('Fuente: auto (OpenAlex y, si falla, Crossref), openalex o crossref. Default auto.'),
        limit: z.number().int().min(1).max(25).optional().describe('Máximo de resultados (default 10, máx 25).'),
        yearFrom: z.number().int().min(1000).max(2100).optional().describe('Año de publicación mínimo.'),
        yearTo: z.number().int().min(1000).max(2100).optional().describe('Año de publicación máximo.'),
        includeAbstract: z.boolean().optional().describe('Incluir el resumen (recortado) de cada resultado (default false).'),
        checkLibrary: z.boolean().optional().describe('Comprobar en la biblioteca local si cada resultado ya existe (default true).'),
      },
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
  // zotero_add_item
  // ---------------------------------------------------------------------------
  server.registerTool(
    'zotero_add_item',
    {
      description:
        'Guarda en la biblioteca de Zotero una publicación encontrada con zotero_find_external, por DOI u openAlexId. ' +
        'Sin apply:true solo muestra qué se guardaría y dónde. Requiere Zotero abierto. ' +
        'Confirma con el usuario antes de guardar. No guarda duplicados salvo allowDuplicate:true.',
      inputSchema: {
        doi: z.string().optional().describe('DOI de la publicación (10.xxxx/... o https://doi.org/...).'),
        openAlexId: z.string().optional().describe('Id de OpenAlex (W123...) para publicaciones sin DOI (campo openAlexId de zotero_find_external).'),
        collectionKey: z.string().optional().describe('Colección destino (key de zotero_list_collections). Si se omite: la colección seleccionada en Zotero.'),
        tags: z.array(z.string().min(1)).max(20).optional().describe('Etiquetas para el item.'),
        allowDuplicate: z.boolean().optional().describe('Guardar aunque ya exista en la biblioteca (default false).'),
        apply: z.boolean().optional().describe('Guardar de verdad (default false: solo vista previa).'),
      },
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
}

/** Resumen legible del CSL que se va a guardar. */
export function cslSummary(csl) {
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
