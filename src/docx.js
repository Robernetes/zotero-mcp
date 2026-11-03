// docx.js
// Manipulación de archivos Word (.docx) para insertar campos de cita y
// bibliografía de Zotero (ADDIN ZOTERO_ITEM / ADDIN ZOTERO_BIBL).
// Usa jszip + fast-xml-parser para modificar el OOXML sin alterar el resto
// del documento.
//
// El XML se parsea con `preserveOrder` (el orden de los elementos hermanos
// se conserva), sin convertir valores a número y sin procesar entidades: el
// texto se guarda tal cual está escapado en el XML, de modo que un ciclo
// abrir → guardar reproduce el documento original. Por eso el texto se
// decodifica al leerlo (decodeXml) y se codifica al crear nodos (encodeXml).
//
// Forma de los nodos con preserveOrder:
//   { 'w:p': [ ...hijos ], ':@': { '@_w:rsidR': '00AB' } }
//   { '#text': 'texto escapado' }

import JSZip from 'jszip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { MAX_FILE_BYTES, readFileForEdit, validateFilePath, writeFileAtomic } from './file-io.js';

export { MAX_FILE_BYTES };

const DOCUMENT_PART = 'word/document.xml';
const ATTRS = ':@';
const TEXT = '#text';

const XML_OPTS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  commentPropName: '#comment',
  cdataPropName: '#cdata',
};

const BUILDER_OPTS = {
  ...XML_OPTS,
  suppressEmptyNode: true,
  format: false,
};

// ---------------------------------------------------------------------------
// Validación, apertura y guardado
// ---------------------------------------------------------------------------

export function validateDocxPath(filePath) {
  return validateFilePath(filePath, { extensions: ['.docx'] });
}

/** Abre un .docx desde un buffer y parsea word/document.xml. */
export async function loadDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const part = zip.file(DOCUMENT_PART);
  if (!part) {
    throw new Error(`El archivo no es un documento Word válido (falta ${DOCUMENT_PART}).`);
  }
  const doc = parseDocumentXml(await part.async('string'));
  getBody(doc); // valida la estructura w:document/w:body
  return { zip, doc };
}

/** Abre un .docx del disco; guarda su huella (mtime/tamaño) para saveDocx. */
export async function openDocx(filePath) {
  const { data, fingerprint } = readFileForEdit(filePath);
  const ctx = await loadDocx(data);
  return { ...ctx, filePath, fingerprint };
}

export function parseDocumentXml(xmlStr) {
  return new XMLParser(XML_OPTS).parse(xmlStr);
}

export function serializeDocument(doc) {
  let xml = new XMLBuilder(BUILDER_OPTS).build(doc);
  // El builder conserva la declaración XML si estaba; la anteponemos si falta.
  if (!/^\s*<\?xml/.test(xml)) {
    xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + xml;
  }
  return xml;
}

/** Genera el .docx modificado como buffer. */
export async function buildDocxBuffer({ zip, doc }) {
  zip.file(DOCUMENT_PART, serializeDocument(doc));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Guarda el .docx de forma atómica. Si el contexto viene de openDocx, no
 * escribe cuando el archivo cambió en disco desde que se abrió.
 * @returns {Promise<{backupPath: string|null}>}
 */
export async function saveDocx(ctx, filePath, { backup = true } = {}) {
  const buffer = await buildDocxBuffer(ctx);
  const expected = ctx.filePath === filePath ? ctx.fingerprint : undefined;
  return writeFileAtomic(filePath, buffer, { expected, backup });
}

// ---------------------------------------------------------------------------
// Preferencias de documento de Zotero (docProps/custom.xml → ZOTERO_PREF_n)
// ---------------------------------------------------------------------------
//
// El plugin de Word guarda las preferencias del documento (estilo, idioma,
// tipo de campo, sesión) como propiedades personalizadas ZOTERO_PREF_1,
// ZOTERO_PREF_2…, que juntas forman un XML <data data-version="3" …>. Sin
// ellas, al pulsar Refresh Zotero abre el diálogo "Preferencias del
// documento". Formato tomado del código de integración de Zotero
// (Zotero.Integration.DocumentData) y de documentos reales creados con el plugin.

const CUSTOM_PART = 'docProps/custom.xml';
const CUSTOM_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.custom-properties+xml';
const CUSTOM_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties';
const CUSTOM_FMTID = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}';
const PREF_PROPERTY = 'ZOTERO_PREF';
const PREF_CHUNK = 255; // longitud máxima de cada propiedad (texto sin escapar)
const ZOTERO_DATA_VERSION = '3';

/** Cadena aleatoria alfanumérica (como Zotero.Utilities.randomString). */
export function randomId(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * Lee las preferencias de Zotero del documento.
 * @returns {Promise<{raw: string, styleID: string|null, locale: string|null, sessionID: string|null, fieldType: string|null}|null>}
 */
export async function readDocumentPrefs({ zip }) {
  const part = zip.file(CUSTOM_PART);
  if (!part) return null;
  const xml = await part.async('string');
  const chunks = [];
  const re = /<property\b[^>]*\bname="ZOTERO_PREF_(\d+)"[^>]*>\s*<vt:lpwstr>([^<]*)<\/vt:lpwstr>\s*<\/property>/g;
  for (const m of xml.matchAll(re)) chunks.push([Number(m[1]), decodeXml(m[2])]);
  if (chunks.length === 0) return null;
  const raw = chunks.sort((a, b) => a[0] - b[0]).map((c) => c[1]).join('');
  const attrOf = (tag, name) => {
    const t = raw.match(new RegExp(`<${tag}\\b[^>]*>`));
    const a = t && t[0].match(new RegExp(`\\b${name}="([^"]*)"`));
    return a ? decodeXml(a[1]) : null;
  };
  const fieldType = raw.match(/<pref name="fieldType" value="([^"]*)"/);
  return {
    raw,
    styleID: attrOf('style', 'id'),
    locale: attrOf('style', 'locale'),
    sessionID: attrOf('session', 'id'),
    fieldType: fieldType ? fieldType[1] : null,
  };
}

/** XML de preferencias en el formato de Zotero.Integration.DocumentData.serialize(). */
export function buildDocumentPrefs({ styleID, locale, sessionID = randomId() }) {
  const esc = (s) => encodeXml(s).replace(/"/g, '&quot;');
  return (
    `<data data-version="${ZOTERO_DATA_VERSION}" zotero-version="7.0">` +
    `<session id="${esc(sessionID)}"/>` +
    `<style id="${esc(styleID)}"${locale ? ` locale="${esc(locale)}"` : ''} hasBibliography="1" bibliographyStyleHasBeenSet="0"/>` +
    '<prefs><pref name="fieldType" value="Field"/></prefs></data>'
  );
}

/**
 * Crea las preferencias de Zotero si el documento no las tiene (nunca pisa
 * las que haya puesto el plugin). Añade docProps/custom.xml, su content type
 * y su relación si faltan.
 * @returns {Promise<{created: boolean, prefs: object}>}
 */
export async function ensureDocumentPrefs(ctx, { styleID, locale }) {
  const existing = await readDocumentPrefs(ctx);
  if (existing) return { created: false, prefs: existing };

  const { zip } = ctx;
  const data = buildDocumentPrefs({ styleID, locale });
  const chunks = [];
  for (let i = 0; i < data.length; i += PREF_CHUNK) chunks.push(data.slice(i, i + PREF_CHUNK));

  let custom = zip.file(CUSTOM_PART) ? await zip.file(CUSTOM_PART).async('string') : null;
  if (!custom) {
    custom =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>';
  }
  custom = custom.replace(/<Properties\b([^>]*)\/>/, '<Properties$1></Properties>');
  let pid = Math.max(1, ...[...custom.matchAll(/\bpid="(\d+)"/g)].map((m) => Number(m[1])));
  const props = chunks
    .map(
      (chunk, i) =>
        `<property fmtid="${CUSTOM_FMTID}" pid="${++pid}" name="${PREF_PROPERTY}_${i + 1}"><vt:lpwstr>${encodeXml(chunk)}</vt:lpwstr></property>`
    )
    .join('');
  zip.file(CUSTOM_PART, custom.replace('</Properties>', `${props}</Properties>`));

  const ctPart = zip.file('[Content_Types].xml');
  if (ctPart) {
    const ct = await ctPart.async('string');
    if (!ct.includes('PartName="/docProps/custom.xml"')) {
      zip.file(
        '[Content_Types].xml',
        ct.replace('</Types>', `<Override PartName="/${CUSTOM_PART}" ContentType="${CUSTOM_CONTENT_TYPE}"/></Types>`)
      );
    }
  }
  const relsPart = zip.file('_rels/.rels');
  if (relsPart) {
    const rels = await relsPart.async('string');
    if (!rels.includes(CUSTOM_REL_TYPE)) {
      const ids = new Set([...rels.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]));
      let n = ids.size + 1;
      while (ids.has(`rId${n}`)) n++;
      zip.file(
        '_rels/.rels',
        rels.replace('</Relationships>', `<Relationship Id="rId${n}" Type="${CUSTOM_REL_TYPE}" Target="${CUSTOM_PART}"/></Relationships>`)
      );
    }
  }
  return { created: true, prefs: await readDocumentPrefs(ctx) };
}

// ---------------------------------------------------------------------------
// Lectura de párrafos
// ---------------------------------------------------------------------------

/**
 * Párrafos de primer nivel del cuerpo (los índices que usan
 * insertCitationAtParagraph y upsertBibliography).
 */
export function readParagraphs({ doc }) {
  return topLevelParagraphs(doc).map(({ node }, index) => {
    const text = collect(node, 'w:t').join('');
    const instr = collect(node, 'w:instrText').join('');
    return { index, text: text.trim(), hasZoteroField: /ADDIN ZOTERO/.test(instr) };
  });
}

// ---------------------------------------------------------------------------
// Campos de Word (fldChar begin / instrText / separate / end)
// ---------------------------------------------------------------------------

/**
 * Recorre el cuerpo en orden de documento y devuelve los campos complejos.
 * Word puede partir el código de un campo en varios w:instrText y un campo
 * puede abarcar varios párrafos (p. ej. la bibliografía de Zotero), por eso
 * se acumula el texto entre begin y separate/end.
 * @returns {Array<{instruction: string, startChild: number, endChild: number}>}
 *   startChild/endChild: índices en los hijos de w:body donde empieza/termina.
 */
export function scanFields(doc) {
  const fields = [];
  const stack = [];
  const body = getBody(doc);

  const visit = (node, childIndex) => {
    const tag = tagOf(node);
    if (tag === 'w:fldChar') {
      const type = attr(node, 'w:fldCharType');
      if (type === 'begin') {
        stack.push({ instruction: '', startChild: childIndex, inCode: true });
      } else if (type === 'separate') {
        if (stack.length) stack[stack.length - 1].inCode = false;
      } else if (type === 'end') {
        const field = stack.pop();
        if (field) {
          fields.push({ instruction: field.instruction, startChild: field.startChild, endChild: childIndex });
        }
      }
      return;
    }
    if (tag === 'w:instrText') {
      const field = stack[stack.length - 1];
      if (field && field.inCode) field.instruction += textOf(node);
      return;
    }
    for (const child of childrenOf(node)) visit(child, childIndex);
  };

  body.forEach((child, i) => visit(child, i));
  return fields;
}

/** Campos ADDIN ZOTERO_ITEM con su JSON CSL_CITATION parseado. */
export function zoteroCitations(doc) {
  const out = [];
  for (const f of scanFields(doc)) {
    const instr = f.instruction.trim();
    if (!instr.startsWith('ADDIN ZOTERO_ITEM')) continue;
    const jsonStart = instr.indexOf('{');
    let data = null;
    if (jsonStart >= 0) {
      try {
        data = JSON.parse(instr.slice(jsonStart));
      } catch {
        data = null;
      }
    }
    out.push({ ...f, data });
  }
  return out;
}

export function countExistingCitations({ doc }) {
  return zoteroCitations(doc).length;
}

/** Mayor id numérico usado por los citationItems/itemData del documento. */
export function countMaxId({ doc }) {
  let max = 0;
  for (const { data } of zoteroCitations(doc)) {
    for (const item of (data && data.citationItems) || []) {
      for (const id of [item && item.id, item && item.itemData && item.itemData.id]) {
        const n = typeof id === 'number' ? id : /^\d+$/.test(String(id)) ? Number(id) : NaN;
        if (Number.isInteger(n) && n > max) max = n;
      }
    }
  }
  return max;
}

/**
 * Citas Zotero del documento en orden, una por campo, con sus items.
 * `key` sale de la URI de Zotero (…/items/KEY); `itemData` es el CSL JSON
 * incrustado en el campo, si lo hay. `startChild` es el índice en w:body
 * donde empieza el campo (para saber qué citas van antes de un párrafo).
 * @returns {Array<{startChild: number, items: Array<{key: string|null, itemData: object|null,
 *   locator?: string, label?: string, prefix?: string, suffix?: string}>}>}
 */
export function listDocumentCitations(doc) {
  const out = [];
  for (const { data, startChild } of zoteroCitations(doc)) {
    const items = [];
    for (const item of (data && data.citationItems) || []) {
      if (!item) continue;
      const uris = Array.isArray(item.uris) ? item.uris : item.uri ? [].concat(item.uri) : [];
      let key = null;
      for (const uri of uris) {
        const m = String(uri).match(/\/items\/([A-Za-z0-9]+)\/?$/);
        if (m) {
          key = m[1];
          break;
        }
      }
      const itemData = item.itemData && typeof item.itemData === 'object' ? item.itemData : null;
      if (!key && !itemData) continue;
      const entry = { key, itemData };
      for (const f of ['locator', 'label', 'prefix', 'suffix']) if (item[f] != null) entry[f] = item[f];
      items.push(entry);
    }
    if (items.length > 0) out.push({ startChild, items });
  }
  return out;
}

/**
 * Items citados en el documento, en orden de aparición (con repeticiones).
 * @returns {Array<{key: string|null, itemData: object|null}>}
 */
export function listCitedItems(doc) {
  return listDocumentCitations(doc).flatMap((c) => c.items.map(({ key, itemData }) => ({ key, itemData })));
}

/** Índice en w:body del párrafo de primer nivel `paragraphIndex` (o -1). */
export function paragraphChildIndex(doc, paragraphIndex) {
  const p = topLevelParagraphs(doc)[paragraphIndex];
  return p ? p.childIndex : -1;
}

// ---------------------------------------------------------------------------
// Construcción de campos
// ---------------------------------------------------------------------------

/** Runs (w:r) de un campo de cita ADDIN ZOTERO_ITEM. */
export function buildCitationRuns({
  citationID,
  noteIndex,
  formattedCitation,
  plainCitation,
  uris,
  itemData,
  locator,
  label,
  prefix,
  suffix,
}) {
  const citationItem = { id: itemData.id, uris, itemData };
  if (locator) citationItem.locator = String(locator);
  if (label) citationItem.label = label;
  if (prefix) citationItem.prefix = prefix;
  if (suffix) citationItem.suffix = suffix;

  const visible = formattedCitation || plainCitation || '';
  // Mismo formato que escribe el plugin de Zotero (incluida la clave "schema"
  // y el espacio final del código de campo).
  const jsonPayload = JSON.stringify({
    citationID,
    properties: {
      formattedCitation: visible,
      plainCitation: plainCitation || formattedCitation || '',
      noteIndex,
    },
    citationItems: [citationItem],
    schema: CSL_CITATION_SCHEMA,
  });

  return [
    fldCharRun('begin'),
    instrTextRun(` ADDIN ZOTERO_ITEM CSL_CITATION ${jsonPayload} `),
    fldCharRun('separate'),
    el('w:r', [textEl(visible)]),
    fldCharRun('end'),
  ];
}

const CSL_CITATION_SCHEMA = 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json';
const BIBL_INSTRUCTION = ' ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY ';

/**
 * Párrafos (w:p) de la bibliografía, uno por referencia como hace el plugin:
 * el campo ADDIN ZOTERO_BIBL empieza en el primero y termina en el último.
 * @param {string[]} entries Referencias en texto plano.
 * @param {object} [opts]
 * @param {string} [opts.pStyle] Estilo de párrafo (p. ej. "Bibliography") si existe en el documento.
 */
export function buildBibliographyParagraphs(entries, { pStyle } = {}) {
  const lines = (entries || []).map((e) => String(e)).filter((e) => e.trim());
  if (lines.length === 0) lines.push('');
  const pPr = () => (pStyle ? [el('w:pPr', [el('w:pStyle', [], { 'w:val': pStyle })])] : []);
  return lines.map((line, i) => {
    const content = [...pPr()];
    if (i === 0) content.push(fldCharRun('begin'), instrTextRun(BIBL_INSTRUCTION), fldCharRun('separate'));
    content.push(el('w:r', [textEl(line)]));
    if (i === lines.length - 1) content.push(fldCharRun('end'));
    return el('w:p', content);
  });
}

/** ¿El documento define el estilo de párrafo `styleId` en word/styles.xml? */
export async function hasParagraphStyle({ zip }, styleId) {
  const part = zip.file('word/styles.xml');
  if (!part) return false;
  return (await part.async('string')).includes(`w:styleId="${styleId}"`);
}

// ---------------------------------------------------------------------------
// Inserción y actualización en el documento
// ---------------------------------------------------------------------------

/** Añade los runs al final del párrafo de primer nivel indicado. */
export function insertCitationAtParagraph(doc, paragraphIndex, runs) {
  const paragraphs = topLevelParagraphs(doc);
  const target = paragraphs[paragraphIndex];
  if (!target) {
    throw new Error(
      `No existe el párrafo ${paragraphIndex} (el documento tiene ${paragraphs.length} párrafos). Usa zotero_read_docx para ver la estructura.`
    );
  }
  childrenOf(target.node).push(...runs);
}

/** Primer campo ADDIN ZOTERO_BIBL del documento (o null). */
export function findBibliographyField(doc) {
  const field = scanFields(doc).find((f) => f.instruction.trim().startsWith('ADDIN ZOTERO_BIBL'));
  if (!field) return null;
  const paragraphs = topLevelParagraphs(doc);
  const indexOfChild = (childIndex) => paragraphs.findIndex((p) => p.childIndex === childIndex);
  return {
    paragraphIndex: indexOfChild(field.startChild),
    endParagraphIndex: indexOfChild(field.endChild),
    startChild: field.startChild,
    endChild: field.endChild,
  };
}

/**
 * Reemplaza el campo de bibliografía existente (todos los párrafos que abarca)
 * o, si no hay, lo añade al final del cuerpo (antes de w:sectPr).
 * @param {string[]} entries Referencias en texto plano.
 * @param {object} [opts] Ver buildBibliographyParagraphs.
 */
export function upsertBibliography(doc, entries, opts = {}) {
  const body = getBody(doc);
  const bibParagraphs = buildBibliographyParagraphs(entries, opts);
  const existing = findBibliographyField(doc);

  if (existing) {
    if (existing.paragraphIndex < 0 || existing.endParagraphIndex < 0) {
      throw new Error(
        'La bibliografía de Zotero del documento está dentro de una tabla u otro contenedor; actualízala desde Word con el plugin de Zotero.'
      );
    }
    body.splice(existing.startChild, existing.endChild - existing.startChild + 1, ...bibParagraphs);
    return { replaced: true, paragraphIndex: existing.paragraphIndex };
  }

  let insertAt = body.length;
  for (let i = body.length - 1; i >= 0; i--) {
    if (tagOf(body[i]) === 'w:sectPr') {
      insertAt = i;
      break;
    }
  }
  body.splice(insertAt, 0, ...bibParagraphs);
  const paragraphIndex = topLevelParagraphs(doc).findIndex((p) => p.node === bibParagraphs[0]);
  return { replaced: false, added: true, paragraphIndex };
}

// ---------------------------------------------------------------------------
// Helpers de nodos (formato preserveOrder)
// ---------------------------------------------------------------------------

function tagOf(node) {
  if (!node || typeof node !== 'object') return null;
  for (const k of Object.keys(node)) if (k !== ATTRS) return k;
  return null;
}

function childrenOf(node) {
  const tag = tagOf(node);
  const value = tag ? node[tag] : null;
  return Array.isArray(value) ? value : [];
}

function attr(node, name) {
  return node && node[ATTRS] ? node[ATTRS][`@_${name}`] : undefined;
}

function el(tag, children = [], attrs) {
  const node = { [tag]: children };
  if (attrs) {
    node[ATTRS] = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [`@_${k}`, v]));
  }
  return node;
}

function textEl(text) {
  return el('w:t', [{ [TEXT]: encodeXml(text) }], { 'xml:space': 'preserve' });
}

function fldCharRun(type) {
  return el('w:r', [el('w:fldChar', [], { 'w:fldCharType': type })]);
}

function instrTextRun(instruction) {
  return el('w:r', [el('w:instrText', [{ [TEXT]: encodeXml(instruction) }], { 'xml:space': 'preserve' })]);
}

/** Texto decodificado de un nodo (concatena sus nodos de texto directos). */
function textOf(node) {
  return childrenOf(node)
    .map((c) => (c && c[TEXT] != null ? decodeXml(String(c[TEXT])) : ''))
    .join('');
}

/** Textos de todos los descendientes con la etiqueta dada, en orden. */
function collect(node, tag, out = []) {
  for (const child of childrenOf(node)) {
    if (tagOf(child) === tag) out.push(textOf(child));
    else collect(child, tag, out);
  }
  return out;
}

function getBody(doc) {
  const root = (Array.isArray(doc) ? doc : []).find((n) => tagOf(n) === 'w:document');
  const body = root && childrenOf(root).find((n) => tagOf(n) === 'w:body');
  if (!body) {
    throw new Error(`El archivo no es un documento Word válido (${DOCUMENT_PART} no contiene w:document/w:body).`);
  }
  return childrenOf(body);
}

function topLevelParagraphs(doc) {
  const out = [];
  getBody(doc).forEach((node, childIndex) => {
    if (tagOf(node) === 'w:p') out.push({ node, childIndex });
  });
  return out;
}

export function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function encodeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

