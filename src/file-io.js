// file-io.js
// Lectura y escritura segura de los documentos del usuario (.md / .docx).
//
// - validateFilePath: extensión, existencia, tipo y tamaño; resuelve enlaces
//   simbólicos para operar siempre sobre el archivo real.
// - statFile / readFileForEdit: capturan mtime y tamaño al leer.
// - writeFileAtomic: comprueba que el archivo no cambió desde que se leyó,
//   guarda una copia .bak y escribe en un temporal del mismo directorio que
//   luego se renombra sobre el original (un fallo a mitad no deja el
//   documento corrupto).
// - withFileLock: serializa las operaciones sobre una misma ruta dentro del
//   proceso (p. ej. varias inserciones de citas lanzadas en paralelo).

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Valida la ruta de un documento y devuelve su ruta absoluta real.
 * @param {string} filePath
 * @param {object} opts
 * @param {string[]} opts.extensions Extensiones permitidas, p. ej. ['.md', '.markdown'].
 * @param {number} [opts.maxBytes=MAX_FILE_BYTES]
 * @param {string} [opts.hint] Texto que se añade al error de extensión.
 */
export function validateFilePath(filePath, { extensions, maxBytes = MAX_FILE_BYTES, hint } = {}) {
  const ext = path.extname(String(filePath)).toLowerCase();
  if (!extensions.includes(ext)) {
    const allowed = extensions.join(' o ');
    throw new Error(
      `filePath debe ser un archivo ${allowed} (se recibió "${ext || '(sin extensión)'}").${hint ? ` ${hint}` : ''}`
    );
  }
  const resolved = path.resolve(String(filePath));
  if (!existsSync(resolved)) throw new Error(`El archivo no existe: ${resolved}`);
  const abs = realpathSync(resolved);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`La ruta no es un archivo: ${abs}`);
  if (st.size > maxBytes) {
    throw new Error(`El archivo supera el límite de ${Math.round(maxBytes / (1024 * 1024))} MB; no se modifica.`);
  }
  return abs;
}

/** Huella del archivo para detectar cambios entre la lectura y la escritura. */
export function statFile(abs) {
  const st = statSync(abs);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

/** Lee un archivo capturando antes su huella (si cambia entre ambas, se detecta al escribir). */
export function readFileForEdit(abs, encoding) {
  try {
    const fingerprint = statFile(abs);
    const data = readFileSync(abs, encoding);
    return { data, fingerprint };
  } catch (err) {
    throw translateWriteError(err, abs, 'leer');
  }
}

/**
 * Escribe `data` en `abs` de forma atómica.
 * @param {string} abs Ruta absoluta (de validateFilePath).
 * @param {string|Buffer} data
 * @param {object} [opts]
 * @param {{mtimeMs: number, size: number}} [opts.expected] Huella tomada al leer;
 *   si el archivo cambió desde entonces, no se escribe.
 * @param {boolean} [opts.backup=true] Copiar el original a `<archivo>.bak` antes de reemplazarlo.
 * @returns {{backupPath: string|null}}
 */
export function writeFileAtomic(abs, data, { expected, backup = true } = {}) {
  if (expected) {
    const current = statFile(abs);
    if (current.mtimeMs !== expected.mtimeMs || current.size !== expected.size) {
      throw new Error(
        `El archivo cambió desde que se leyó (${abs}). No se escribió nada para no pisar esos cambios; vuelve a ejecutar la herramienta.`
      );
    }
  }

  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let backupPath = null;
  try {
    const fd = openSync(tmp, 'wx');
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      let offset = 0;
      while (offset < buf.length) offset += writeSync(fd, buf, offset, buf.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (backup) {
      backupPath = `${abs}.bak`;
      copyFileSync(abs, backupPath);
    }
    renameWithRetry(tmp, abs);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // El temporal se queda; no ocultar el error original.
    }
    throw translateWriteError(err, abs);
  }
  return { backupPath };
}

// En Windows, el antivirus o el indexador pueden retener el archivo unos
// milisegundos y el rename falla con EPERM/EBUSY; se reintenta brevemente.
// Si el archivo está abierto en Word, el error persiste y se informa.
function renameWithRetry(from, to, attempts = 5, delayMs = 50) {
  for (let i = 1; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
      if (!transient || i >= attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

/** Convierte errores de E/S en mensajes accionables. `action`: 'escribir' | 'leer'. */
export function translateWriteError(err, abs, action = 'escribir') {
  const code = err && err.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return new Error(
      `No se pudo ${action} ${abs}: el archivo está abierto o bloqueado por otra aplicación (¿Word?) o no hay permisos (${code}). Ciérralo y vuelve a intentarlo; el original no se modificó.`
    );
  }
  if (code === 'ENOSPC') {
    return new Error(`No se pudo escribir ${abs}: no queda espacio en disco. El original no se modificó.`);
  }
  return err;
}

const locks = new Map();

/** Ejecuta `fn` en exclusiva respecto a otras operaciones sobre la misma ruta. */
export async function withFileLock(abs, fn) {
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** Interpreta un booleano de variable de entorno (default si está vacía o no se reconoce). */
export function envFlag(value, defaultValue) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'si', 'sí'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}
