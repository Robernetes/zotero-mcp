// docx.test.js — tests del módulo de manipulación OOXML para Zotero.
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  openDocx,
  readParagraphs,
  countExistingCitations,
  countMaxId,
  buildCitationRuns,
  insertCitationAtParagraph,
  findBibliographyField,
  upsertBibliography,
  buildBibliographyParagraph,
  hashCode,
} from '../src/docx.js';

// Construye un .docx mínimo en memoria para los tests.
function makeDocxZip(documentXml) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '</Relationships>'
  );
  zip.file('word/document.xml', documentXml);
  return zip;
}

const BASIC_DOC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Primer párrafo.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Segundo párrafo con texto.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

test('readParagraphs devuelve textos y detecta campos Zotero', async () => {
  const zip = makeDocxZip(BASIC_DOC);
  const ctx = { zip, doc: null };
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  ctx.zip = await JSZip.loadAsync(buffer);
  ctx.doc = await ctx.zip.file('word/document.xml').async('string');
  // Necesitamos parsear como hace openDocx
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: false,
    isArray: (name) => ['w:p', 'w:r', 'w:t', 'w:fldChar', 'w:instrText', 'w:br'].includes(name),
  });
  ctx.doc = parser.parse(ctx.doc);

  const paragraphs = readParagraphs(ctx);
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].text, 'Primer párrafo.');
  assert.equal(paragraphs[0].hasZoteroField, false);
  assert.equal(paragraphs[1].text, 'Segundo párrafo con texto.');
});

test('buildCitationRuns produce XML con el JSON correcto', () => {
  const runs = buildCitationRuns({
    citationID: 'CITE-1',
    noteIndex: 1,
    formattedCitation: '(Smith, 2020, p. 42)',
    plainCitation: '(Smith, 2020, p. 42)',
    uris: ['http://zotero.org/users/0/items/ABC12345'],
    itemData: { id: 12345, type: 'article-journal', title: 'Test' },
    locator: '42',
    label: 'page',
  });

  assert.equal(runs.length, 5);
  assert.equal(runs[0]['w:fldChar']['@_w:fldCharType'], 'begin');
  assert.ok(String(runs[1]['w:instrText']['#text']).startsWith(' ADDIN ZOTERO_ITEM CSL_CITATION '));
  assert.equal(runs[2]['w:fldChar']['@_w:fldCharType'], 'separate');
  assert.equal(runs[3]['w:t']['#text'], '(Smith, 2020, p. 42)');
  assert.equal(runs[4]['w:fldChar']['@_w:fldCharType'], 'end');

  const json = JSON.parse(String(runs[1]['w:instrText']['#text']).replace(' ADDIN ZOTERO_ITEM CSL_CITATION ', ''));
  assert.equal(json.citationID, 'CITE-1');
  assert.equal(json.properties.noteIndex, 1);
  assert.equal(json.citationItems.length, 1);
  assert.equal(json.citationItems[0].locator, '42');
  assert.equal(json.citationItems[0].uris[0], 'http://zotero.org/users/0/items/ABC12345');
  assert.equal(json.citationItems[0].itemData.id, 12345);
});

test('insertCitationAtParagraph agrega runs al párrafo correcto', async () => {
  const zip = makeDocxZip(BASIC_DOC);
  const ctx = { zip, doc: null };
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  ctx.zip = await JSZip.loadAsync(buffer);
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: false,
    isArray: (name) => ['w:p', 'w:r', 'w:t', 'w:fldChar', 'w:instrText', 'w:br'].includes(name),
  });
  ctx.doc = parser.parse(await ctx.zip.file('word/document.xml').async('string'));

  const runs = buildCitationRuns({
    citationID: 'CITE-1',
    noteIndex: 1,
    formattedCitation: '(Test)',
    plainCitation: '(Test)',
    uris: ['http://zotero.org/users/0/items/KEY'],
    itemData: { id: 1, type: 'book', title: 'X' },
  });

  insertCitationAtParagraph(ctx.doc, 0, runs);

  const p = ctx.doc['w:document']['w:body']['w:p'][0];
  const allRuns = p['w:r'];
  assert.ok(allRuns.length > runs.length);
  // El último run debería ser el end field char.
  const lastRun = allRuns[allRuns.length - 1];
  assert.equal(lastRun['w:fldChar']['@_w:fldCharType'], 'end');
});

test('insertCitationAtParagraph lanza si el índice no existe', async () => {
  const zip = makeDocxZip(BASIC_DOC);
  const ctx = { zip, doc: null };
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  ctx.zip = await JSZip.loadAsync(buffer);
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: false,
    isArray: (name) => ['w:p', 'w:r', 'w:t', 'w:fldChar', 'w:instrText', 'w:br'].includes(name),
  });
  ctx.doc = parser.parse(await ctx.zip.file('word/document.xml').async('string'));

  assert.throws(() => insertCitationAtParagraph(ctx.doc, 99, []), /No existe el párrafo 99/);
});

test('findBibliographyField encuentra o no el campo BIBL', async () => {
  const docWithBib = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Texto.</w:t></w:r></w:p>
    <w:p>
      <w:r><w:fldChar w:fldCharType="begin"/></w:r>
      <w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL {"style":"http://www.zotero.org/styles/apa","fieldType":"Field","hasBibliography":true}</w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="separate"/></w:r>
      <w:r><w:fldChar w:fldCharType="end"/></w:r>
    </w:p>
  </w:body>
</w:document>`;

  const zip = makeDocxZip(docWithBib);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const loaded = await JSZip.loadAsync(buffer);
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: false,
    isArray: (name) => ['w:p', 'w:r', 'w:t', 'w:fldChar', 'w:instrText', 'w:br'].includes(name),
  });
  const doc = parser.parse(await loaded.file('word/document.xml').async('string'));

  const found = findBibliographyField(doc);
  assert.equal(found.paragraphIndex, 1);

  // Documento sin campo bibl
  const zip2 = makeDocxZip(BASIC_DOC);
  const buffer2 = await zip2.generateAsync({ type: 'nodebuffer' });
  const loaded2 = await JSZip.loadAsync(buffer2);
  const doc2 = parser.parse(await loaded2.file('word/document.xml').async('string'));
  assert.equal(findBibliographyField(doc2), null);
});

test('upsertBibliography actualiza si existe y añade si no', async () => {
  const zip = makeDocxZip(BASIC_DOC);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const loaded = await JSZip.loadAsync(buffer);
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: false,
    isArray: (name) => ['w:p', 'w:r', 'w:t', 'w:fldChar', 'w:instrText', 'w:br'].includes(name),
  });
  const doc = parser.parse(await loaded.file('word/document.xml').async('string'));

  // No existe → añade
  const res = upsertBibliography(doc, 'http://www.zotero.org/styles/apa', 'Smith, J. (2020).');
  assert.equal(res.added, true);
  const wp = doc['w:document']['w:body']['w:p'];
  assert.ok(wp.length > 2); // nuevo párrafo añadido

  const found = findBibliographyField(doc);
  assert.ok(found);

  // Ya existe → actualiza
  const res2 = upsertBibliography(doc, 'http://www.zotero.org/styles/mla', 'New Bib');
  assert.equal(res2.replaced, true);
});

test('countExistingCitations cuenta campos ADDIN ZOTERO_ITEM', async () => {
  const docWithCite = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Antes.</w:t></w:r></w:p>
    <w:p>
      <w:r><w:fldChar w:fldCharType="begin"/></w:r>
      <w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"a"}</w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="separate"/></w:r>
      <w:r><w:fldChar w:fldCharType="end"/></w:r>
    </w:p>
    <w:p>
      <w:r><w:fldChar w:fldCharType="begin"/></w:r>
      <w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"b"}</w:instrText></w:r>
      <w:r><w:fldChar w:fldCharType="separate"/></w:r>
      <w:r><w:fldChar w:fldCharType="end"/></w:r>
    </w:p>
  </w:body>
</w:document>`;

  const zip = makeDocxZip(docWithCite);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const loaded = await JSZip.loadAsync(buffer);
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: false,
    isArray: (name) => ['w:p', 'w:r', 'w:t', 'w:fldChar', 'w:instrText', 'w:br'].includes(name),
  });
  const doc = parser.parse(await loaded.file('word/document.xml').async('string'));

  assert.equal(countExistingCitations({ doc }), 2);
  assert.equal(countMaxId({ doc }), 0); // no hay "id" en estos JSON simplificados
});

test('buildBibliographyParagraph construye el campo correcto', () => {
  const p = buildBibliographyParagraph('http://www.zotero.org/styles/apa', 'Smith, J. (2020).');
  const runs = p['w:r'];
  assert.ok(runs.length >= 4);
  assert.equal(runs[0]['w:fldChar']['@_w:fldCharType'], 'begin');
  const instr = String(runs[1]['w:instrText']['#text']);
  assert.ok(instr.startsWith(' ADDIN ZOTERO_BIBL '));
  const json = JSON.parse(instr.replace(' ADDIN ZOTERO_BIBL ', ''));
  assert.equal(json.style, 'http://www.zotero.org/styles/apa');
});

test('hashCode produce enteros no negativos', () => {
  const h = hashCode('ABC12345');
  assert.ok(Number.isInteger(h));
  assert.ok(h >= 0);
  assert.equal(hashCode('ABC12345'), hashCode('ABC12345'));
});
