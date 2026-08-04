// docx.js
// Manipulación de archivos Word (.docx) para insertar campos de cita y
// bibliografía de Zotero (ADDIN ZOTERO_ITEM / ADDIN ZOTERO_BIBL).
// Usa jszip + fast-xml-parser para modificar el OOXML sin alterar el resto
// del documento.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const PARSER_OPTS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  trimValues: false,
  isArray: (name) =>
    ['w:p', 'w:r', 'w:t', 'w:fldChar', 'w:instrText', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:br'].includes(name),
};

const BUILDER_OPTS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  format: false,
};

// ---------------------------------------------------------------------------
// Validación y apertura
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

export async function openDocx(filePath) {
  const buffer = readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const xmlStr = await zip.file('word/document.xml').async('string');
  const parser = new XMLParser(PARSER_OPTS);
  const doc = parser.parse(xmlStr);
  return { zip, doc, filePath };
}

export async function saveDocx({ zip, doc }, filePath) {
  const builder = new XMLBuilder(BUILDER_OPTS);
  let newXml = builder.build(doc);
  // El builder puede omitir la declaración XML; la anteponemos si falta.
  if (!/^\s*<\?xml/.test(newXml)) {
    newXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + newXml;
  }
  zip.file('word/document.xml', newXml);
  const outBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  writeFileSync(filePath, outBuffer);
}

// ---------------------------------------------------------------------------
// Lectura de párrafos
// ---------------------------------------------------------------------------

export function readParagraphs({ doc }) {
  const paragraphs = [];
  const wp = getArray(doc['w:document']['w:body']['w:p']);
  for (let i = 0; i < wp.length; i++) {
    const runs = getArray(wp[i]['w:r']);
    let text = '';
    let hasZoteroField = false;
    for (const r of runs) {
      const tEls = getArray(r['w:t']);
      for (const tEl of tEls) {
        if (tEl) text += typeof tEl === 'string' ? tEl : String(tEl['#text'] ?? '');
      }
      const instrArr = r['w:instrText'];
      const instr = Array.isArray(instrArr) ? instrArr[0] : instrArr;
      if (instr && /ADDIN ZOTERO/.test(String(instr['#text'] || ''))) {
        hasZoteroField = true;
      }
    }
    paragraphs.push({ index: i, text: text.trim(), hasZoteroField });
  }
  return paragraphs;
}

// ---------------------------------------------------------------------------
// Conteo de citas y utilidades
// ---------------------------------------------------------------------------

export function countExistingCitations({ doc }) {
  let count = 0;
  const wp = getArray(doc['w:document']['w:body']['w:p']);
  for (const p of wp) {
    const runs = getArray(p['w:r']);
    for (const r of runs) {
      const instrArr = r['w:instrText'];
      const instr = Array.isArray(instrArr) ? instrArr[0] : instrArr;
      const txt = instr && instr['#text'];
      if (txt && /ADDIN ZOTERO_ITEM/.test(String(txt))) {
        count++;
      }
    }
  }
  return count;
}

export function countMaxId({ doc }) {
  let max = 0;
  const wp = getArray(doc['w:document']['w:body']['w:p']);
  for (const p of wp) {
    const runs = getArray(p['w:r']);
    for (const r of runs) {
      const instrArr = r['w:instrText'];
      const instr = Array.isArray(instrArr) ? instrArr[0] : instrArr;
      const txt = instr && instr['#text'];
      if (txt && /ADDIN ZOTERO_ITEM/.test(String(txt))) {
        const m = String(txt).match(/"citationItems"\s*:\s*\[\s*\{\s*"id"\s*:\s*(\d+)/);
        if (m) {
          const id = Number.parseInt(m[1], 10);
          if (!Number.isNaN(id) && id > max) max = id;
        }
      }
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Construcción de campos
// ---------------------------------------------------------------------------

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
  const citationItem = { id: itemData.id, uris };
  if (itemData) citationItem.itemData = itemData;
  if (locator) citationItem.locator = String(locator);
  if (label) citationItem.label = label;
  if (prefix) citationItem.prefix = prefix;
  if (suffix) citationItem.suffix = suffix;

  const jsonPayload = JSON.stringify({
    citationID,
    properties: {
      formattedCitation: formattedCitation || plainCitation || '',
      plainCitation: plainCitation || formattedCitation || '',
      noteIndex,
    },
    citationItems: [citationItem],
  });

  const instrText = ` ADDIN ZOTERO_ITEM CSL_CITATION ${jsonPayload}`;

  return [
    {
      'w:fldChar': { '@_w:fldCharType': 'begin' },
    },
    {
      'w:instrText': { '@_xml:space': 'preserve', '#text': instrText },
    },
    {
      'w:fldChar': { '@_w:fldCharType': 'separate' },
    },
    {
      'w:t': { '#text': formattedCitation || plainCitation || '' },
    },
    {
      'w:fldChar': { '@_w:fldCharType': 'end' },
    },
  ];
}

export function buildBibliographyParagraph(styleUrl, bibText) {
  const styleJson = JSON.stringify({
    style: styleUrl,
    fieldType: 'Field',
    hasBibliography: true,
  });
  const instrText = ` ADDIN ZOTERO_BIBL ${styleJson}`;

  // Cada línea de la bibliografía es un run con salto de línea entre medio.
  const bibLines = String(bibText || '').split('\n');
  const textRuns = [];
  for (let i = 0; i < bibLines.length; i++) {
    textRuns.push({ 'w:t': { '#text': bibLines[i] } });
    if (i < bibLines.length - 1) {
      textRuns.push({ 'w:br': {} });
    }
  }

  return {
    'w:pPr': {},
    'w:r': [
      { 'w:fldChar': { '@_w:fldCharType': 'begin' } },
      { 'w:instrText': { '@_xml:space': 'preserve', '#text': instrText } },
      { 'w:fldChar': { '@_w:fldCharType': 'separate' } },
      ...textRuns,
      { 'w:fldChar': { '@_w:fldCharType': 'end' } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Inserción y actualización en el documento
// ---------------------------------------------------------------------------

export function insertCitationAtParagraph(doc, paragraphIndex, runs) {
  const wp = getArray(doc['w:document']['w:body']['w:p']);
  const targetP = wp[paragraphIndex];
  if (!targetP) {
    throw new Error(
      `No existe el párrafo ${paragraphIndex} (el documento tiene ${wp.length} párrafos). Usa zotero_read_docx para ver la estructura.`
    );
  }
  const existingRuns = getArray(targetP['w:r']);
  targetP['w:r'] = [...existingRuns, ...runs];
}

export function findBibliographyField(doc) {
  const wp = getArray(doc['w:document']['w:body']['w:p']);
  for (let i = 0; i < wp.length; i++) {
    const runs = getArray(wp[i]['w:r']);
    for (const r of runs) {
      const instrArr = r['w:instrText'];
      const instr = Array.isArray(instrArr) ? instrArr[0] : instrArr;
      const txt = instr && instr['#text'];
      if (txt && /ADDIN ZOTERO_BIBL/.test(String(txt))) {
        return { paragraphIndex: i };
      }
    }
  }
  return null;
}

export function upsertBibliography(doc, styleUrl, bibText) {
  const bibP = buildBibliographyParagraph(styleUrl, bibText);
  const existing = findBibliographyField(doc);
  const wp = getArray(doc['w:document']['w:body']['w:p']);

  if (existing) {
    wp[existing.paragraphIndex] = bibP;
    doc['w:document']['w:body']['w:p'] = wp;
    return { replaced: true, paragraphIndex: existing.paragraphIndex };
  }

  wp.push(bibP);
  doc['w:document']['w:body']['w:p'] = wp;
  return { replaced: false, added: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArray(val) {
  if (Array.isArray(val)) return val;
  if (val === undefined || val === null) return [];
  return [val];
}

export function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
