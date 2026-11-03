import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalSearch, fromCrossref, fromOpenAlex, abstractFromInvertedIndex } from '../src/external-search.js';

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: (init && init.headers) || {} });
    return handler(String(url));
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const OA_WORK = {
  id: 'https://openalex.org/W123',
  doi: 'https://doi.org/10.1017/S0144686X19000230',
  display_name: 'Older adults &amp; <i>technology</i> adoption',
  publication_year: 2019,
  type: 'article',
  authorships: [{ author: { display_name: 'Arlene J. Astell' } }, { author: { display_name: 'Colleen McGrath' } }],
  primary_location: {
    landing_page_url: 'https://www.cambridge.org/x',
    source: { display_name: 'Ageing and Society', host_organization_name: 'Cambridge University Press' },
  },
  open_access: { oa_url: 'https://example.org/oa.pdf' },
  cited_by_count: 120,
  abstract_inverted_index: { Older: [0], adults: [1], use: [2], technology: [3] },
};

const CR_WORK = {
  DOI: '10.5220/0010395700002931',
  title: ['From Age to Age: <i>Gerontographics</i>'],
  author: [{ given: 'Cosmina', family: 'Paul' }, { name: 'Grupo de Trabajo' }],
  issued: { 'date-parts': [[2021, 4]] },
  type: 'proceedings-article',
  'container-title': ['Proceedings ICT4AWE'],
  publisher: 'SCITEPRESS',
  URL: 'https://doi.org/10.5220/0010395700002931',
  'is-referenced-by-count': 3,
  abstract: '<jats:title>Abstract</jats:title><jats:p>Older adults adopt technology .</jats:p>',
  license: [{ URL: 'http://creativecommons.org/licenses/by-nc-nd/4.0' }],
};

test('fromOpenAlex normaliza DOI, texto, venue y resumen', () => {
  const r = fromOpenAlex(OA_WORK, { includeAbstract: true });
  assert.equal(r.title, 'Older adults & technology adoption');
  assert.deepEqual(r.authors, ['Arlene J. Astell', 'Colleen McGrath']);
  assert.equal(r.year, 2019);
  assert.equal(r.doi, '10.1017/s0144686x19000230');
  assert.equal(r.venue, 'Ageing and Society');
  assert.equal(r.publisher, 'Cambridge University Press');
  assert.equal(r.url, 'https://www.cambridge.org/x');
  assert.equal(r.openAccessUrl, 'https://example.org/oa.pdf');
  assert.equal(r.citedBy, 120);
  assert.equal(r.openAlexId, 'W123');
  assert.equal(r.abstract, 'Older adults use technology');
  assert.ok(!('abstract' in fromOpenAlex(OA_WORK)));
});

test('fromCrossref limpia etiquetas JATS/HTML y toma el año', () => {
  const r = fromCrossref(CR_WORK, { includeAbstract: true });
  assert.equal(r.title, 'From Age to Age: Gerontographics');
  assert.deepEqual(r.authors, ['Cosmina Paul', 'Grupo de Trabajo']);
  assert.equal(r.year, 2021);
  assert.equal(r.venue, 'Proceedings ICT4AWE');
  assert.equal(r.doi, '10.5220/0010395700002931');
  assert.equal(r.abstract, 'Older adults adopt technology.');
  assert.equal(r.openAccessUrl, 'https://doi.org/10.5220/0010395700002931');
  assert.equal(fromCrossref({ ...CR_WORK, issued: { 'date-parts': [[null]] }, license: [] }).year, null);
  assert.equal(fromCrossref({ ...CR_WORK, license: [] }).openAccessUrl, null);
});

test('limita los autores a 10 e indica cuántos faltan', () => {
  const many = { ...OA_WORK, authorships: Array.from({ length: 13 }, (_, i) => ({ author: { display_name: `A${i}` } })) };
  const r = fromOpenAlex(many);
  assert.equal(r.authors.length, 10);
  assert.equal(r.moreAuthors, 3);
});

test('abstractFromInvertedIndex reordena las palabras', () => {
  assert.equal(abstractFromInvertedIndex({ b: [1], a: [0, 2] }), 'a b a');
  assert.equal(abstractFromInvertedIndex(null), null);
});

test('search en OpenAlex arma la URL con filtros de año, key y contacto', async () => {
  const m = mockFetch(() => json({ meta: { count: 42 }, results: [OA_WORK] }));
  try {
    const s = new ExternalSearch({ openAlexKey: 'KEY', contactEmail: 'yo@example.org' });
    const res = await s.search({ query: 'older adults', source: 'openalex', limit: 5, yearFrom: 2018, yearTo: 2022 });
    const u = new URL(m.calls[0].url);
    assert.equal(u.origin + u.pathname, 'https://api.openalex.org/works');
    assert.equal(u.searchParams.get('search'), 'older adults');
    assert.equal(u.searchParams.get('per-page'), '5');
    assert.equal(u.searchParams.get('filter'), 'from_publication_date:2018-01-01,to_publication_date:2022-12-31');
    assert.equal(u.searchParams.get('api_key'), 'KEY');
    assert.equal(u.searchParams.get('mailto'), 'yo@example.org');
    assert.ok(!u.searchParams.get('select').includes('abstract'));
    assert.match(m.calls[0].headers['User-Agent'], /^zotero-mcp\/.*mailto:yo@example\.org\)$/);
    assert.equal(res.source, 'openalex');
    assert.equal(res.total, 42);
    assert.equal(res.results.length, 1);
    assert.deepEqual(res.warnings, []);
  } finally {
    m.restore();
  }
});

test('sin contacto ni key no se envían datos del usuario', async () => {
  const m = mockFetch(() => json({ meta: { count: 0 }, results: [] }));
  try {
    await new ExternalSearch().search({ query: 'x', source: 'openalex' });
    // Variables sin expandir de mcp_config.json o correo inválido: se ignoran.
    await new ExternalSearch({ openAlexKey: '${OPENALEX_API_KEY}', contactEmail: 'no-es-correo' }).search({ query: 'x', source: 'openalex' });
    for (const call of m.calls) {
      const u = new URL(call.url);
      assert.equal(u.searchParams.get('api_key'), null);
      assert.equal(u.searchParams.get('mailto'), null);
      assert.ok(!call.headers['User-Agent'].includes('mailto'));
    }
  } finally {
    m.restore();
  }
});

test('auto pasa a Crossref si OpenAlex agota la cuota', async () => {
  const m = mockFetch((url) =>
    url.startsWith('https://api.openalex.org')
      ? json({ error: 'quota' }, 429)
      : json({ message: { 'total-results': 7, items: [CR_WORK] } })
  );
  try {
    const res = await new ExternalSearch().search({ query: 'older adults', yearFrom: 2020 });
    assert.equal(m.calls.length, 2);
    const u = new URL(m.calls[1].url);
    assert.equal(u.searchParams.get('query.bibliographic'), 'older adults');
    assert.equal(u.searchParams.get('filter'), 'from-pub-date:2020');
    assert.equal(res.source, 'crossref');
    assert.equal(res.total, 7);
    assert.equal(res.results[0].doi, '10.5220/0010395700002931');
    assert.match(res.warnings[0], /OPENALEX_API_KEY/);
  } finally {
    m.restore();
  }
});

test('una fuente explícita no cae a la otra', async () => {
  const m = mockFetch(() => json({}, 503));
  try {
    await assert.rejects(() => new ExternalSearch().search({ query: 'x', source: 'openalex' }), /OpenAlex: HTTP 503/);
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test('search exige texto', async () => {
  await assert.rejects(() => new ExternalSearch().search({ query: '  ' }), /Indica el texto/);
});

test('lookupDoi usa Crossref y, si no tiene el DOI, OpenAlex', async () => {
  const m = mockFetch((url) => (url.includes('crossref') ? json({}, 404) : json(OA_WORK)));
  try {
    const res = await new ExternalSearch().lookupDoi('https://doi.org/10.1017/S0144686X19000230');
    assert.match(m.calls[0].url, /api\.crossref\.org\/works\/10\.1017%2Fs0144686x19000230$/);
    assert.match(m.calls[1].url, /api\.openalex\.org\/works\/doi:10\.1017%2Fs0144686x19000230$/);
    assert.equal(res.source, 'openalex');
    assert.equal(res.result.title, 'Older adults & technology adoption');
  } finally {
    m.restore();
  }
});

test('lookupDoi informa cuando ninguna fuente tiene el DOI', async () => {
  const m = mockFetch(() => json({}, 404));
  try {
    await assert.rejects(() => new ExternalSearch().lookupDoi('10.1234/nada'), /No se encontró el DOI 10\.1234\/nada/);
    await assert.rejects(() => new ExternalSearch().lookupDoi('no-es-doi'), /no parece un DOI/);
  } finally {
    m.restore();
  }
});
