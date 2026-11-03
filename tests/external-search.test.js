import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExternalSearch,
  fromCrossref,
  fromOpenAlex,
  abstractFromInvertedIndex,
  crossrefToCsl,
  openAlexToCsl,
} from '../src/external-search.js';

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

test('crossrefToCsl produce CSL válido para el traductor de Zotero', () => {
  const csl = crossrefToCsl({
    ...CR_WORK,
    DOI: '10.5220/0010395700002931',
    subtitle: ['A Review'],
    'container-title': ['Proceedings ICT4AWE'],
    'short-container-title': ['Proceedings ICT4AWE'],
    event: { name: 'ICT4AWE 2021' },
    page: '12-20',
    ISSN: ['1234-5678', '8765-4321'],
    reference: [{ key: 'ref1' }],
  });
  assert.equal(csl.type, 'paper-conference');
  assert.equal(csl.title, 'From Age to Age: Gerontographics: A Review');
  assert.deepEqual(csl.author, [{ family: 'Paul', given: 'Cosmina' }, { literal: 'Grupo de Trabajo' }]);
  assert.deepEqual(csl.issued, { 'date-parts': [[2021, 4]] });
  assert.equal(csl['event-title'], 'ICT4AWE 2021');
  assert.equal(csl.ISSN, '1234-5678');
  assert.equal(csl.URL, 'https://doi.org/10.5220/0010395700002931');
  assert.equal(csl.abstract, 'Older adults adopt technology.');
  assert.ok(!('container-title-short' in csl), 'título corto igual al completo');
  assert.ok(!('reference' in csl) && !('license' in csl), 'solo variables CSL');
  assert.equal(crossrefToCsl({ type: 'journal-article', title: ['T'], DOI: '10.1000/ABC' }).DOI, '10.1000/ABC');
  assert.equal(crossrefToCsl({ type: 'monograph', title: ['T'] }).type, 'book');
  assert.equal(crossrefToCsl({ type: 'algo-raro', title: ['T'] }).type, 'document');
  const tesis = crossrefToCsl({ type: 'dissertation', title: ['T'], institution: [{ name: 'Universidad X' }] });
  assert.equal(tesis.type, 'thesis');
  assert.equal(tesis.publisher, 'Universidad X');
});

test('openAlexToCsl divide nombres, arma páginas y fecha', () => {
  const csl = openAlexToCsl({
    ...OA_WORK,
    publication_date: '2019-03-19',
    biblio: { volume: '40', issue: '7', first_page: '1550', last_page: '1576' },
    language: 'en',
    primary_location: { ...OA_WORK.primary_location, source: { ...OA_WORK.primary_location.source, type: 'journal', issn_l: '0144-686X' } },
  });
  assert.equal(csl.type, 'article-journal');
  assert.deepEqual(csl.author[0], { given: 'Arlene J.', family: 'Astell' });
  assert.deepEqual(csl.issued, { 'date-parts': [[2019, 3, 19]] });
  assert.equal(csl.page, '1550-1576');
  assert.equal(csl['container-title'], 'Ageing and Society');
  assert.equal(csl.ISSN, '0144-686X');
  assert.equal(csl.DOI, '10.1017/s0144686x19000230');
  assert.equal(csl.abstract, 'Older adults use technology');
  const repo = openAlexToCsl({ id: 'https://openalex.org/W9', display_name: 'Tesis', type: 'article', publication_year: 2020, primary_location: { landing_page_url: 'https://repo.edu/1', source: { type: 'repository', display_name: 'Repo' } } });
  assert.equal(repo.type, 'article');
  assert.ok(!('container-title' in repo));
  assert.equal(repo.URL, 'https://repo.edu/1');
  assert.deepEqual(repo.issued, { 'date-parts': [[2020]] });
});

test('fetchCsl acepta openAlexId con o sin URL y rechaza ids inválidos', async () => {
  const m = mockFetch(() => json(OA_WORK));
  try {
    const s = new ExternalSearch();
    const r = await s.fetchCsl({ openAlexId: 'https://openalex.org/w123' });
    assert.equal(m.calls[0].url, 'https://api.openalex.org/works/W123');
    assert.equal(r.source, 'openalex');
    await assert.rejects(() => s.fetchCsl({ openAlexId: 'X1' }), /no parece un id de OpenAlex/);
    await assert.rejects(() => s.fetchCsl({}), /Indica doi u openAlexId/);
  } finally {
    m.restore();
  }
});

test('fetchCsl por DOI conserva las mayúsculas con que se escribió', async () => {
  const m = mockFetch(() => json({ message: { type: 'journal-article', title: ['T'], DOI: '10.1017/s0144686x19000230' } }));
  try {
    const { source, csl } = await new ExternalSearch().fetchCsl({ doi: 'https://doi.org/10.1017/S0144686X19000230' });
    assert.equal(source, 'crossref');
    assert.equal(csl.DOI, '10.1017/S0144686X19000230');
    assert.equal(csl.URL, 'https://doi.org/10.1017/S0144686X19000230');
    assert.equal(csl.type, 'article-journal');
  } finally {
    m.restore();
  }
});
