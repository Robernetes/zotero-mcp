# zotero-mcp — instrucciones para agentes

Servidor MCP por stdio (Node ≥ 18, ESM, JavaScript sin compilar) para la biblioteca
local de Zotero, empaquetado como plugin de Antigravity (`plugin.json`,
`mcp_config.json`, `skills/`). Lee de la API local de Zotero, guarda items nuevos a
través del conector de Zotero y edita documentos `.md`/`.docx` del usuario.
Uso, herramientas y configuración para el usuario: `README.md`.

## Mapa del repositorio

- `src/server.js`: entrada stdio. `src/app.js`: `createServer(ctx)` registra todas las herramientas (los tests lo usan en memoria).
- `src/context.js`: variables de entorno → `config` y clientes compartidos (`ToolContext`).
- `src/tools/`: registro de herramientas por área (`library`, `citations` = Markdown, `word` = `.docx`, `external`); `shared.js` tiene `ok`/`fail`/`run`.
- `src/zotero-client.js` (API local, lectura), `src/zotero-connector.js` (conector, guardar), `src/external-search.js` (OpenAlex/Crossref).
- `src/cite.js` (citeproc y registro de citas en memoria), `src/bib-section.js` (sección de referencias en Markdown), `src/docx.js` (OOXML y campos `ZOTERO_ITEM`/`ZOTERO_BIBL`), `src/file-io.js` (escritura segura), `src/workspace.js` (carpetas permitidas).
- `src/csl/`, `src/locales/`: estilos y locales CSL de terceros (CC-BY-SA 3.0); no editarlos a mano.
- `skills/zotero-research/SKILL.md`: instrucciones para el agente que *usa* el MCP.
- `estructura-skills-mcp-plugins-antigravity.md`: guía genérica de plugins de Antigravity con ejemplos ficticios (SQL, SAP); no describe este proyecto.

## Límites de arquitectura

- Solo `src/server.js`, `src/app.js` y `src/tools/` importan `@modelcontextprotocol/sdk` o `zod`. Los clientes y la lógica de documentos no dependen de MCP.
- Las herramientas reciben sus dependencias por `ctx`; no crean clientes ni leen `process.env`. Una variable nueva se lee en `loadConfig` con `envValue` (que ignora `${VAR}` sin expandir) y se añade a `.env.example`, `mcp_config.json` y la tabla de configuración de ambos README.
- Los handlers envuelven la lógica en `run(...)` y responden con `ok(payload)` / `fail(mensaje)`; los errores son mensajes en español que dicen qué hacer.
- stdout es el canal JSON-RPC: nada de `console.log` en `src/`; diagnóstico solo con `console.error`.
- Toda ruta de documento pasa por `workspace.resolve(filePath, { extensions })` antes de leerla.
- Toda escritura de documento va dentro de `withFileLock`, lee con `readFileForEdit`/`openDocx` y escribe con `writeFileAtomic`/`saveDocx` (huella mtime/tamaño, `.bak`, renombrado atómico). Nunca `fs.writeFile` directo sobre un documento.
- Las herramientas que escriben solo lo hacen con `apply: true`; sin él devuelven vista previa.
- Biblioteca de Zotero: solo lectura por la API local; la única escritura es `zotero_add_item` (conector, `apply: true`). No añadir operaciones que editen o borren items.
- `src/docx.js` parsea con `preserveOrder` y sin procesar entidades para que abrir → guardar reproduzca el documento: decodificar con `decodeXml` al leer y codificar con `encodeXml` al crear nodos. No cambiar `XML_OPTS` sin pruebas de ida y vuelta en `tests/docx.test.js`.
- Las citas `.docx` siguen el formato del plugin de Word (URI del item, `citationID` aleatorio, `noteIndex` 0) y `ensureDocumentPrefs` nunca pisa preferencias existentes.
- Estilos y locales: `AVAILABLE_STYLES` y `LOCALES` en `src/cite.js` se leen de `src/csl/<nombre>.csl` y `src/locales/locales-<código>.xml` al arrancar; no hay listas fijas que mantener.
- La versión sale solo de `package.json` (`src/version.js`).

## Comandos

- Instalar: `npm install` (CI usa `npm ci`).
- Pruebas: `npm test` (`node --test`, descubre `tests/*.test.js`; no necesita Zotero ni red).
- Smoke: `node scripts/smoke.mjs`; debe acabar en `OK: todas las herramientas esperadas están presentes.`
- Arrancar: `npm start` (stdio; se queda esperando JSON-RPC).
- Dependencias: `npm audit --omit=dev --audit-level=high` (igual que CI).
- No hay linter, formatter ni typecheck. Sigue el estilo existente: ESM, comillas simples, punto y coma, 2 espacios, JSDoc en funciones exportadas.

## Pruebas

- Herramientas MCP: `tests/server.test.js` con `fakeContext()` + `InMemoryTransport`. Clientes HTTP: stub de `globalThis.fetch`, restaurado al terminar.
- Archivos de prueba en `mkdtempSync(path.join(tmpdir(), ...))`, borrados al terminar.
- Cada bug corregido lleva su prueba de regresión.
- CI (`.github/workflows/ci.yml`): Node 18, 20, 22 y 24 en Linux y Node 22 en Windows. No uses APIs que no existan en Node 18 y cuida rutas y bloqueos de archivos en Windows.

## Datos del usuario y seguridad

- Nunca modifiques documentos reales del usuario: prueba con copias en una carpeta temporal.
- Contra el Zotero real no ejecutes nada que escriba (`zotero_add_item` con `apply: true`) ni herramientas de documentos con `apply: true` sobre documentos del usuario, salvo que el dueño lo pida.
- `scripts/e2e.mjs` llama al servidor contra el Zotero real: úsalo solo con herramientas de lectura (rechaza `apply: true` salvo con `--allow-write`; no lo pases sin que el dueño lo pida). En Windows, ejecútalo desde Git Bash o PowerShell 7 (`pwsh`); Windows PowerShell 5.1 quita las comillas del JSON.
- A OpenAlex/Crossref solo se envían la consulta o el DOI (y `OPENALEX_API_KEY`/`ZOTERO_MCP_CONTACT_EMAIL` si están). No envíes contenido de documentos ni de la biblioteca.
- No commitees `.env`. El servidor no lee `.env`: las variables llegan del cliente MCP vía `mcp_config.json`.

## Al cambiar herramientas MCP

Si añades, renombras o cambias parámetros de una herramienta, actualiza en el mismo cambio:

- `EXPECTED` en `scripts/smoke.mjs` (si cambia la lista);
- los comentarios de cabecera de `src/server.js` y `src/app.js`;
- la tabla de herramientas y los ejemplos de ambos README;
- `skills/zotero-research/SKILL.md`, si cambia el flujo del agente;
- `CHANGELOG.md`.

## Idioma y documentación

- Código, comentarios, mensajes de error, descripciones de herramientas, CHANGELOG y commits: en español.
- `README.md` (inglés) y `README-SPANISH.md` (español) son espejo: mismas secciones, tablas y ejemplos. Un cambio en uno se hace en el otro en el mismo commit.
- `CHANGELOG.md` sigue Keep a Changelog: las entradas nuevas van en `## [Sin publicar]`, en Añadido / Cambiado / Corregido / Seguridad.
- Release: versión en `package.json` y `package-lock.json`, mover `[Sin publicar]` a `## [X.Y.Z] - AAAA-MM-DD`, actualizar los enlaces de comparación al final del CHANGELOG; commit `chore(release): versión X.Y.Z`. Las versiones publicadas tienen tag `vX.Y.Z`.

## Git

- Commit y push solo cuando el dueño lo pida.
- Rama desde `main` con prefijo de tipo (`feat/`, `fix/`, `docs/`, `chore/`, `ci/`, `refactor/`, `release/`) y PR hacia `main`; no commitees directamente en `main`. Nunca force push.
- Mensajes: `tipo(ámbito): descripción` en español y en minúscula; el cuerpo explica qué cambia y por qué.
- Los commits van a nombre de Roberto Aguilar con la identidad git local del repo; no la cambies.
- Nunca añadas `Co-Authored-By: Claude` ni "Generated with Claude Code" en commits ni PRs.

## Antes de terminar

1. `npm test`
2. `node scripts/smoke.mjs`
3. Si cambiaron dependencias: `npm audit --omit=dev --audit-level=high`
4. Si el cambio es visible al usuario: ambos README y `CHANGELOG.md` actualizados.
