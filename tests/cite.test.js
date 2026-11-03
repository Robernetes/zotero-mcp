import test from 'node:test';
import assert from 'node:assert/strict';
import { CitationManager, STYLES_DIR, LOCALES_DIR } from '../src/cite.js';

const ITEMS = [
  {
    id: 'AAA1',
    type: 'article-journal',
    title: 'Deep learning in medical imaging',
    'container-title': 'Journal of Medicine',
    issued: { 'date-parts': [[2020, 3]] },
    author: [{ family: 'Smith', given: 'John' }],
    volume: '12',
    page: '45-60',
    DOI: '10.1000/xyz',
  },
  {
    id: 'BBB2',
    type: 'book',
    title: 'Metodología de la investigación',
    publisher: 'Editorial Ejemplo',
    issued: { 'date-parts': [[2019]] },
    author: [{ family: 'García', given: 'Ana' }],
  },
];

function makeManager() {
  return new CitationManager({
    fetchItems: async (keys) => ITEMS.filter((i) => keys.includes(i.id)),
    stylesDir: STYLES_DIR,
    localesDir: LOCALES_DIR,
  });
}

test('cita en APA contiene autor y año', async () => {
  const manager = makeManager();
  const res = await manager.cite({ key: 'AAA1', style: 'apa', locale: 'en-US' });
  assert.equal(res.style, 'apa');
  assert.ok(res.citation.includes('Smith'), `cita: ${res.citation}`);
  assert.ok(res.citation.includes('2020'), `cita: ${res.citation}`);
});

test('cita con locator y label de página', async () => {
  const manager = makeManager();
  const res = await manager.cite({
    key: 'AAA1',
    style: 'apa',
    locale: 'en-US',
    locator: '15',
    label: 'page',
  });
  assert.ok(res.citation.includes('15'), `cita: ${res.citation}`);
});

test('bibliografía desde el registro de citas', async () => {
  const manager = makeManager();
  await manager.cite({ key: 'AAA1', style: 'apa', locale: 'en-US' });
  await manager.cite({ key: 'BBB2', style: 'apa', locale: 'en-US' });
  const bib = await manager.bibliography({ style: 'apa', locale: 'en-US' });
  assert.equal(bib.source, 'registro');
  assert.equal(bib.count, 2);
  assert.ok(bib.bibliography.includes('Smith'));
  assert.ok(bib.bibliography.includes('García'));
});

test('estilo numérico (IEEE) asigna números consistentes por orden de cita', async () => {
  const manager = makeManager();
  const c1 = await manager.cite({ key: 'AAA1', style: 'ieee', locale: 'en-US' });
  assert.match(c1.citation, /\[1\]/, `primera cita: ${c1.citation}`);
  const c2 = await manager.cite({ key: 'BBB2', style: 'ieee', locale: 'en-US' });
  assert.match(c2.citation, /\[2\]/, `segunda cita: ${c2.citation}`);
  const c3 = await manager.cite({ key: 'AAA1', style: 'ieee', locale: 'en-US' });
  assert.match(c3.citation, /\[1\]/, `re-cita: ${c3.citation}`);
  const bib = await manager.bibliography({ style: 'ieee', locale: 'en-US' });
  assert.equal(bib.count, 2);
});

test('bibliografía con keys explícitas no altera el registro', async () => {
  const manager = makeManager();
  await manager.cite({ key: 'AAA1', style: 'apa', locale: 'en-US' });
  const bib = await manager.bibliography({ keys: ['BBB2'], style: 'apa', locale: 'en-US' });
  assert.equal(bib.source, 'claves');
  assert.equal(bib.count, 1);
  assert.ok(bib.bibliography.includes('García'));
  // El registro del documento sigue intacto.
  const docBib = await manager.bibliography({ style: 'apa', locale: 'en-US' });
  assert.equal(docBib.count, 1);
  assert.ok(docBib.bibliography.includes('Smith'));
});

test('bibliografía vacía cuando no hay citas', async () => {
  const manager = makeManager();
  const bib = await manager.bibliography({ style: 'apa', locale: 'en-US' });
  assert.equal(bib.count, 0);
  assert.equal(bib.bibliography, '');
});

test('key inexistente produce error claro', async () => {
  const manager = makeManager();
  await assert.rejects(() => manager.cite({ key: 'NOEXISTE' }), /key "NOEXISTE"/);
});

test('estilo no soportado produce error con lista de estilos', async () => {
  const manager = makeManager();
  await assert.rejects(() => manager.cite({ key: 'AAA1', style: 'nope' }), /Estilo no soportado/);
});

test('cambio de estilo reinicia el registro (consistencia numérica)', async () => {
  const manager = makeManager();
  const ieee1 = await manager.cite({ key: 'AAA1', style: 'ieee', locale: 'en-US' });
  assert.match(ieee1.citation, /\[1\]/);
  const ieee2 = await manager.cite({ key: 'BBB2', style: 'vancouver', locale: 'en-US' });
  // Vancouver numera de nuevo desde 1 al cambiar de estilo (usa paréntesis).
  assert.match(ieee2.citation, /[\[\(]1[\]\)]/);
});

test('la cita se devuelve como texto plano, sin entidades HTML', async () => {
  const manager = new CitationManager({
    fetchItems: async () => [
      {
        id: 'CCC3',
        type: 'article-journal',
        title: 'Two authors',
        issued: { 'date-parts': [[2021]] },
        author: [
          { family: 'Smith', given: 'John' },
          { family: 'Jones', given: 'Mary' },
        ],
      },
    ],
  });
  const res = await manager.cite({ key: 'CCC3', style: 'apa', locale: 'en-US' });
  assert.ok(res.citation.includes('Smith & Jones'), `cita: ${res.citation}`);
  assert.ok(!/&#?\w+;/.test(res.citation), `cita con entidades: ${res.citation}`);
});

test('bibliografía desde items ya resueltos no consulta Zotero ni altera el registro', async () => {
  const manager = new CitationManager({
    fetchItems: async () => {
      throw new Error('no debería consultar Zotero');
    },
  });
  const bib = await manager.bibliography({
    items: [ITEMS[1], ITEMS[0], ITEMS[1]],
    style: 'ieee',
    locale: 'en-US',
    format: 'plaintext',
  });
  assert.equal(bib.source, 'items');
  assert.equal(bib.count, 2);
  // Orden de cita: García [1], Smith [2].
  assert.ok(bib.entries[0].includes('García'), bib.entries[0]);
  assert.ok(bib.entries[1].includes('Smith'), bib.entries[1]);
  const docBib = await manager.bibliography({ style: 'ieee', locale: 'en-US' });
  assert.equal(docBib.count, 0);
});

const SAME_AUTHOR_YEAR = [
  { id: 'S1', type: 'book', title: 'Primero', issued: { 'date-parts': [[2020]] }, author: [{ family: 'Smith', given: 'John' }] },
  { id: 'S2', type: 'book', title: 'Segundo', issued: { 'date-parts': [[2020]] }, author: [{ family: 'Smith', given: 'John' }] },
];

test('register:false no entra en la bibliografía del registro', async () => {
  const manager = makeManager();
  await manager.cite({ key: 'AAA1', style: 'apa', locale: 'en-US' });
  await manager.cite({ key: 'BBB2', style: 'apa', locale: 'en-US', register: false });
  const bib = await manager.bibliography({ style: 'apa', locale: 'en-US' });
  assert.equal(bib.count, 1);
  assert.ok(!bib.bibliography.includes('García'), bib.bibliography);
});

test('register:false con otro estilo no reinicia el registro', async () => {
  const manager = makeManager();
  await manager.cite({ key: 'AAA1', style: 'ieee', locale: 'en-US' });
  await manager.cite({ key: 'BBB2', style: 'apa', locale: 'en-US', register: false });
  const bib = await manager.bibliography({ style: 'ieee', locale: 'en-US' });
  assert.equal(bib.count, 1);
});

test('register:false usa las citas registradas como contexto sin modificarlas', async () => {
  const manager = makeManager();
  await manager.cite({ key: 'AAA1', style: 'ieee', locale: 'en-US' });
  const preview = await manager.cite({ key: 'BBB2', style: 'ieee', locale: 'en-US', register: false });
  assert.match(preview.citation, /\[2\]/, preview.citation);
  // La siguiente cita registrada sigue siendo la segunda.
  const next = await manager.cite({ key: 'BBB2', style: 'ieee', locale: 'en-US' });
  assert.match(next.citation, /\[2\]/, next.citation);
});

test('al desambiguar se devuelve solo la cita nueva', async () => {
  const manager = new CitationManager({ fetchItems: async (keys) => SAME_AUTHOR_YEAR.filter((i) => keys.includes(i.id)) });
  await manager.cite({ key: 'S1', style: 'apa', locale: 'en-US' });
  const second = await manager.cite({ key: 'S2', style: 'apa', locale: 'en-US' });
  assert.equal(second.citation, '(Smith, 2020b)');
});

test('renderCitation numera según las citas anteriores y posteriores del documento', () => {
  const manager = new CitationManager({
    fetchItems: async () => {
      throw new Error('no debería consultar Zotero');
    },
  });
  // Documento con una cita a García; la nueva (Smith) va después → [2].
  const afterIt = manager.renderCitation({
    style: 'ieee',
    locale: 'en-US',
    items: ITEMS,
    before: [[{ id: 'BBB2' }]],
    citationItems: [{ id: 'AAA1' }],
  });
  assert.equal(afterIt.citation, '[2]');
  // La nueva va antes de la cita a García → [1].
  const beforeIt = manager.renderCitation({
    style: 'ieee',
    locale: 'en-US',
    items: ITEMS,
    citationItems: [{ id: 'AAA1' }],
    after: [[{ id: 'BBB2' }]],
  });
  assert.equal(beforeIt.citation, '[1]');
  // El registro del manager no se tocó.
  assert.equal(manager.state, null);
});

test('renderCitation desambigua con las citas del documento y avisa si faltan datos', () => {
  const manager = new CitationManager({ fetchItems: async () => [] });
  const res = manager.renderCitation({
    style: 'apa',
    locale: 'en-US',
    items: SAME_AUTHOR_YEAR,
    before: [[{ id: 'S1' }]],
    citationItems: [{ id: 'S2', locator: '12', label: 'page' }],
  });
  assert.equal(res.citation, '(Smith, 2020b, p. 12)');
  assert.throws(
    () => manager.renderCitation({ items: [], citationItems: [{ id: 'NOPE' }] }),
    /Faltan los datos de los items: NOPE/
  );
});
