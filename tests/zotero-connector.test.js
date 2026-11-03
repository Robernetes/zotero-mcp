import test from 'node:test';
import assert from 'node:assert/strict';
import { ZoteroConnector, collectionPath, findTargetByPath } from '../src/zotero-connector.js';

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers || {}, body: init.body });
    return handler(String(url), init);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
});

const TARGETS = [
  { id: 'L1', name: 'My Library', level: 0 },
  { id: 'C2', name: 'Tesis', level: 1 },
  { id: 'C3', name: 'Marco teórico', level: 2 },
  { id: 'C4', name: 'Métodos', level: 2 },
  { id: 'C5', name: 'Artículos', level: 1 },
  { id: 'C6', name: 'Marco teórico', level: 2 },
  { id: 'L7', name: 'Grupo', level: 0 },
  { id: 'C8', name: 'Tesis', level: 1 },
];

test('fromApiUrl usa el mismo host y puerto que la API local', () => {
  assert.equal(ZoteroConnector.fromApiUrl('http://127.0.0.1:23119/api').baseUrl, 'http://127.0.0.1:23119');
  assert.equal(ZoteroConnector.fromApiUrl('http://localhost:9999/api/').baseUrl, 'http://localhost:9999');
});

test('getSaveTargets devuelve solo la biblioteca personal y la colección seleccionada', async () => {
  const m = mockFetch(() => reply(200, { libraryID: 1, libraryName: 'My Library', id: 3, name: 'Marco teórico', targets: TARGETS }));
  try {
    const res = await new ZoteroConnector().getSaveTargets();
    assert.equal(m.calls[0].url, 'http://127.0.0.1:23119/connector/getSelectedCollection');
    assert.equal(m.calls[0].method, 'POST');
    assert.equal(m.calls[0].headers['X-Zotero-Connector-API-Version'], '3');
    assert.deepEqual(res.selected, { id: 'C3', name: 'Marco teórico' });
    assert.deepEqual(res.library, { id: 'L1', name: 'My Library' });
    assert.deepEqual(res.targets.map((t) => t.id), ['L1', 'C2', 'C3', 'C4', 'C5', 'C6']);
  } finally {
    m.restore();
  }
});

test('con una biblioteca de grupo seleccionada, el destino es la raíz de la personal', async () => {
  const m = mockFetch(() => reply(200, { libraryID: 7, libraryName: 'Grupo', id: 8, name: 'Tesis', targets: TARGETS }));
  try {
    assert.deepEqual((await new ZoteroConnector().getSaveTargets()).selected, { id: 'L1', name: 'My Library' });
  } finally {
    m.restore();
  }
});

test('importCsl envía el CSL como texto con la sesión y updateSession mueve y etiqueta', async () => {
  const m = mockFetch((url) => (url.includes('/import') ? reply(201, [{ key: 'NEW12345', title: 'X' }]) : reply(200, {})));
  try {
    const c = new ZoteroConnector();
    const items = await c.importCsl([{ type: 'book', title: 'Título con acentos: ñ' }], 'ses 1');
    assert.equal(m.calls[0].url, 'http://127.0.0.1:23119/connector/import?session=ses%201');
    assert.equal(m.calls[0].headers['Content-Type'], 'text/plain');
    assert.deepEqual(JSON.parse(m.calls[0].body), [{ type: 'book', title: 'Título con acentos: ñ' }]);
    assert.equal(items[0].key, 'NEW12345');
    await c.updateSession('ses 1', 'C4', ['tesis']);
    assert.equal(m.calls[1].headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(m.calls[1].body), { sessionID: 'ses 1', target: 'C4', tags: ['tesis'] });
  } finally {
    m.restore();
  }
});

test('los errores del conector son claros', async () => {
  let m = mockFetch(() => reply(400, 'Bad'));
  try {
    await assert.rejects(() => new ZoteroConnector().importCsl([], 's'), /HTTP 400 en \/connector\/import: Zotero no reconoció/);
  } finally {
    m.restore();
  }
  m = mockFetch(() => reply(400, { error: 'SESSION_NOT_FOUND' }));
  try {
    await assert.rejects(() => new ZoteroConnector().updateSession('s', 'L1'), /HTTP 400 \(SESSION_NOT_FOUND\)/);
  } finally {
    m.restore();
  }
  m = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  try {
    await assert.rejects(() => new ZoteroConnector().getSaveTargets(), /Verifica que Zotero esté abierto/);
  } finally {
    m.restore();
  }
});

test('collectionPath y findTargetByPath localizan la colección por su ruta', () => {
  const cols = [
    { key: 'AAAA', name: 'Tesis', parentKey: null },
    { key: 'BBBB', name: 'Marco teórico', parentKey: 'AAAA' },
    { key: 'CCCC', name: 'Artículos', parentKey: null },
    { key: 'DDDD', name: 'Marco teórico', parentKey: 'CCCC' },
  ];
  assert.deepEqual(collectionPath('BBBB', cols), ['Tesis', 'Marco teórico']);
  assert.deepEqual(collectionPath('NOPE', cols), []);
  const targets = TARGETS.slice(0, 6);
  assert.deepEqual(findTargetByPath(targets, ['Tesis', 'Marco teórico']), [{ id: 'C3', name: 'Marco teórico' }]);
  assert.deepEqual(findTargetByPath(targets, ['Artículos', 'Marco teórico']), [{ id: 'C6', name: 'Marco teórico' }]);
  assert.deepEqual(findTargetByPath(targets, ['Tesis']), [{ id: 'C2', name: 'Tesis' }]);
  assert.deepEqual(findTargetByPath(targets, ['Marco teórico']), []);
  assert.equal(findTargetByPath([...targets, { id: 'C9', name: 'Tesis', level: 1 }], ['Tesis']).length, 2);
});
