// file-io.test.js — escritura segura de documentos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateFilePath,
  readFileForEdit,
  writeFileAtomic,
  translateWriteError,
  withFileLock,
  envFlag,
} from '../src/file-io.js';

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'zotero-fileio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('validateFilePath valida extensión, existencia, tipo y tamaño', (t) => {
  const dir = tempDir(t);
  const md = path.join(dir, 'doc.md');
  writeFileSync(md, '# Hola\n');
  assert.equal(validateFilePath(md, { extensions: ['.md'] }), path.resolve(md));
  assert.throws(
    () => validateFilePath(path.join(dir, 'doc.txt'), { extensions: ['.md', '.markdown'], hint: 'Usa otra herramienta.' }),
    /\.md o \.markdown \(se recibió "\.txt"\)\. Usa otra herramienta\./
  );
  assert.throws(() => validateFilePath(path.join(dir, 'nada.md'), { extensions: ['.md'] }), /no existe/);
  assert.throws(() => validateFilePath(md, { extensions: ['.md'], maxBytes: 3 }), /supera el límite/);
});

test('writeFileAtomic reemplaza el contenido, crea .bak y no deja temporales', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'doc.md');
  writeFileSync(file, 'original');
  const { fingerprint } = readFileForEdit(file, 'utf8');

  const { backupPath } = writeFileAtomic(file, 'nuevo', { expected: fingerprint });
  assert.equal(readFileSync(file, 'utf8'), 'nuevo');
  assert.equal(backupPath, `${file}.bak`);
  assert.equal(readFileSync(backupPath, 'utf8'), 'original');
  assert.deepEqual(readdirSync(dir).sort(), ['doc.md', 'doc.md.bak']);
});

test('writeFileAtomic sin backup no crea .bak y acepta buffers', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'doc.docx');
  writeFileSync(file, Buffer.from([1, 2, 3]));
  const { backupPath } = writeFileAtomic(file, Buffer.from([4, 5]), { backup: false });
  assert.equal(backupPath, null);
  assert.deepEqual([...readFileSync(file)], [4, 5]);
  assert.equal(existsSync(`${file}.bak`), false);
});

test('writeFileAtomic no escribe si el archivo cambió desde que se leyó', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'doc.md');
  writeFileSync(file, 'v1');
  const { fingerprint } = readFileForEdit(file, 'utf8');

  // Otro editor guarda el archivo entre la lectura y la escritura.
  writeFileSync(file, 'v2 editado a mano');
  const later = new Date(fingerprint.mtimeMs + 5000);
  utimesSync(file, later, later);

  assert.throws(() => writeFileAtomic(file, 'v3', { expected: fingerprint }), /cambió desde que se leyó/);
  assert.equal(readFileSync(file, 'utf8'), 'v2 editado a mano');
  assert.deepEqual(readdirSync(dir), ['doc.md']);
});

test('translateWriteError da un mensaje accionable para archivos bloqueados', () => {
  const err = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  assert.match(translateWriteError(err, 'C:/x/doc.docx').message, /abierto o bloqueado.*Word.*no se modificó/);
  const other = new Error('otro');
  assert.equal(translateWriteError(other, 'x'), other);
});

test('withFileLock serializa operaciones sobre la misma ruta', async () => {
  const order = [];
  const slow = (label, ms) =>
    withFileLock('C:/docs/Paper.docx', async () => {
      order.push(`start ${label}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${label}`);
      return label;
    });
  const results = await Promise.all([slow('a', 30), slow('b', 1), slow('c', 1)]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('withFileLock libera el bloqueo aunque la operación falle', async () => {
  await assert.rejects(() => withFileLock('/tmp/x.md', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withFileLock('/tmp/x.md', async () => 'ok'), 'ok');
});

test('envFlag interpreta valores booleanos y usa el default si no reconoce', () => {
  assert.equal(envFlag('false', true), false);
  assert.equal(envFlag('0', true), false);
  assert.equal(envFlag('TRUE', false), true);
  assert.equal(envFlag('', true), true);
  assert.equal(envFlag(undefined, true), true);
  assert.equal(envFlag('${ZOTERO_MCP_BACKUP}', true), true);
});
