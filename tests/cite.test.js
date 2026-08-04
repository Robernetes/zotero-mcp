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
