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

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

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
  const ext = path.extname(String(filePath)).toLowerCase();
  if (ext !== '.docx') {
    throw new Error(`filePath debe ser un archivo .docx (se recibió "${ext || '(sin extensión)'}").`);
  }
  const abs = path.resolve(String(filePath));
  if (!existsSync(abs)) throw new Error(`El archivo no existe: ${abs}`);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`La ruta no es un archivo: ${abs}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error('El archivo .docx supera el límite de 2 MB; no se modifica.');
  }
  return abs;
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

export async function openDocx(filePath) {
  const ctx = await loadDocx(readFileSync(filePath));
  return { ...ctx, filePath };
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

export async function saveDocx({ zip, doc }, filePath) {
  zip.file(DOCUMENT_PART, serializeDocument(doc));
  const outBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  writeFileSync(filePath, outBuffer);
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
 * Items citados en el documento, en orden de aparición (con repeticiones).
 * `key` sale de la URI de Zotero (…/items/KEY); `itemData` es el CSL JSON
 * incrustado en el campo, si lo hay.
 * @returns {Array<{key: string|null, itemData: object|null}>}
 */
export function listCitedItems(doc) {
  const out = [];
  for (const { data } of zoteroCitations(doc)) {
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
      if (key || itemData) out.push({ key, itemData });
    }
  }
  return out;
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
  const jsonPayload = JSON.stringify({
    citationID,
    properties: {
      formattedCitation: visible,
      plainCitation: plainCitation || formattedCitation || '',
      noteIndex,
    },
    citationItems: [citationItem],
  });

  return [
    fldCharRun('begin'),
    instrTextRun(` ADDIN ZOTERO_ITEM CSL_CITATION ${jsonPayload}`),
    fldCharRun('separate'),
    el('w:r', [textEl(visible)]),
    fldCharRun('end'),
  ];
}

/** Párrafo (w:p) con el campo ADDIN ZOTERO_BIBL y el texto de la bibliografía. */
export function buildBibliographyParagraph(styleUrl, bibText) {
  const styleJson = JSON.stringify({
    style: styleUrl,
    fieldType: 'Field',
    hasBibliography: true,
  });

  // Cada línea de la bibliografía es un w:t, con w:br entre líneas.
  const lines = String(bibText || '').split('\n');
  const content = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push(el('w:br', []));
    content.push(textEl(line));
  });

  return el('w:p', [
    fldCharRun('begin'),
    instrTextRun(` ADDIN ZOTERO_BIBL ${styleJson}`),
    fldCharRun('separate'),
    el('w:r', content),
    fldCharRun('end'),
  ]);
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
 * o, si no hay, añade uno al final del cuerpo (antes de w:sectPr).
 */
export function upsertBibliography(doc, styleUrl, bibText) {
  const body = getBody(doc);
  const bibP = buildBibliographyParagraph(styleUrl, bibText);
  const existing = findBibliographyField(doc);

  if (existing) {
    if (existing.paragraphIndex < 0 || existing.endParagraphIndex < 0) {
      throw new Error(
        'La bibliografía de Zotero del documento está dentro de una tabla u otro contenedor; actualízala desde Word con el plugin de Zotero.'
      );
    }
    body.splice(existing.startChild, existing.endChild - existing.startChild + 1, bibP);
    return { replaced: true, paragraphIndex: existing.paragraphIndex };
  }

  let insertAt = body.length;
  for (let i = body.length - 1; i >= 0; i--) {
    if (tagOf(body[i]) === 'w:sectPr') {
      insertAt = i;
      break;
    }
  }
  body.splice(insertAt, 0, bibP);
  const paragraphIndex = topLevelParagraphs(doc).findIndex((p) => p.node === bibP);
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

export function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
