import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace, canonical, isInside, parseAllowedDirs } from '../src/workspace.js';

const MD = { extensions: ['.md'] };

function sandbox(t) {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'zmcp-ws-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const inside = path.join(base, 'proyecto');
  const outside = path.join(base, 'otra');
  mkdirSync(inside);
  mkdirSync(outside);
  writeFileSync(path.join(inside, 'doc.md'), '# Doc\n');
  writeFileSync(path.join(outside, 'secreto.md'), '# Fuera\n');
  return { base, inside, outside };
}

test('parseAllowedDirs separa por el delimitador e ignora vacíos y variables sin expandir', () => {
  assert.deepEqual(parseAllowedDirs(undefined), []);
  assert.deepEqual(parseAllowedDirs('  '), []);
  assert.deepEqual(parseAllowedDirs('${ZOTERO_MCP_ALLOWED_DIRS}'), []);
  const dirs = parseAllowedDirs(' /a/tesis ; "/b/con espacio" ;; ', { delimiter: ';' });
  assert.deepEqual(dirs, [path.resolve('/a/tesis'), path.resolve('/b/con espacio')]);
});

test('isInside no confunde prefijos ni sale con ..', () => {
  const root = path.resolve('/docs/tesis');
  assert.ok(isInside(path.join(root, 'cap1.md'), root));
  assert.ok(isInside(root, root));
  assert.ok(isInside(path.join(root, '..carpeta', 'a.md'), root), 'un nombre que empieza por ".." sigue dentro');
  assert.ok(!isInside(path.resolve('/docs/tesis2/cap1.md'), root));
  assert.ok(!isInside(path.resolve('/docs/otra.md'), root));
  assert.ok(!isInside(path.resolve('/docs'), root));
  if (process.platform === 'win32') {
    assert.ok(isInside('C:\\Docs\\Tesis\\a.md', 'c:\\docs\\tesis'), 'Windows no distingue mayúsculas');
    assert.ok(!isInside('D:\\docs\\tesis\\a.md', 'C:\\docs\\tesis'), 'otra unidad');
  } else {
    assert.ok(!isInside('/Docs/Tesis/a.md', '/docs/tesis'), 'Linux/macOS distinguen mayúsculas');
  }
});

test('resolve permite documentos dentro y rechaza los de fuera sin revelar si existen', async (t) => {
  const { inside, outside } = sandbox(t);
  const ws = new Workspace({ allowedDirs: [inside] });
  assert.equal(await ws.resolve(path.join(inside, 'doc.md'), MD), path.join(inside, 'doc.md'));
  // Las rutas relativas se resuelven desde la carpeta permitida.
  assert.equal(await ws.resolve('doc.md', MD), path.join(inside, 'doc.md'));
  await assert.rejects(() => ws.resolve(path.join(outside, 'secreto.md'), MD), /fuera de las carpetas permitidas/);
  await assert.rejects(() => ws.resolve(path.join(outside, 'no-existe.md'), MD), /fuera de las carpetas permitidas/);
  await assert.rejects(() => ws.resolve('../otra/secreto.md', MD), /fuera de las carpetas permitidas/);
  await assert.rejects(() => ws.resolve('', MD), /Indica filePath/);
  // Dentro, siguen valiendo las comprobaciones de siempre.
  await assert.rejects(() => ws.resolve('nada.md', MD), /no existe/);
  await assert.rejects(() => ws.resolve('doc.md', { extensions: ['.docx'] }), /debe ser un archivo .docx/);
});

test('resolve rechaza un enlace dentro de la carpeta que apunta fuera', async (t) => {
  const { inside, outside } = sandbox(t);
  try {
    // "junction" no requiere permisos de administrador en Windows; en Linux/macOS se ignora.
    symlinkSync(outside, path.join(inside, 'enlace'), 'junction');
  } catch (err) {
    t.skip(`no se pudo crear el enlace: ${err.code}`);
    return;
  }
  const ws = new Workspace({ allowedDirs: [inside] });
  await assert.rejects(() => ws.resolve('enlace/secreto.md', MD), /fuera de las carpetas permitidas/);
});

test('dirs: ZOTERO_MCP_ALLOWED_DIRS, luego roots del cliente y por último cwd', async (t) => {
  const { inside, outside } = sandbox(t);
  const withEnv = new Workspace({ allowedDirs: [inside], cwd: outside });
  withEnv.setRootsProvider(async () => [outside]);
  assert.deepEqual(await withEnv.dirs(), { dirs: [inside], source: 'env' });

  let calls = 0;
  const withRoots = new Workspace({ cwd: outside });
  withRoots.setRootsProvider(async () => {
    calls++;
    return [inside];
  });
  assert.deepEqual(await withRoots.dirs(), { dirs: [inside], source: 'roots' });
  await withRoots.dirs();
  assert.equal(calls, 1, 'los roots se guardan en caché');
  withRoots.invalidate();
  await withRoots.dirs();
  assert.equal(calls, 2, 'se vuelven a pedir tras invalidate');

  const noRoots = new Workspace({ cwd: outside });
  noRoots.setRootsProvider(async () => null);
  assert.deepEqual(await noRoots.dirs(), { dirs: [outside], source: 'cwd' });

  const failing = new Workspace({ cwd: outside });
  failing.setRootsProvider(async () => {
    throw new Error('el cliente no respondió');
  });
  assert.deepEqual(await failing.dirs(), { dirs: [outside], source: 'cwd' });
  assert.deepEqual((await failing.describe()).source, 'carpeta de arranque del servidor');
});

test('canonical une formas distintas de la misma ruta (nombres cortos 8.3 en Windows)', async (t) => {
  const { inside } = sandbox(t);
  assert.equal(canonical(path.join(inside, 'no-existe', 'x.md')), path.join(inside, 'no-existe', 'x.md'));
  if (process.platform !== 'win32') return;
  // tmpdir() suele venir con el nombre corto (C:\Users\ROBERT~1\...): debe dar lo mismo que el largo.
  const short = tmpdir();
  const long = realpathSync.native(short);
  assert.equal(canonical(short), long);
  const ws = new Workspace({ allowedDirs: [long] });
  const file = path.join(inside, 'doc.md');
  const viaShort = path.join(short, path.relative(long, file));
  assert.equal(await ws.resolve(viaShort, MD), canonical(file));
});
