// bib-section.js
// Localiza y reemplaza la sección de referencias/bibliografía en un documento
// Markdown. Solo toca la sección; el resto del archivo queda intacto.

const REFERENCE_HEADINGS = new Set([
  'bibliografía',
  'bibliografia',
  'referencias',
  'references',
  'bibliography',
  'lista de referencias',
  'obras citadas',
  'works cited',
  'literatura citada',
]);

/** ¿La línea es un encabezado de sección de referencias? */
export function isReferenceHeading(line) {
  const cleaned = String(line)
    .replace(/^\s{0,3}#+\s*/, '')
    .trim()
    .replace(/:+\s*$/, '')
    .toLowerCase();
  return REFERENCE_HEADINGS.has(cleaned);
}

/** ¿La línea es un encabezado Markdown cualquiera? */
function isAnyHeading(line) {
  return /^\s{0,3}#{1,6}\s+/.test(String(line));
}

/**
 * Reemplaza la sección de referencias en `text`.
 * @param {string} text Contenido del documento.
 * @param {string} newSection Texto de la nueva sección (sin encabezado).
 * @param {object} [opts]
 * @param {boolean} [opts.createSection=false] Si no existe la sección, crearla al final.
 * @param {string} [opts.heading='## Bibliografía'] Encabezado al crear la sección.
 * @returns {{text: string, applied: boolean, sectionFound: boolean, created?: boolean, heading: string|null}}
 */
export function updateBibliographySection(text, newSection, opts = {}) {
  const { createSection = false, heading = '## Bibliografía' } = opts;
  const content = String(text ?? '');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  const idx = lines.findIndex(isReferenceHeading);
  if (idx === -1) {
    if (!createSection) {
      return { text: content, applied: false, sectionFound: false, heading: null };
    }
    const block = String(newSection ?? '').trim();
    const tail = content.replace(/\s+$/, '');
    const next =
      tail + eol + eol + heading + eol + (block ? eol + block + eol : '');
    return { text: next, applied: true, sectionFound: false, created: true, heading };
  }

  let end = lines.length;
  for (let j = idx + 1; j < lines.length; j++) {
    if (isAnyHeading(lines[j])) {
      end = j;
      break;
    }
  }

  const headingLine = lines[idx].trimEnd();
  const blockLines = String(newSection ?? '')
    .trim()
    .split(/\r?\n/);

  const rest = lines.slice(end);
  let restStart = 0;
  while (restStart < rest.length && rest[restStart].trim() === '') restStart++;

  const newLines = [headingLine, '', ...blockLines, '', ...rest.slice(restStart)];

  return {
    text: newLines.join(eol),
    applied: true,
    sectionFound: true,
    heading: headingLine.trim(),
    removedOldLines: end - (idx + 1),
  };
}

/**
 * Extrae el bloque actual de la sección de referencias (para diffs).
 * @returns {string|null} null si no hay sección.
 */
export function extractBibliographySection(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const idx = lines.findIndex(isReferenceHeading);
  if (idx === -1) return null;
  let end = lines.length;
  for (let j = idx + 1; j < lines.length; j++) {
    if (isAnyHeading(lines[j])) {
      end = j;
      break;
    }
  }
  return lines.slice(idx + 1, end).join('\n').trim();
}
