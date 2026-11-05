// Pruebas del servidor MCP completo (herramientas registradas y sus handlers),
// en memoria y con clientes de Zotero simulados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, SERVER_INFO } from '../src/app.js';
import { CitationManager } from '../src/cite.js';
import { Workspace } from '../src/workspace.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

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
    searchAnyWords: async (args) => {
      calls.push(['searchAnyWords', args]);
      return { words: [], items: [] };
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
    // Por defecto se permite la carpeta temporal, donde las pruebas crean sus documentos.
    workspace: overrides.workspace || new Workspace({ allowedDirs: [tmpdir()] }),
  };
}

/** @param {object} [opts] @param {string[]} [opts.roots] Carpetas que el cliente ofrece como roots. */
async function connect(ctx, { roots } = {}) {
  const server = createServer(ctx);
  const client = new Client({ name: 'test', version: '0' }, roots ? { capabilities: { roots: { listChanged: true } } } : {});
  const state = { roots, listRootsCalls: 0 };
  if (roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      state.listRootsCalls++;
      return { roots: state.roots.map((dir) => ({ uri: pathToFileURL(dir).href, name: path.basename(dir) })) };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const setRoots = async (dirs) => {
    state.roots = dirs;
    await client.sendRootsListChanged();
  };
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    return res.isError ? { error: text } : JSON.parse(text);
  };
  return { client, call, setRoots, state, close: () => client.close() };
}

test('el servidor registra las 12 herramientas', async () => {
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
      'zotero_remove_citations_docx',
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
    const status = await call('zotero_status');
    assert.equal(status.ok, true);
    assert.deepEqual(status.workspace.allowedDirs, [realpathSync.native(tmpdir())]);
    assert.equal(status.workspace.source, 'ZOTERO_MCP_ALLOWED_DIRS');
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

test('zotero_search recurre a las palabras sueltas cuando ninguna coincide del todo', async () => {
  const partial = { key: 'CCCC3333', title: 'Binary analysis', matchedWords: ['binary', 'analysis'] };
  const ctx = fakeContext({
    zotero: {
      search: async () => [],
      searchAnyWords: async (args) => (args.query === 'sin nada' ? { words: ['nada'], items: [] } : { words: ['reverse', 'binary', 'analysis'], items: [partial] }),
    },
  });
  const { call, close } = await connect(ctx);
  try {
    const res = await call('zotero_search', { query: 'reverse binary analysis', collectionKey: 'TESIS001' });
    assert.equal(res.partialMatch, true);
    assert.equal(res.count, 1);
    assert.deepEqual(res.words, ['reverse', 'binary', 'analysis']);
    assert.deepEqual(res.items[0].matchedWords, ['binary', 'analysis']);
    assert.ok(res.note.includes('alguna'));
    // Sin resultados parciales, la respuesta es la normal.
    const none = await call('zotero_search', { query: 'sin nada' });
    assert.deepEqual(none, { query: 'sin nada', count: 0, items: [] });
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

test('zotero_add_item no guarda duplicados y explica cómo citar el item existente', async () => {
  const ctx = fakeContext({ zotero: { findExisting: async () => ({ key: 'EXIST001', title: 'Nuevo', collections: ['TESIS001'] }) } });
  const { call, close } = await connect(ctx);
  try {
    const res = await call('zotero_add_item', { doi: '10.1000/NUEVO', apply: true });
    assert.equal(res.saved, false);
    assert.deepEqual(res.inLibrary, { key: 'EXIST001', title: 'Nuevo', collections: ['Tesis'] });
    assert.ok(res.message.includes('key EXIST001 (colecciones: «Tesis»): cítalo con esa key'), res.message);
    assert.match(res.message, /No uses allowDuplicate/);
    assert.doesNotMatch(res.message, /usa allowDuplicate/);

    const same = await call('zotero_add_item', { doi: '10.1000/NUEVO', collectionKey: 'TESIS001', apply: true });
    assert.equal(same.inTargetCollection, true);
    assert.match(same.message, /Ya está en la biblioteca y en «Tesis»/);
    assert.ok(!ctx.calls.some((c) => c[0] === 'importCsl'));
  } finally {
    await close();
  }
});

test('zotero_add_item con un item de otra colección pide arrastrarlo en Zotero, no duplicarlo', async () => {
  const ctx = fakeContext({
    zotero: {
      findExisting: async () => ({ key: 'EXIST001', title: 'Nuevo', collections: [] }),
      listCollections: async () => [{ key: 'TESIS001', name: 'Tesis', parentKey: null }],
    },
  });
  const { call, close } = await connect(ctx);
  try {
    const res = await call('zotero_add_item', { doi: '10.1000/NUEVO', collectionKey: 'TESIS001', apply: true });
    assert.equal(res.saved, false);
    assert.equal(res.inTargetCollection, false);
    assert.ok(res.message.includes('(sin colección)'), res.message);
    assert.match(res.message, /arrastre a esa colección en Zotero/);

    // Solo si se pide expresamente: la vista previa y el guardado avisan del duplicado.
    const preview = await call('zotero_add_item', { doi: '10.1000/NUEVO', allowDuplicate: true });
    assert.match(preview.warnings[0], /Crea un duplicado de EXIST001/);
    const forced = await call('zotero_add_item', { doi: '10.1000/NUEVO', allowDuplicate: true, apply: true });
    assert.equal(forced.saved, true);
    assert.match(forced.warnings[0], /Se creó un duplicado de EXIST001/);
  } finally {
    await close();
  }
});

test('las herramientas de documentos rechazan rutas fuera de las carpetas permitidas', async (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'zmcp-server-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const inside = path.join(base, 'proyecto');
  const outside = path.join(base, 'otra');
  mkdirSync(inside);
  mkdirSync(outside);
  const fuera = path.join(outside, 'doc.md');
  writeFileSync(fuera, '# Doc\n\n## Referencias\n\nvieja\n');
  const { call, close } = await connect(fakeContext({ workspace: new Workspace({ allowedDirs: [inside] }) }));
  try {
    await call('zotero_cite', { key: 'AAAA1111' });
    const res = await call('zotero_bibliography', { filePath: fuera, apply: true });
    assert.match(res.error, /fuera de las carpetas permitidas/);
    assert.match(res.error, /ZOTERO_MCP_ALLOWED_DIRS/);
    assert.equal(readFileSync(fuera, 'utf8'), '# Doc\n\n## Referencias\n\nvieja\n', 'no se modificó');
    assert.match((await call('zotero_read_docx', { filePath: path.join(outside, 'x.docx') })).error, /fuera de las carpetas permitidas/);
    assert.match((await call('zotero_update_bibliography_docx', { filePath: '../otra/x.docx' })).error, /fuera de las carpetas permitidas/);
  } finally {
    await close();
  }
});

test('sin ZOTERO_MCP_ALLOWED_DIRS se usan los roots del cliente y se actualizan cuando cambian', async (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'zmcp-server-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const tesis = path.join(base, 'tesis');
  const articulo = path.join(base, 'articulo');
  mkdirSync(tesis);
  mkdirSync(articulo);
  writeFileSync(path.join(tesis, 'cap1.md'), '# Cap 1\n\n## Referencias\n\nvieja\n');
  writeFileSync(path.join(articulo, 'borrador.md'), '# Borrador\n\n## Referencias\n\nvieja\n');
  const ctx = fakeContext({ workspace: new Workspace({ cwd: base }) });
  const { call, setRoots, state, close } = await connect(ctx, { roots: [tesis] });
  try {
    const status = await call('zotero_status');
    assert.deepEqual(status.workspace, { allowedDirs: [tesis], source: 'roots del cliente MCP' });
    await call('zotero_cite', { key: 'AAAA1111' });
    // Ruta relativa: se resuelve desde el root.
    assert.equal((await call('zotero_bibliography', { filePath: 'cap1.md', apply: true })).written, true);
    assert.match((await call('zotero_bibliography', { filePath: path.join(articulo, 'borrador.md') })).error, /fuera de las carpetas permitidas/);
    assert.equal(state.listRootsCalls, 1, 'los roots se piden una vez');

    // El cliente cambia de carpeta de trabajo.
    await setRoots([articulo]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await call('zotero_bibliography', { filePath: 'borrador.md', apply: true })).written, true);
    assert.match((await call('zotero_bibliography', { filePath: path.join(tesis, 'cap1.md') })).error, /fuera de las carpetas permitidas/);
    assert.equal(state.listRootsCalls, 2);
  } finally {
    await close();
  }
});

test('si el cliente no ofrece roots se usa la carpeta de arranque', async (t) => {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'zmcp-server-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { call, close } = await connect(fakeContext({ workspace: new Workspace({ cwd: base }) }));
  try {
    const { workspace } = await call('zotero_status');
    assert.deepEqual(workspace.allowedDirs, [base]);
    assert.equal(workspace.source, 'carpeta de arranque del servidor');
    assert.match(workspace.note, /ZOTERO_MCP_ALLOWED_DIRS/);
  } finally {
    await close();
  }
});

/** Escribe un .docx mínimo con un párrafo por texto. */
async function writeDocx(file, paragraphs) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = paragraphs.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

test('zotero_insert_citation_docx cita tras la frase y agrupa varias fuentes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zmcp-server-'));
  const { call, close } = await connect(fakeContext());
  try {
    const file = path.join(dir, 'doc.docx');
    await writeDocx(file, ['La definición es clásica. Hoy se aplica a binarios y firmware.']);

    const preview = await call('zotero_insert_citation_docx', {
      filePath: file,
      keys: ['AAAA1111', 'BBBB2222'],
      afterText: 'Hoy se aplica a binarios y firmware.',
    });
    assert.equal(preview.citation, '(García, 2019; Smith, 2020)', 'una sola cita, ordenada por el estilo');
    assert.deepEqual(preview.keys, ['AAAA1111', 'BBBB2222']);
    assert.equal(preview.preview, 'La definición es clásica. Hoy se aplica a binarios y firmware (García, 2019; Smith, 2020).');
    assert.equal(preview.placement.beforePunctuation, true);
    assert.equal(preview.documentPrefs, 'se crearían', 'la vista previa no dice que ya las creó');
    assert.equal(preview.dryRun, true);

    const written = await call('zotero_insert_citation_docx', {
      filePath: file,
      key: 'AAAA1111',
      afterText: 'La definición es clásica.',
      apply: true,
    });
    assert.equal(written.documentPrefs, 'creadas');
    const [p] = (await call('zotero_read_docx', { filePath: file })).paragraphs;
    assert.equal(p.text, 'La definición es clásica (Smith, 2020). Hoy se aplica a binarios y firmware.');
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la numeración IEEE tiene en cuenta las citas posteriores del mismo párrafo', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zmcp-server-'));
  const { call, close } = await connect(fakeContext());
  try {
    const file = path.join(dir, 'doc.docx');
    await writeDocx(file, ['Primera idea. Segunda idea.']);
    const last = await call('zotero_insert_citation_docx', { filePath: file, key: 'BBBB2222', afterText: 'Segunda idea', style: 'ieee', apply: true });
    assert.equal(last.citation, '[1]');
    const first = await call('zotero_insert_citation_docx', { filePath: file, key: 'AAAA1111', afterText: 'Primera idea', apply: true });
    assert.equal(first.citation, '[1]', 'va antes de la cita existente, así que es la primera');
    const [p] = (await call('zotero_read_docx', { filePath: file })).paragraphs;
    assert.equal(p.text, 'Primera idea [1]. Segunda idea [1].', 'Zotero renumera la segunda al refrescar');
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zotero_insert_citation_docx valida key/keys, locator y la posición', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zmcp-server-'));
  const { call, close } = await connect(fakeContext());
  try {
    const file = path.join(dir, 'doc.docx');
    await writeDocx(file, ['Texto.']);
    assert.match((await call('zotero_insert_citation_docx', { filePath: file, paragraphIndex: 0 })).error, /Indica key/);
    assert.match((await call('zotero_insert_citation_docx', { filePath: file, key: 'AAAA1111', keys: ['BBBB2222'], paragraphIndex: 0 })).error, /no los dos/);
    assert.match((await call('zotero_insert_citation_docx', { filePath: file, keys: ['AAAA1111', 'BBBB2222'], locator: '5', paragraphIndex: 0 })).error, /una fuente/);
    assert.match((await call('zotero_insert_citation_docx', { filePath: file, key: 'AAAA1111' })).error, /afterText/);
    assert.match((await call('zotero_insert_citation_docx', { filePath: file, keys: ['AAAA1111', 'NOPE0000'], paragraphIndex: 0 })).error, /"NOPE0000"/);
    assert.match((await call('zotero_insert_citation_docx', { filePath: file, key: 'AAAA1111', afterText: 'No está' })).error, /No se encontró el texto/);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zotero_remove_citations_docx deshace citas sin tocar el resto del documento', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zmcp-server-'));
  const { call, close } = await connect(fakeContext());
  try {
    const file = path.join(dir, 'doc.docx');
    const original = 'La definición es clásica. Hoy se aplica a binarios y firmware.';
    await writeDocx(file, [original]);
    await call('zotero_insert_citation_docx', { filePath: file, key: 'AAAA1111', afterText: 'La definición es clásica.', apply: true });
    await call('zotero_insert_citation_docx', { filePath: file, keys: ['AAAA1111', 'BBBB2222'], afterText: 'binarios y firmware.', apply: true });
    await call('zotero_update_bibliography_docx', { filePath: file, apply: true });

    const preview = await call('zotero_remove_citations_docx', { filePath: file, keys: ['AAAA1111'] });
    assert.equal(preview.dryRun, true);
    assert.deepEqual([preview.removedCitations, preview.updatedCitations, preview.remainingCitations], [1, 1, 1]);
    assert.equal(preview.paragraphs[0].text, 'La definición es clásica. Hoy se aplica a binarios y firmware (García, 2019).');
    assert.equal(preview.bibliographyRemoved, false);
    assert.ok(preview.warnings.some((w) => /zotero_update_bibliography_docx/.test(w)));
    assert.equal((await call('zotero_read_docx', { filePath: file })).paragraphs[0].text.includes('Smith'), true, 'la vista previa no escribe');

    const all = await call('zotero_remove_citations_docx', { filePath: file, apply: true });
    assert.deepEqual([all.removedCitations, all.remainingCitations, all.bibliographyRemoved, all.written], [2, 0, true, true]);
    const { paragraphs } = await call('zotero_read_docx', { filePath: file });
    assert.deepEqual(paragraphs.map((p) => p.text), [original]);

    assert.match((await call('zotero_remove_citations_docx', { filePath: file })).error, /no tiene citas ni bibliografía/);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zotero_remove_citations_docx avisa si las keys no están en el documento', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zmcp-server-'));
  const { call, close } = await connect(fakeContext());
  try {
    const file = path.join(dir, 'doc.docx');
    await writeDocx(file, ['Texto.']);
    await call('zotero_insert_citation_docx', { filePath: file, key: 'AAAA1111', paragraphIndex: 0, apply: true });
    assert.match((await call('zotero_remove_citations_docx', { filePath: file, keys: ['NOPE0000'] })).error, /Ninguna cita.*El documento cita: AAAA1111/);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});
