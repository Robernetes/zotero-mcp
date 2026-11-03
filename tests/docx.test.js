// docx.test.js — tests del módulo de manipulación OOXML para Zotero.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  loadDocx,
  openDocx,
  saveDocx,
  serializeDocument,
  readParagraphs,
  countExistingCitations,
  countMaxId,
  listCitedItems,
  listDocumentCitations,
  paragraphChildIndex,
  buildCitationRuns,
  insertCitationAtParagraph,
  findBibliographyField,
  upsertBibliography,
  buildBibliographyParagraph,
  hashCode,
} from '../src/docx.js';

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

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

async function load(documentXml) {
  const buffer = await makeDocxZip(documentXml).generateAsync({ type: 'nodebuffer' });
  return loadDocx(buffer);
}

function docXml(bodyXml) {
  return `${DECL}<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`;
}

function citationField(json) {
  return (
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ${json}</w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>(cita)</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  );
}

const SECT = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>';

const BASIC_DOC = docXml(
  '<w:p><w:r><w:t>Primer párrafo.</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Segundo párrafo con texto.</w:t></w:r></w:p>' +
    SECT
);

test('readParagraphs devuelve textos y detecta campos Zotero', async () => {
  const ctx = await load(BASIC_DOC);
  const paragraphs = readParagraphs(ctx);
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].text, 'Primer párrafo.');
  assert.equal(paragraphs[0].hasZoteroField, false);
  assert.equal(paragraphs[1].text, 'Segundo párrafo con texto.');
});

test('readParagraphs conserva texto numérico, entidades e hipervínculos', async () => {
  const ctx = await load(
    docXml(
      '<w:p><w:r><w:t>Código </w:t></w:r><w:r><w:t>007</w:t></w:r>' +
        '<w:hyperlink r:id="rId9"><w:r><w:t> enlace</w:t></w:r></w:hyperlink></w:p>' +
        '<w:p><w:r><w:t>1.50</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">A &amp; B &lt;c&gt; &#x2019;</w:t></w:r></w:p>'
    )
  );
  const paragraphs = readParagraphs(ctx);
  assert.equal(paragraphs[0].text, 'Código 007 enlace');
  assert.equal(paragraphs[1].text, '1.50');
  assert.equal(paragraphs[2].text, 'A & B <c> ’');
});

test('abrir y guardar sin cambios reproduce el document.xml original', async () => {
  const original = docXml(
    '<w:p w:rsidR="00AB12"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Título</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">A </w:t></w:r>' +
      '<w:hyperlink r:id="rId9"><w:r><w:t>enlace</w:t></w:r></w:hyperlink>' +
      '<w:bookmarkStart w:id="0" w:name="m"/><w:r><w:t>B &amp; C &#x2019;</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>007</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:p><w:r><w:t>1.50</w:t></w:r><w:r><w:br/></w:r></w:p>' +
      SECT
  );
  const ctx = await load(original);
  assert.equal(serializeDocument(ctx.doc).replace(/\?>\s*/, '?>'), original.replace(/\?>\s*/, '?>'));
});

test('saveDocx escribe un .docx que vuelve a abrirse con la cita al final del párrafo', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zotero-docx-'));
  try {
    const file = path.join(dir, 'doc.docx');
    const source = docXml(
      '<w:p><w:r><w:t xml:space="preserve">Antes </w:t></w:r>' +
        '<w:hyperlink r:id="rId9"><w:r><w:t>enlace</w:t></w:r></w:hyperlink></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>celda</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '<w:p><w:r><w:t>Después</w:t></w:r></w:p>' +
        SECT
    );
    const zip = makeDocxZip(source);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));

    const ctx = await openDocx(file);
    const runs = buildCitationRuns({
      citationID: 'CITE-1',
      noteIndex: 1,
      formattedCitation: '(Smith & Jones, 2020)',
      plainCitation: '(Smith & Jones, 2020)',
      uris: ['http://zotero.org/users/0/items/ABC12345'],
      itemData: { id: 1, type: 'book', title: 'A & B' },
    });
    insertCitationAtParagraph(ctx.doc, 0, runs);
    await saveDocx(ctx, file);

    const reopened = await openDocx(file);
    const xml = serializeDocument(reopened.doc);
    // Orden intacto: hipervínculo → cita → tabla → párrafo siguiente → sectPr.
    const order = ['<w:hyperlink', 'ADDIN ZOTERO_ITEM', '<w:tbl>', 'Después', '<w:sectPr>'].map((s) =>
      xml.indexOf(s)
    );
    assert.ok(order.every((pos) => pos >= 0), `faltan elementos: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'el orden del documento cambió');
    // El & se escapa una sola vez.
    assert.ok(xml.includes('<w:t xml:space="preserve">(Smith &amp; Jones, 2020)</w:t>'));
    assert.ok(!xml.includes('&amp;amp;') && !xml.includes('&amp;#'));

    const paragraphs = readParagraphs(reopened);
    assert.equal(paragraphs[0].text, 'Antes enlace(Smith & Jones, 2020)');
    assert.equal(paragraphs[0].hasZoteroField, true);
    assert.equal(countExistingCitations(reopened), 1);
    assert.deepEqual(listCitedItems(reopened.doc), [
      { key: 'ABC12345', itemData: { id: 1, type: 'book', title: 'A & B' } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCitationRuns produce runs con el JSON correcto', () => {
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
  const xml = serializeDocument([{ 'w:document': [{ 'w:body': [{ 'w:p': runs }] }] }]);
  const types = [...xml.matchAll(/w:fldCharType="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(types, ['begin', 'separate', 'end']);
  assert.ok(xml.includes('<w:t xml:space="preserve">(Smith, 2020, p. 42)</w:t>'));

  const instr = xml.match(/<w:instrText xml:space="preserve">([^<]*)<\/w:instrText>/)[1];
  assert.ok(instr.startsWith(' ADDIN ZOTERO_ITEM CSL_CITATION '));
  const json = JSON.parse(instr.replace(' ADDIN ZOTERO_ITEM CSL_CITATION ', ''));
  assert.equal(json.citationID, 'CITE-1');
  assert.equal(json.properties.noteIndex, 1);
  assert.equal(json.citationItems.length, 1);
  assert.equal(json.citationItems[0].locator, '42');
  assert.equal(json.citationItems[0].uris[0], 'http://zotero.org/users/0/items/ABC12345');
  assert.equal(json.citationItems[0].itemData.id, 12345);
});

test('insertCitationAtParagraph lanza si el índice no existe', async () => {
  const ctx = await load(BASIC_DOC);
  assert.throws(() => insertCitationAtParagraph(ctx.doc, 99, []), /No existe el párrafo 99/);
});

test('findBibliographyField encuentra o no el campo BIBL', async () => {
  const withBib = await load(
    docXml(
      '<w:p><w:r><w:t>Texto.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL {"style":"http://www.zotero.org/styles/apa","fieldType":"Field","hasBibliography":true}</w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
  );
  assert.equal(findBibliographyField(withBib.doc).paragraphIndex, 1);

  const withoutBib = await load(BASIC_DOC);
  assert.equal(findBibliographyField(withoutBib.doc), null);
});

test('upsertBibliography añade antes de w:sectPr y luego reemplaza', async () => {
  const ctx = await load(BASIC_DOC);

  const res = upsertBibliography(ctx.doc, 'http://www.zotero.org/styles/apa', 'Smith, J. (2020).');
  assert.equal(res.added, true);
  assert.equal(res.paragraphIndex, 2);
  let xml = serializeDocument(ctx.doc);
  assert.ok(xml.indexOf('ADDIN ZOTERO_BIBL') < xml.indexOf('<w:sectPr>'), 'la bibliografía debe ir antes de w:sectPr');
  assert.ok(findBibliographyField(ctx.doc));

  const res2 = upsertBibliography(ctx.doc, 'http://www.zotero.org/styles/mla', 'New Bib');
  assert.equal(res2.replaced, true);
  xml = serializeDocument(ctx.doc);
  assert.equal(xml.match(/ADDIN ZOTERO_BIBL/g).length, 1);
  assert.ok(xml.includes('New Bib') && !xml.includes('Smith, J. (2020).'));
  assert.equal(readParagraphs(ctx).length, 3);
});

test('upsertBibliography reemplaza una bibliografía que abarca varios párrafos', async () => {
  const ctx = await load(
    docXml(
      '<w:p><w:r><w:t>Texto.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL {"uncited":[]} CSL_BIBLIOGRAPHY</w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Ref 1</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Ref 2</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
        '<w:p><w:r><w:t>Anexo</w:t></w:r></w:p>' +
        SECT
    )
  );
  const res = upsertBibliography(ctx.doc, 'http://www.zotero.org/styles/apa', 'Nueva');
  assert.equal(res.replaced, true);
  assert.deepEqual(
    readParagraphs(ctx).map((p) => p.text),
    ['Texto.', 'Nueva', 'Anexo']
  );
});

test('countExistingCitations y countMaxId leen campos partidos en varios instrText', async () => {
  const ctx = await load(
    docXml(
      '<w:p><w:r><w:t>Antes.</w:t></w:r></w:p>' +
        `<w:p>${citationField('{"citationID":"a","citationItems":[{"id":7,"uris":["http://zotero.org/users/0/items/AAAA1111"]}]}')}</w:p>` +
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"b","citationItems":[{"id":3,</w:instrText></w:r>' +
        '<w:r><w:instrText xml:space="preserve">"uris":["http://zotero.org/users/local/x/items/BBBB2222"],"itemData":{"id":3,"title":"B"}}]}</w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>(B)</w:t></w:r>' +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
  );
  assert.equal(countExistingCitations(ctx), 2);
  assert.equal(countMaxId(ctx), 7);
  assert.deepEqual(listCitedItems(ctx.doc), [
    { key: 'AAAA1111', itemData: null },
    { key: 'BBBB2222', itemData: { id: 3, title: 'B' } },
  ]);
});

test('buildBibliographyParagraph construye el campo correcto', () => {
  const p = buildBibliographyParagraph('http://www.zotero.org/styles/apa', 'Smith, J. (2020).');
  const xml = serializeDocument([{ 'w:document': [{ 'w:body': [p] }] }]);
  const instr = xml.match(/<w:instrText xml:space="preserve">([^<]*)<\/w:instrText>/)[1];
  assert.ok(instr.startsWith(' ADDIN ZOTERO_BIBL '));
  const json = JSON.parse(instr.replace(' ADDIN ZOTERO_BIBL ', ''));
  assert.equal(json.style, 'http://www.zotero.org/styles/apa');
  assert.ok(xml.includes('Smith, J. (2020).'));
});

test('loadDocx rechaza un zip sin word/document.xml', async () => {
  const zip = new JSZip();
  zip.file('otro.xml', '<a/>');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => loadDocx(buffer), /falta word\/document.xml/);
});

test('hashCode produce enteros no negativos', () => {
  const h = hashCode('ABC12345');
  assert.ok(Number.isInteger(h));
  assert.ok(h >= 0);
  assert.equal(hashCode('ABC12345'), hashCode('ABC12345'));
});

test('listDocumentCitations agrupa por campo con posición y localizador', async () => {
  const ctx = await load(
    docXml(
      `<w:p>${citationField('{"citationID":"a","citationItems":[{"id":1,"uris":["http://zotero.org/users/0/items/AAAA1111"],"locator":"12","label":"page"},{"id":2,"uris":["http://zotero.org/users/0/items/BBBB2222"]}]}')}</w:p>` +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>tabla</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '<w:p><w:r><w:t>Sin citas.</w:t></w:r></w:p>' +
        `<w:p>${citationField('{"citationID":"b","citationItems":[{"id":3,"itemData":{"id":3,"title":"C"}}]}')}</w:p>`
    )
  );
  const citations = listDocumentCitations(ctx.doc);
  assert.deepEqual(citations, [
    {
      startChild: 0,
      items: [
        { key: 'AAAA1111', itemData: null, locator: '12', label: 'page' },
        { key: 'BBBB2222', itemData: null },
      ],
    },
    { startChild: 3, items: [{ key: null, itemData: { id: 3, title: 'C' } }] },
  ]);
  // Párrafos de primer nivel: 0 → hijo 0, 1 → hijo 2 (la tabla es el hijo 1), 2 → hijo 3.
  assert.equal(paragraphChildIndex(ctx.doc, 1), 2);
  assert.equal(paragraphChildIndex(ctx.doc, 2), 3);
  assert.equal(paragraphChildIndex(ctx.doc, 9), -1);
});
