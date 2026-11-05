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
  locateCitation,
  insertCitationAt,
  removeCitations,
  removeBibliography,
  describeParagraphs,
  findBibliographyField,
  upsertBibliography,
  buildBibliographyParagraphs,
  readDocumentPrefs,
  ensureDocumentPrefs,
  buildDocxBuffer,
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
    insertCitationAt(ctx.doc, locateCitation(ctx.doc, { paragraphIndex: 0 }), runs);
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
    assert.equal(paragraphs[0].text, 'Antes enlace (Smith & Jones, 2020)');
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
  assert.ok(instr.endsWith('} '), 'el código termina con espacio, como el del plugin');
  const json = JSON.parse(instr.replace(' ADDIN ZOTERO_ITEM CSL_CITATION ', ''));
  assert.equal(json.citationID, 'CITE-1');
  assert.equal(json.properties.noteIndex, 1);
  assert.equal(json.citationItems.length, 1);
  assert.equal(json.citationItems[0].locator, '42');
  assert.equal(json.citationItems[0].uris[0], 'http://zotero.org/users/0/items/ABC12345');
  assert.equal(json.citationItems[0].itemData.id, 12345);
  assert.equal(json.schema, 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json');
});

test('insertCitationAt lanza si el índice no existe', async () => {
  const ctx = await load(BASIC_DOC);
  assert.throws(() => insertCitationAt(ctx.doc, { paragraphIndex: 99, pos: 0 }, []), /No existe el párrafo 99/);
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

  const res = upsertBibliography(ctx.doc, ['Smith, J. (2020).']);
  assert.equal(res.added, true);
  assert.equal(res.paragraphIndex, 2);
  let xml = serializeDocument(ctx.doc);
  assert.ok(xml.indexOf('ADDIN ZOTERO_BIBL') < xml.indexOf('<w:sectPr>'), 'la bibliografía debe ir antes de w:sectPr');
  assert.ok(findBibliographyField(ctx.doc));

  const res2 = upsertBibliography(ctx.doc, ['New Bib']);
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
  const res = upsertBibliography(ctx.doc, ['Nueva 1', 'Nueva 2', 'Nueva 3'], { pStyle: 'Bibliography' });
  assert.equal(res.replaced, true);
  assert.deepEqual(
    readParagraphs(ctx).map((p) => p.text),
    ['Texto.', 'Nueva 1', 'Nueva 2', 'Nueva 3', 'Anexo']
  );
  // El campo sigue siendo uno solo y abarca los tres párrafos.
  const field = findBibliographyField(ctx.doc);
  assert.equal(field.paragraphIndex, 1);
  assert.equal(field.endParagraphIndex, 3);
  assert.equal(serializeDocument(ctx.doc).match(/w:pStyle w:val="Bibliography"/g).length, 3);
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

test('buildBibliographyParagraphs usa el formato del plugin: un párrafo por referencia', () => {
  const ps = buildBibliographyParagraphs(['Smith, J. (2020).', 'García, A. (2019).']);
  assert.equal(ps.length, 2);
  const xml = serializeDocument([{ 'w:document': [{ 'w:body': ps }] }]);
  const instr = xml.match(/<w:instrText xml:space="preserve">([^<]*)<\/w:instrText>/)[1];
  assert.equal(instr, ' ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY ');
  // begin/separate en el primer párrafo, end en el último.
  const [first, second] = xml.split('</w:p>');
  assert.match(first, /fldCharType="begin".*fldCharType="separate".*Smith/);
  assert.ok(!first.includes('fldCharType="end"'));
  assert.match(second, /García.*fldCharType="end"/);
  assert.ok(!xml.includes('w:pStyle'), 'sin pStyle si no se pide');
});

test('loadDocx rechaza un zip sin word/document.xml', async () => {
  const zip = new JSZip();
  zip.file('otro.xml', '<a/>');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => loadDocx(buffer), /falta word\/document.xml/);
});

test('ensureDocumentPrefs crea ZOTERO_PREF_n en trozos de 255 y registra custom.xml', async () => {
  const ctx = await load(BASIC_DOC);
  assert.equal(await readDocumentPrefs(ctx), null);

  const res = await ensureDocumentPrefs(ctx, { styleID: 'http://www.zotero.org/styles/ieee', locale: 'es-ES' });
  assert.equal(res.created, true);
  assert.equal(res.prefs.styleID, 'http://www.zotero.org/styles/ieee');
  assert.equal(res.prefs.locale, 'es-ES');
  assert.equal(res.prefs.fieldType, 'Field');
  assert.match(res.prefs.raw, /^<data data-version="3" zotero-version="[^"]+"><session id="\w{8}"\/><style id="http:\/\/www\.zotero\.org\/styles\/ieee" locale="es-ES" hasBibliography="1" bibliographyStyleHasBeenSet="0"\/><prefs><pref name="fieldType" value="Field"\/><\/prefs><\/data>$/);

  // Se guarda y se vuelve a abrir: custom.xml, content type y relación presentes.
  const reopened = await loadDocx(await buildDocxBuffer(ctx));
  const custom = await reopened.zip.file('docProps/custom.xml').async('string');
  assert.match(custom, /pid="2" name="ZOTERO_PREF_1"/);
  assert.ok((await reopened.zip.file('[Content_Types].xml').async('string')).includes('PartName="/docProps/custom.xml"'));
  assert.ok((await reopened.zip.file('_rels/.rels').async('string')).includes('Target="docProps/custom.xml"'));
  assert.deepEqual(await readDocumentPrefs(reopened), res.prefs);
});

test('ensureDocumentPrefs parte las preferencias largas en propiedades de 255 caracteres', async () => {
  const ctx = await load(BASIC_DOC);
  const styleID = `http://www.zotero.org/styles/${'x'.repeat(150)}`;
  const res = await ensureDocumentPrefs(ctx, { styleID, locale: 'es-ES' });
  const custom = await ctx.zip.file('docProps/custom.xml').async('string');
  const props = [...custom.matchAll(/pid="(\d+)" name="(ZOTERO_PREF_\d+)"><vt:lpwstr>([^<]*)</g)];
  assert.deepEqual(props.map((p) => [p[1], p[2]]), [['2', 'ZOTERO_PREF_1'], ['3', 'ZOTERO_PREF_2']]);
  const decoded = props.map((p) => p[3].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  assert.equal(decoded[0].length, 255);
  assert.equal(decoded.join(''), res.prefs.raw);
  assert.equal(res.prefs.styleID, styleID);
});

test('ensureDocumentPrefs no pisa las preferencias que ya puso el plugin', async () => {
  const zip = makeDocxZip(BASIC_DOC);
  const pluginPrefs =
    '&lt;data data-version="3" zotero-version="8.0.3"&gt;&lt;session id="6uaDJTTz"/&gt;&lt;style id="http://www.zotero.org/styles/apa" locale="en-US" hasBibliography="1" bibliographyStyleHasBeenSet="1"/&gt;&lt;prefs&gt;&lt;pref name="fieldType" value="Field"/&gt;&lt;/prefs&gt;&lt;/data&gt;';
  zip.file(
    'docProps/custom.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ZOTERO_PREF_1"><vt:lpwstr>${pluginPrefs}</vt:lpwstr></property></Properties>`
  );
  const ctx = await loadDocx(await zip.generateAsync({ type: 'nodebuffer' }));
  const res = await ensureDocumentPrefs(ctx, { styleID: 'http://www.zotero.org/styles/ieee', locale: 'es-ES' });
  assert.equal(res.created, false);
  assert.equal(res.prefs.styleID, 'http://www.zotero.org/styles/apa');
  assert.equal(res.prefs.sessionID, '6uaDJTTz');
  assert.equal(res.prefs.locale, 'en-US');
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
      citationID: 'a',
      items: [
        { key: 'AAAA1111', itemData: null, locator: '12', label: 'page' },
        { key: 'BBBB2222', itemData: null },
      ],
    },
    { startChild: 3, citationID: 'b', items: [{ key: null, itemData: { id: 3, title: 'C' } }] },
  ]);
  // Párrafos de primer nivel: 0 → hijo 0, 1 → hijo 2 (la tabla es el hijo 1), 2 → hijo 3.
  assert.equal(paragraphChildIndex(ctx.doc, 1), 2);
  assert.equal(paragraphChildIndex(ctx.doc, 2), 3);
  assert.equal(paragraphChildIndex(ctx.doc, 9), -1);
});

// --- Posición de la cita: afterText, puntuación y espacios -------------------

/** Inserta una cita con el texto `visible` y devuelve el texto de los párrafos. */
function citeAt(ctx, opts, visible = '(A, 1990)') {
  const loc = locateCitation(ctx.doc, opts);
  const runs = buildCitationRuns({
    citationID: 'X',
    noteIndex: 0,
    formattedCitation: visible,
    plainCitation: visible,
    uris: ['http://zotero.org/users/0/items/KEY00001'],
    itemData: { id: 1, type: 'book', title: 'T' },
  });
  insertCitationAt(ctx.doc, loc, runs);
  return { loc, texts: readParagraphs(ctx).map((p) => p.text) };
}

const TWO_SENTENCES = docXml(
  '<w:p><w:r><w:t>Intro.</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">La ingeniería inversa es clave. Se usa en firmware y binarios.</w:t></w:r></w:p>' +
    SECT
);

test('la cita va tras afterText, antes del punto y con espacio', async () => {
  const ctx = await load(TWO_SENTENCES);
  const { loc, texts } = citeAt(ctx, { afterText: 'La ingeniería inversa es clave.' });
  assert.equal(loc.paragraphIndex, 1, 'sin paragraphIndex busca en todo el documento');
  assert.equal(loc.beforePunctuation, true);
  assert.equal(texts[1], 'La ingeniería inversa es clave (A, 1990). Se usa en firmware y binarios.');
  // El run partido y el espacio conservan el formato (negrita).
  const xml = serializeDocument(ctx.doc);
  assert.equal((xml.match(/<w:b\/>/g) || []).length, 3, 'izquierda, espacio y derecha en negrita');
});

test('sin afterText la cita va al final del párrafo, antes del punto final', async () => {
  const ctx = await load(TWO_SENTENCES);
  const { texts } = citeAt(ctx, { paragraphIndex: 1 });
  assert.equal(texts[1], 'La ingeniería inversa es clave. Se usa en firmware y binarios (A, 1990).');
  const { texts: again } = citeAt(ctx, { paragraphIndex: 1 }, '(B, 2021)');
  assert.equal(again[1], 'La ingeniería inversa es clave. Se usa en firmware y binarios (A, 1990) (B, 2021).');
});

test('afterText a mitad de frase separa la cita por los dos lados', async () => {
  const ctx = await load(docXml('<w:p><w:r><w:t>Según Chikofsky la idea cambió.</w:t></w:r></w:p>' + SECT));
  const { texts } = citeAt(ctx, { afterText: 'Según Chikofsky' });
  assert.equal(texts[0], 'Según Chikofsky (A, 1990) la idea cambió.');
});

test('afterText tolera espacios repetidos, comillas tipográficas y guiones', async () => {
  const ctx = await load(docXml('<w:p><w:r><w:t xml:space="preserve">El término “ingeniería  inversa” —dice— es amplio.</w:t></w:r></w:p>' + SECT));
  const { texts } = citeAt(ctx, { afterText: 'El término "ingeniería inversa" -dice-' });
  assert.equal(texts[0], 'El término “ingeniería  inversa” —dice— (A, 1990) es amplio.');
});

test('afterText que no está o se repite da un error claro', async () => {
  const ctx = await load(docXml('<w:p><w:r><w:t>Uno. Uno.</w:t></w:r></w:p><w:p><w:r><w:t>Dos.</w:t></w:r></w:p>' + SECT));
  assert.throws(() => locateCitation(ctx.doc, { afterText: 'Tres' }), /No se encontró el texto "Tres" en el documento/);
  assert.throws(() => locateCitation(ctx.doc, { afterText: 'Dos', paragraphIndex: 0 }), /en el párrafo 0/);
  assert.throws(() => locateCitation(ctx.doc, { afterText: 'Uno' }), /aparece 2 veces/);
  assert.throws(() => locateCitation(ctx.doc, { paragraphIndex: 9 }), /No existe el párrafo 9/);
  assert.throws(() => locateCitation(ctx.doc, {}), /Indica paragraphIndex o afterText/);
});

test('no parte hipervínculos ni campos: la cita va detrás y cuenta las citas previas', async () => {
  const ctx = await load(
    docXml(
      '<w:p><w:r><w:t xml:space="preserve">Ver </w:t></w:r>' +
        '<w:hyperlink r:id="rId9"><w:r><w:t>el sitio web</w:t></w:r></w:hyperlink>' +
        '<w:r><w:t xml:space="preserve"> y la fuente </w:t></w:r>' +
        citationField('{"citationItems":[{"id":1,"uris":["http://zotero.org/users/0/items/OLD00001"]}]}') +
        '<w:r><w:t>.</w:t></w:r></w:p>' +
        SECT
    )
  );
  const first = citeAt(ctx, { afterText: 'Ver el sitio' });
  assert.equal(first.loc.citationsBefore, 0);
  assert.equal(first.texts[0], 'Ver el sitio web (A, 1990) y la fuente (cita).');
  const second = citeAt(ctx, { paragraphIndex: 0 }, '(B, 2021)');
  assert.equal(second.loc.citationsBefore, 2, 'la cita existente y la recién insertada quedan antes');
  assert.equal(second.texts[0], 'Ver el sitio web (A, 1990) y la fuente (cita) (B, 2021).');
});

test('buildCitationRuns agrupa varias fuentes en una sola cita', () => {
  const runs = buildCitationRuns({
    citationID: 'G',
    noteIndex: 0,
    formattedCitation: '(A, 1990; B, 2021)',
    items: [
      { itemData: { id: 1, type: 'book' }, uris: ['http://zotero.org/users/0/items/AAA'], prefix: 'véase' },
      { itemData: { id: 2, type: 'book' }, uris: ['http://zotero.org/users/0/items/BBB'] },
    ],
  });
  const xml = serializeDocument([{ 'w:document': [{ 'w:body': [{ 'w:p': runs }] }] }]);
  const instr = xml.match(/<w:instrText xml:space="preserve">([^<]*)<\/w:instrText>/)[1];
  const json = JSON.parse(instr.replace(' ADDIN ZOTERO_ITEM CSL_CITATION ', ''));
  assert.deepEqual(json.citationItems.map((c) => c.id), [1, 2]);
  assert.equal(json.citationItems[0].prefix, 'véase');
  assert.equal(json.citationItems[1].uris[0], 'http://zotero.org/users/0/items/BBB');
});

// --- Quitar citas y bibliografía ----------------------------------------------

/** Runs de una cita con las fuentes `keys` (ids 1, 2…) y el texto visible indicado. */
function groupedRuns(citationID, keys, visible) {
  return buildCitationRuns({
    citationID,
    noteIndex: 0,
    formattedCitation: visible,
    items: keys.map((k, i) => ({ itemData: { id: i + 1, type: 'book', title: k }, uris: [`http://zotero.org/users/0/items/${k}`] })),
  });
}

test('removeCitations quita todas las citas y deja el texto y el formato como estaban', async () => {
  const original = docXml(
    '<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Según Chikofsky la idea cambió. Hoy se aplica a binarios.</w:t></w:r></w:p>' + SECT
  );
  const ctx = await load(original);
  const before = readParagraphs(ctx)[0].text;
  insertCitationAt(ctx.doc, locateCitation(ctx.doc, { afterText: 'Según Chikofsky' }), groupedRuns('c1', ['AAA'], '(A, 1990)'));
  insertCitationAt(ctx.doc, locateCitation(ctx.doc, { afterText: 'a binarios.' }), groupedRuns('c2', ['BBB', 'CCC'], '(B, 2020; C, 2021)'));
  assert.equal(readParagraphs(ctx)[0].text, 'Según Chikofsky (A, 1990) la idea cambió. Hoy se aplica a binarios (B, 2020; C, 2021).');

  const res = removeCitations(ctx.doc);
  assert.deepEqual([res.removedCitations, res.removedSources, res.updatedCitations], [2, 3, 0]);
  assert.equal(readParagraphs(ctx)[0].text, before);
  assert.deepEqual(describeParagraphs(ctx.doc, res.paragraphs), [{ index: 0, text: before }]);
  const xml = serializeDocument(ctx.doc);
  assert.ok(xml.includes('<w:jc w:val="both"/>'), 'conserva la justificación');
  assert.ok(!xml.includes('ZOTERO_ITEM'));
  assert.equal((xml.match(/<w:b\/>/g) || []).length, (xml.match(/<w:r>/g) || []).length, 'todos los runs siguen en negrita');
});

test('removeCitations con keys quita solo esas fuentes y reescribe la cita agrupada', async () => {
  const ctx = await load(docXml('<w:p><w:r><w:t>Uno. Dos.</w:t></w:r></w:p>' + SECT));
  insertCitationAt(ctx.doc, locateCitation(ctx.doc, { afterText: 'Uno.' }), groupedRuns('c1', ['AAA'], '(A, 1990)'));
  insertCitationAt(ctx.doc, locateCitation(ctx.doc, { afterText: 'Dos.' }), groupedRuns('c2', ['AAA', 'BBB'], '(A, 1990; B, 2020)'));

  const res = removeCitations(ctx.doc, { keys: ['AAA'], texts: new Map([['c2', '(B, 2020)']]) });
  assert.deepEqual([res.removedCitations, res.removedSources, res.updatedCitations], [1, 2, 1]);
  assert.equal(readParagraphs(ctx)[0].text, 'Uno. Dos (B, 2020).');
  const [left] = listDocumentCitations(ctx.doc);
  assert.equal(left.citationID, 'c2');
  assert.deepEqual(left.items.map((i) => i.key), ['BBB']);

  const none = removeCitations(ctx.doc, { keys: ['ZZZ'] });
  assert.equal(none.removedSources, 0, 'una key que no está no cambia nada');
});

test('removeBibliography quita el campo y sus párrafos', async () => {
  const ctx = await load(BASIC_DOC);
  assert.equal(removeBibliography(ctx.doc), null);
  upsertBibliography(ctx.doc, ['Ref 1', 'Ref 2']);
  const count = readParagraphs(ctx).length;
  const removed = removeBibliography(ctx.doc);
  assert.equal(removed.paragraphs, count - 2);
  assert.equal(findBibliographyField(ctx.doc), null);
  assert.deepEqual(readParagraphs(ctx).map((p) => p.text), ['Primer párrafo.', 'Segundo párrafo con texto.']);
  assert.ok(serializeDocument(ctx.doc).includes('<w:sectPr>'), 'conserva la sección');
});
