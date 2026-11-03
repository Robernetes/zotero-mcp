// version.js
// Versión del paquete, leída de package.json (única fuente de verdad).

import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json');

export const NAME = pkg.name;
export const VERSION = pkg.version;
