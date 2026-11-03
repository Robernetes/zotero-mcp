import test from 'node:test';
import assert from 'node:assert/strict';
import { ZoteroClient, ZoteroError } from '../src/zotero-client.js';

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => handler(String(url));
  return () => {
    globalThis.fetch = original;
  };
}

const SAMPLE_ITEM = {
  key: 'ABC12345',
  version: 1,
  data: {
    itemType: 'journalArticle',
    title: 'Un artículo de ejemplo',
    creators: [
      { creatorType: 'author', firstName: 'Ana', lastName: 'García' },
      { creatorType: 'editor', firstName: 'Luis', lastName: 'Pérez' },
    ],
    date: '2020-05-01',
    DOI: '10.1000/ejemplo',
    url: 'https://example.org/art',
  },
};

test('search construye la URL y resume los items', async () => {
  const calls = [];
  const restore = mockFetch((url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => [SAMPLE_ITEM],
    };
  });
  try {
    const client = new ZoteroClient({ baseUrl: 'http://127.0.0.1:23119/api' });
    const items = await client.search({ query: 'inteligencia artificial', limit: 5 });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('/users/0/items?'));
    assert.ok(calls[0].includes('q=inteligencia+artificial'));
    assert.ok(calls[0].includes('qmode=titleCreatorYear'));
    assert.ok(calls[0].includes('limit=5'));
    assert.ok(calls[0].includes('format=json'));
    assert.equal(items.length, 1);
    assert.equal(items[0].key, 'ABC12345');
    assert.equal(items[0].title, 'Un artículo de ejemplo');
    assert.deepEqual(items[0].creators, ['Ana García', 'Luis Pérez']);
    assert.equal(items[0].year, '2020');
    assert.equal(items[0].doi, '10.1000/ejemplo');
  } finally {
    restore();
  }
});

test('search limita limit a 50 y acepta búsqueda vacía', async () => {
  const calls = [];
  const restore = mockFetch((url) => {
    calls.push(url);
    return { ok: true, json: async () => [] };
  });
  try {
    const client = new ZoteroClient({ baseUrl: 'http://127.0.0.1:23119/api' });
    await client.search({ limit: 999 });
    assert.ok(calls[0].includes('limit=50'));
    assert.ok(!calls[0].includes('q='));
  } finally {
    restore();
  }
});

test('error de conexión produce mensaje accionable', async () => {
  const restore = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  try {
    const client = new ZoteroClient({ baseUrl: 'http://127.0.0.1:23119/api' });
    await assert.rejects(() => client.search({ query: 'x' }), (err) => {
      assert.ok(err instanceof ZoteroError);
      assert.match(err.message, /Zotero no está corriendo|No se pudo conectar/);
      return true;
    });
  } finally {
    restore();
  }
});

test('respuesta HTTP no-OK produce error', async () => {
  const restore = mockFetch(() => ({ ok: false, status: 500 }));
  try {
    const client = new ZoteroClient({ baseUrl: 'http://127.0.0.1:23119/api' });
    await assert.rejects(() => client.search({}), /HTTP 500/);
  } finally {
    restore();
  }
});

test('getByKeys usa format=csljson y normaliza el id a la key corta', async () => {
  const calls = [];
  const restore = mockFetch((url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => [
        { id: 'http://zotero.org/users/21189841/items/KEY12345', type: 'book', title: 'Libro' },
        { id: 'KEY23456', type: 'article-journal', title: 'Artículo' },
      ],
    };
  });
  try {
    const client = new ZoteroClient({ baseUrl: 'http://127.0.0.1:23119/api' });
    const items = await client.getByKeys(['KEY12345', 'KEY23456', 'KEY12345']);
    assert.ok(calls[0].includes('itemKey=KEY12345%2CKEY23456'));
    assert.ok(calls[0].includes('format=csljson'));
    assert.equal(items.length, 2);
    assert.equal(items[0].id, 'KEY12345');
    assert.equal(items[1].id, 'KEY23456');
    // La URI original se conserva para los campos de Word, pero no se serializa.
    assert.equal(items[0].zoteroURI, 'http://zotero.org/users/21189841/items/KEY12345');
    assert.equal(items[1].zoteroURI, undefined);
    assert.ok(!JSON.stringify(items[0]).includes('zoteroURI'));
    assert.equal({ ...items[0] }.zoteroURI, undefined);
  } finally {
    restore();
  }
});

test('status devuelve ok:false sin lanzar cuando Zotero está caído', async () => {
  const restore = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  try {
    const client = new ZoteroClient({ baseUrl: 'http://127.0.0.1:23119/api' });
    const status = await client.status();
    assert.equal(status.ok, false);
    assert.match(status.error, /No se pudo conectar/);
  } finally {
    restore();
  }
});
