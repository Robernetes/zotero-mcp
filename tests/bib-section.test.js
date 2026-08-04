import test from 'node:test';
import assert from 'node:assert/strict';
import { updateBibliographySection, extractBibliographySection, isReferenceHeading } from '../src/bib-section.js';

test('reemplaza la sección existente y conserva el resto del documento', () => {
  const doc = [
    '# Mi documento',
    '',
    'Texto con cita [1].',
    '',
    '## Bibliografía',
    'Referencia vieja.',
    '',
    '## Anexo',
    'Contenido final.',
    '',
  ].join('\n');
  const res = updateBibliographySection(doc, 'Smith, J. (2020). Nuevo título.');
  assert.equal(res.applied, true);
  assert.equal(res.sectionFound, true);
  assert.equal(res.heading, '## Bibliografía');
  assert.ok(res.text.includes('Smith, J. (2020). Nuevo título.'));
  assert.ok(!res.text.includes('Referencia vieja.'));
  assert.ok(res.text.includes('## Anexo'));
  assert.ok(res.text.includes('Contenido final.'));
  assert.equal(res.text.split('\n').pop(), '');
});

test('reconoce variantes de encabezado sin # y con #', () => {
  assert.equal(isReferenceHeading('## Bibliografía'), true);
  assert.equal(isReferenceHeading('Referencias'), true);
  assert.equal(isReferenceHeading('References:'), true);
  assert.equal(isReferenceHeading('# BIBLIOGRAFÍA'), true);
  assert.equal(isReferenceHeading('## Introducción'), false);
});

test('crea la sección al final cuando no existe y createSection: true', () => {
  const doc = '# Solo título\n\nTexto.\n';
  const res = updateBibliographySection(doc, 'García, A. (2019). Un libro.', { createSection: true });
  assert.equal(res.applied, true);
  assert.equal(res.sectionFound, false);
  assert.equal(res.created, true);
  assert.ok(res.text.includes('## Bibliografía'));
  assert.ok(res.text.includes('García, A. (2019). Un libro.'));
  assert.ok(res.text.includes('Texto.'));
});

test('no modifica el documento si no hay sección y createSection: false', () => {
  const doc = '# Solo título\n\nTexto.\n';
  const res = updateBibliographySection(doc, 'Algo.');
  assert.equal(res.applied, false);
  assert.equal(res.sectionFound, false);
  assert.equal(res.text, doc);
});

test('sección vacía deja el encabezado limpio', () => {
  const doc = '## Bibliografía\n\nReferencia a borrar.\n\n# Siguiente\n';
  const res = updateBibliographySection(doc, '');
  assert.equal(res.applied, true);
  assert.equal(res.sectionFound, true);
  assert.ok(res.text.includes('## Bibliografía'));
  assert.ok(!res.text.includes('Referencia a borrar.'));
  assert.ok(res.text.includes('# Siguiente'));
});

test('extractBibliographySection devuelve el bloque actual o null', () => {
  const doc = '## Referencias\n\nA.\n\n## Otro\n';
  assert.equal(extractBibliographySection(doc), 'A.');
  assert.equal(extractBibliographySection('# Sin sección\n'), null);
});
