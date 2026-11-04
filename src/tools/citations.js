// tools/citations.js
// Citas textuales y bibliografía en Markdown: zotero_cite, zotero_bibliography.

import { z } from 'zod';
import { AVAILABLE_STYLES, FORMATS, LOCALES } from '../cite.js';
import { countReferenceEntries, extractBibliographySection, updateBibliographySection } from '../bib-section.js';
import { readFileForEdit, withFileLock, writeFileAtomic } from '../file-io.js';
import { fail, ok, run } from './shared.js';

/** @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server @param {import('../context.js').ToolContext} ctx */
export function registerCitationTools(server, { citationManager, config, workspace }) {
  const { defaultStyle, defaultLocale, backup } = config;

  // ---------------------------------------------------------------------------
  // zotero_cite
  // ---------------------------------------------------------------------------
  server.registerTool(
    'zotero_cite',
    {
      description:
        'Genera una cita textual para un item de Zotero en el estilo indicado (APA, MLA, Chicago, Harvard, IEEE, Vancouver). ' +
        'La cita se registra para que la bibliografía se actualice automáticamente. Usa el mismo style y locale en todo el documento.',
      inputSchema: {
        key: z.string().min(1).describe('Key del item de Zotero.'),
        style: z.string().optional().describe(`Estilo CSL. Default: ${defaultStyle}. Disponibles: ${AVAILABLE_STYLES.join(', ')}.`),
        locale: z.string().optional().describe(`Idioma del estilo. Default: ${defaultLocale}. Disponibles: ${LOCALES.join(', ')}.`),
        locator: z.string().optional().describe('Localizador, p. ej. "15" para página 15.'),
        label: z.string().optional().describe('Etiqueta del localizador: page, chapter, section, figure, volume, ...'),
        prefix: z.string().optional().describe('Texto antes de la cita.'),
        suffix: z.string().optional().describe('Texto después de la cita.'),
        register: z.boolean().optional().describe('Registrar la cita para la bibliografía automática (default true). Con false solo devuelve el texto: el registro no cambia.'),
      },
    },
    async (args) => run(async () => {
      const result = await citationManager.cite({
        key: args.key,
        style: args.style || defaultStyle,
        locale: args.locale || defaultLocale,
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
  // zotero_bibliography
  // ---------------------------------------------------------------------------
  server.registerTool(
    'zotero_bibliography',
    {
      description:
        'Genera la bibliografía (lista de referencias) desde el registro de citas o desde keys explícitas. ' +
        'Con filePath y apply:true actualiza la sección de referencias de un documento Markdown, de modo que la bibliografía se renueva sola al añadir citas.',
      inputSchema: {
        keys: z.array(z.string()).optional().describe('Keys de Zotero. Si se omite, usa las citas registradas con zotero_cite.'),
        style: z.string().optional().describe(`Estilo CSL. Default: ${defaultStyle}.`),
        locale: z.string().optional().describe(`Idioma. Default: ${defaultLocale}.`),
        format: z.enum(FORMATS).optional().describe('Formato de salida (default markdown).'),
        filePath: z.string().optional().describe('Ruta de un archivo .md/.markdown cuya sección de referencias se actualizará, dentro de la carpeta de trabajo (las rutas relativas se resuelven desde ella).'),
        apply: z.boolean().optional().describe('Escribir el archivo (requiere filePath; default false).'),
        createSection: z.boolean().optional().describe('Si el documento no tiene sección de referencias, crearla al final (default false).'),
        force: z.boolean().optional().describe('Escribir aunque la nueva bibliografía tenga menos referencias que la sección actual (default false).'),
      },
    },
    async (args) => run(async () => {
      const style = args.style || defaultStyle;
      const locale = args.locale || defaultLocale;
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

      const abs = await workspace.resolve(args.filePath, {
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
          const { backupPath } = writeFileAtomic(abs, result.text, { expected: fingerprint, backup });
          payload.written = true;
          if (backupPath) payload.backupPath = backupPath;
        }

        return ok(payload);
      });
    })
  );
}

/** Diff simplificado: primeras líneas añadidas/removidas (y sus totales). */
export function simpleDiff(oldText, newText) {
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
