// workspace.js
// Carpetas donde el servidor puede leer y escribir documentos (.md, .docx).
//
// Orden de prioridad:
//   1. ZOTERO_MCP_ALLOWED_DIRS: carpetas indicadas por el usuario (separadas por
//      ";" en Windows y ":" en Linux/macOS).
//   2. Roots del cliente MCP: las carpetas de trabajo que el cliente tiene abiertas.
//   3. La carpeta desde la que se arrancó el servidor (process.cwd()).
// Fuera de esas carpetas no se lee ni se escribe ningún documento.

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { validateFilePath } from './file-io.js';

export const WORKSPACE_SOURCES = { env: 'ZOTERO_MCP_ALLOWED_DIRS', roots: 'roots del cliente MCP', cwd: 'carpeta de arranque del servidor' };

/** Carpetas de ZOTERO_MCP_ALLOWED_DIRS (vacío si no está o es un "${VAR}" sin expandir). */
export function parseAllowedDirs(value, { delimiter = path.delimiter } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (!s || /^\$\{[^}]*\}$/.test(s)) return [];
  return s
    .split(delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
    .map((d) => path.resolve(d));
}

/**
 * Ruta canónica: resuelve enlaces y, en Windows, los nombres cortos 8.3
 * (C:\Users\ROBERT~1 → C:\Users\RobertoAguilar) con realpathSync.native.
 * Si la ruta no existe, se canoniza la carpeta existente más cercana y se le
 * añade el resto, para comparar rutas con la misma forma.
 */
export function canonical(p) {
  const abs = path.resolve(p);
  const rest = [];
  let dir = abs;
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return abs;
    rest.unshift(path.basename(dir));
    dir = parent;
  }
  try {
    return path.join(realpathSync.native(dir), ...rest);
  } catch {
    return abs;
  }
}

/**
 * ¿Está `child` dentro de `parent` (o es la misma ruta)? path.relative ya ignora
 * mayúsculas en Windows; con otra unidad devuelve una ruta absoluta.
 */
export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export class Workspace {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.allowedDirs] Carpetas de ZOTERO_MCP_ALLOWED_DIRS (tienen prioridad).
   * @param {string} [opts.cwd] Último recurso si no hay allowedDirs ni roots.
   */
  constructor({ allowedDirs = [], cwd = process.cwd() } = {}) {
    this.allowedDirs = allowedDirs.map(canonical);
    this.cwd = canonical(cwd);
    this._rootsProvider = null;
    this._cache = null;
  }

  /**
   * Función que devuelve las carpetas (rutas) de los roots del cliente, o null si
   * el cliente no los ofrece. La conecta app.js con el servidor MCP.
   * @param {() => Promise<string[]|null>} provider
   */
  setRootsProvider(provider) {
    this._rootsProvider = provider;
    this._cache = null;
  }

  /** Olvida los roots en caché (el cliente avisó de que cambiaron). */
  invalidate() {
    this._cache = null;
  }

  /** @returns {Promise<{dirs: string[], source: 'env'|'roots'|'cwd'}>} */
  async dirs() {
    if (this.allowedDirs.length > 0) return { dirs: this.allowedDirs, source: 'env' };
    if (this._cache) return this._cache;
    let roots = null;
    if (this._rootsProvider) {
      try {
        roots = await this._rootsProvider();
      } catch {
        roots = null; // el cliente declaró roots pero no respondió: se usa cwd
      }
    }
    this._cache =
      Array.isArray(roots) && roots.length > 0
        ? { dirs: roots.map(canonical), source: 'roots' }
        : { dirs: [this.cwd], source: 'cwd' };
    return this._cache;
  }

  /** Resumen para zotero_status. */
  async describe() {
    const { dirs, source } = await this.dirs();
    const info = { allowedDirs: dirs, source: WORKSPACE_SOURCES[source] };
    if (source === 'cwd') {
      info.note =
        'El cliente MCP no indicó sus carpetas de trabajo (roots), así que solo se permite la carpeta desde la que arrancó el servidor. ' +
        'Para trabajar con documentos en otras carpetas, configura ZOTERO_MCP_ALLOWED_DIRS.';
    }
    return info;
  }

  /**
   * Valida la ruta de un documento: extensión, existencia, tamaño y que esté dentro
   * de las carpetas permitidas (también tras resolver enlaces). Las rutas relativas
   * se resuelven desde la primera carpeta permitida.
   * @returns {Promise<string>} Ruta absoluta canónica.
   */
  async resolve(filePath, opts) {
    const { dirs, source } = await this.dirs();
    const raw = String(filePath ?? '').trim();
    if (!raw) throw new Error('Indica filePath.');
    const abs = path.resolve(dirs[0], raw);
    const outside = (p) => !dirs.some((d) => isInside(p, d));
    const denied = (p) =>
      new Error(
        `"${p}" está fuera de las carpetas permitidas (${dirs.join(', ')}; según ${WORKSPACE_SOURCES[source]}). ` +
          'Usa un documento dentro de la carpeta de trabajo o añade su carpeta a ZOTERO_MCP_ALLOWED_DIRS.'
      );
    // Primero la carpeta (canonizada hasta donde existe): si está fuera, se
    // rechaza sin comprobar si el archivo existe, para no revelarlo.
    if (outside(canonical(abs))) throw denied(abs);
    const real = canonical(validateFilePath(abs, opts));
    // Un enlace (symlink/junction) dentro de la carpeta podría apuntar fuera.
    if (outside(real)) throw denied(real);
    return real;
  }
}
