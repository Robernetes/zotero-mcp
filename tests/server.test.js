// Pruebas del servidor MCP completo (herramientas registradas y sus handlers),
// en memoria y con clientes de Zotero simulados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, SERVER_INFO } from '../src/app.js';
import { CitationManager } from '../src/cite.js';

const ITEMS = {
  AAAA1111: { id: 'AAAA1111', type: 'book', title: 'Uno', issued: { 'date-parts': [[2020]] }, author: [{ family: 'Smith', given: 'Ana' }], publisher: 'Ed.' },
  BBBB2222: { id: 'BBBB2222', type: 'book', title: 'Dos', issued: { 'date-parts': [[2019]] }, author: [{ family: 'García', given: 'Luis' }], publisher: 'Ed.' },
};

/** Contexto con dobles de prueba: no hay red ni Zotero real. */
function fakeContext(overrides = {}) {
  const calls = [];
  const zotero = {
    status: async () => ({ ok: true, baseUrl: 'fake' }),
    search: async (args) => {
      calls.push(['search', args]);
      return [{ key: 'AAAA1111', title: 'Uno' }];
    },
    getItem: async (key) => ({ key }),
    listCollections: async () => [{ key: 'TESIS001', name: 'Tesis', parentKey: null }],
    getByKeys: async (keys) => keys.map((k) => ITEMS[k]).filter(Boolean).map((i) => ({ ...i })),
    findExisting: async () => null,
    ...overrides.zotero,
  };
  return {
    calls,
    config: { apiUrl: 'http://fake/api', defaultStyle: 'apa', defaultLocale: 'en-US', backup: false },
    zotero,
    citationManager: new CitationManager({ fetchItems: (keys) => zotero.getByKeys(keys) }),
    externalSearch: {
      fetchCsl: async () => ({ source: 'crossref', csl: { type: 'book', title: 'Nuevo', author: [{ family: 'Pérez', given: 'Eva' }], issued: { 'date-parts': [[2024]] }, DOI: '10.1000/NUEVO' } }),
      ...overrides.externalSearch,
    },
    zoteroConnector: {
      getSaveTargets: async () => ({
        selected: { id: 'L1', name: 'My Library' },
        library: { id: 'L1', name: 'My Library' },
        targets: [{ id: 'L1', name: 'My Library', level: 0 }, { id: 'C2', name: 'Tesis', level: 1 }],
      }),
      importCsl: async (items, sessionID) => {
        calls.push(['importCsl', items, sessionID]);
        return [{ key: 'NUEVO001' }];
      },
      updateSession: async (...args) => calls.push(['updateSession', ...args]),
      ...overrides.zoteroConnector,
    },
  };
}

async function connect(ctx) {
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    return res.isError ? { error: text } : JSON.parse(text);
  };
  return { client, call, close: () => client.close() };
}

test('el servidor registra las 11 herramientas', async () => {
  const { client, close } = await connect(fakeContext());
  try {
    assert.deepEqual(client.getServerVersion(), SERVER_INFO);
    // La versión publicada es la de package.json.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.deepEqual(SERVER_INFO, { name: pkg.name, version: pkg.version });
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), [
      'zotero_status',
      'zotero_search',
      'zotero_get_item',
      'zotero_list_collections',
      'zotero_cite',
      'zotero_bibliography',
      'zotero_read_docx',
      'zotero_insert_citation_docx',
      'zotero_update_bibliography_docx',
      'zotero_find_external',
      'zotero_add_item',
    ]);
    for (const t of tools) assert.ok(t.description && t.inputSchema && t.inputSchema.type === 'object', t.name);
    // Los defaults de la configuración aparecen en las descripciones de los parámetros.
    const cite = tools.find((t) => t.name === 'zotero_cite');
    assert.match(cite.inputSchema.properties.style.description, /Default: apa/);
  } finally {
    await close();
  }
});

test('las herramientas de biblioteca pasan los argumentos y devuelven JSON', async () => {
  const ctx = fakeContext();
  const { call, close } = await connect(ctx);
  try {
    assert.deepEqual(await call('zotero_status'), { ok: true, baseUrl: 'fake' });
    const res = await call('zotero_search', { query: 'uno', limit: 5 });
    assert.equal(res.count, 1);
    assert.deepEqual(ctx.calls[0], ['search', { query: 'uno', limit: 5 }]);
    assert.equal((await call('zotero_list_collections')).collections[0].key, 'TESIS001');
    // Validación de zod antes de llegar al handler.
    assert.match((await call('zotero_search', { limit: 500 })).error, /limit/);
  } finally {
    await close();
  }
});

test('los errores de los handlers se devuelven como isError con mensaje', async () => {
  const ctx = fakeContext({ zotero: { getItem: async () => { throw new Error('Zotero no responde'); } } });
  const { call, close } = await connect(ctx);
  try {
    assert.deepEqual(await call('zotero_get_item', { key: 'X' }), { error: 'Error: Zotero no responde' });
  } finally {
    await close();
  }
});

test('zotero_cite y zotero_bibliography actualizan un Markdown', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zmcp-server-'));
  const { call, close } = await connect(fakeContext());
  try {
    assert.equal((await call('zotero_cite', { key: 'AAAA1111' })).citation, '(Smith, 2020)');
    await call('zotero_cite', { key: 'BBBB2222' });
    const file = path.join(dir, 'doc.md');
    writeFileSync(file, '# Texto\n\nIdea (Smith, 2020).\n\n## Referencias\n\nvieja\n');
    const preview = await call('zotero_bibliography', { filePath: file });
    assert.equal(preview.dryRun, true);
    assert.equal(readFileSync(file, 'utf8').includes('vieja'), true, 'el dryRun no escribe');
    const res = await call('zotero_bibliography', { filePath: file, apply: true });
    assert.equal(res.written, true);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /García, L\. \(2019\)/);
    assert.match(text, /Idea \(Smith, 2020\)\./);
    assert.ok(!text.includes('vieja'));
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('las herramientas de Word insertan citas y la bibliografía', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zmcp-server-'));
  const { call, close } = await connect(fakeContext());
  try {
    const file = path.join(dir, 'doc.docx');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">Primera </w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Segunda </w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
    writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));

    assert.equal((await call('zotero_read_docx', { filePath: file })).count, 2);
    const c1 = await call('zotero_insert_citation_docx', { filePath: file, key: 'AAAA1111', paragraphIndex: 0, style: 'ieee', apply: true });
    assert.equal(c1.citation, '[1]');
    assert.equal(c1.documentPrefs, 'creadas');
    const c2 = await call('zotero_insert_citation_docx', { filePath: file, key: 'BBBB2222', paragraphIndex: 1, apply: true });
    assert.equal(c2.style, 'ieee', 'sin style usa el del documento');
    assert.equal(c2.citation, '[2]');
    const bib = await call('zotero_update_bibliography_docx', { filePath: file, apply: true });
    assert.equal(bib.entries, 2);
    assert.equal(bib.styleID, 'http://www.zotero.org/styles/ieee');
    assert.match((await call('zotero_insert_citation_docx', { filePath: file, key: 'NOPE0000', paragraphIndex: 0 })).error, /NOPE0000/);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zotero_add_item muestra la vista previa y guarda solo con apply', async () => {
  const ctx = fakeContext();
  const { call, close } = await connect(ctx);
  try {
    const preview = await call('zotero_add_item', { doi: '10.1000/NUEVO', collectionKey: 'TESIS001' });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.target, 'Tesis');
    assert.equal(preview.item.title, 'Nuevo');
    assert.ok(!ctx.calls.some((c) => c[0] === 'importCsl'), 'la vista previa no guarda');

    const saved = await call('zotero_add_item', { doi: '10.1000/NUEVO', collectionKey: 'TESIS001', tags: ['tesis'], apply: true });
    assert.equal(saved.saved, true);
    assert.equal(saved.key, 'NUEVO001');
    const update = ctx.calls.find((c) => c[0] === 'updateSession');
    assert.equal(update[2], 'C2');
    assert.deepEqual(update[3], ['tesis']);

    assert.match((await call('zotero_add_item', {})).error, /Indica doi u openAlexId/);
  } finally {
    await close();
  }
});

test('zotero_add_item no guarda duplicados', async () => {
  const ctx = fakeContext({ zotero: { findExisting: async () => ({ key: 'EXIST001', title: 'Nuevo' }) } });
  const { call, close } = await connect(ctx);
  try {
    const res = await call('zotero_add_item', { doi: '10.1000/NUEVO', apply: true });
    assert.equal(res.saved, false);
    assert.equal(res.inLibrary.key, 'EXIST001');
    assert.ok(!ctx.calls.some((c) => c[0] === 'importCsl'));
  } finally {
    await close();
  }
});
