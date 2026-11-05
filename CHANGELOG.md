# Changelog

Todos los cambios relevantes de zotero-mcp. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa
[versionado semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Añadido

- Sección «Uso con otros clientes MCP» en los README: Claude Code, Claude Desktop,
  Cursor, VS Code, Windsurf y Gemini CLI.
- Los estilos y locales disponibles se leen de `src/csl/` y `src/locales/`: basta con
  copiar un `.csl` o un `locales-<código>.xml` y reiniciar el cliente MCP.
- `zotero_insert_citation_docx` cita justo después de la frase que respalda la fuente
  (`afterText`, un fragmento del texto del párrafo) y agrupa varias fuentes en una sola
  cita (`keys`): "(Costin et al., 2016; Pang et al., 2021)". La respuesta incluye
  `preview` con el texto alrededor de la cita.
- La skill `zotero-research` explica cómo citar: junto a la afirmación que respalda cada
  fuente, agrupando las de una misma idea y sin amontonar citas al final del párrafo.
- `scripts/e2e.mjs` rechaza las llamadas con `apply: true` salvo con `--allow-write`,
  y explica el error cuando el JSON llega roto (Windows PowerShell 5.1).

### Cambiado

- Un locale que no está disponible usa otro del mismo idioma (`es-MX` → `es-ES`) antes
  de recurrir a `en-US`; antes las citas salían en inglés.
- Se quitó el parámetro `dryRun` de `zotero_bibliography`, `zotero_insert_citation_docx`
  y `zotero_update_bibliography_docx`: no tenía efecto, porque el modo lo decide `apply`.

### Corregido

- `zotero_insert_citation_docx` pegaba la cita detrás del punto y sin espacio
  ("…del software.(Autor, 2020)"); ahora va antes de la puntuación que cierra la
  frase y separada por un espacio: "…del software (Autor, 2020).". La numeración
  (IEEE, Vancouver) tiene en cuenta las citas posteriores del mismo párrafo, y la vista
  previa indica `documentPrefs: "se crearían"` en lugar de `"creadas"`.
- El README en inglés indicaba que `createSection` crea `## Bibliography`; el encabezado
  es `## Bibliografía`. Los README también decían que bastaba con copiar un estilo a
  `src/csl/`, lo que no era cierto hasta este cambio.
- `scripts/smoke.mjs` ya no envía `shutdown`, que no es un método de MCP, y los scripts
  de instalación ejecutan `npm install` desde la raíz del proyecto.

- Una variable de entorno que llega como `${VAR}` sin expandir (p. ej. al copiar
  `mcp_config.json` a otro cliente) se ignora y se usa el valor por defecto; antes
  `ZOTERO_API_URL` quedaba con el texto literal y no se podía conectar con Zotero.

### Seguridad

- Los documentos `.md` y `.docx` solo se leen y escriben dentro de las carpetas
  permitidas: las de la nueva variable `ZOTERO_MCP_ALLOWED_DIRS`; si no está, las
  carpetas de trabajo que indica el cliente MCP (*roots*, actualizadas cuando
  cambian); y si no indica ninguna, la carpeta de arranque del servidor. Se
  rechazan los enlaces que apuntan fuera y las rutas relativas se resuelven desde la
  carpeta de trabajo. `zotero_status` muestra las carpetas permitidas en `workspace`.

## [0.2.0] - 2026-11-03

### Añadido

- **Búsqueda fuera de la biblioteca** (`zotero_find_external`): por tema, título,
  autor o DOI en OpenAlex, con respaldo en Crossref si OpenAlex falla o se agota su
  cuota. Indica en `inLibrary` qué resultados ya están en Zotero (por DOI, también
  en el campo Extra, o por título normalizado).
- **Guardar en la biblioteca** (`zotero_add_item`): guarda una publicación por DOI
  u `openAlexId` en la colección indicada y con etiquetas, a través del conector de
  Zotero. Vista previa sin `apply: true` y sin duplicados salvo `allowDuplicate: true`.
- **Compatibilidad con el plugin de Zotero para Word**: las citas usan el formato del
  plugin (URI del item en la biblioteca, `citationID` aleatorio, `noteIndex` 0), se
  crean las preferencias del documento (`ZOTERO_PREF_n`) si faltan, para que *Refresh*
  no pida estilo, y `style`/`locale` salen de esas preferencias si no se indican.
  La bibliografía tiene un párrafo por referencia con el estilo *Bibliography*.
- **Escritura segura de `.md` y `.docx`**: escritura atómica, copia `<archivo>.bak`
  (`ZOTERO_MCP_BACKUP`), rechazo si el archivo cambió en disco desde que se leyó,
  bloqueo por archivo para llamadas en paralelo y mensajes claros si el documento
  está abierto en Word.
- `zotero_list_collections` devuelve `parentKey` y no se corta en 100 colecciones.
- Variables opcionales `OPENALEX_API_KEY` y `ZOTERO_MCP_CONTACT_EMAIL` para la
  búsqueda externa; sin ellas no se envía ningún dato del usuario.
- CI con GitHub Actions: pruebas y smoke test en Node 18, 20, 22 y 24 (Linux) y
  Node 22 (Windows), y `npm audit` en cada push a `main` y cada pull request.

### Cambiado

- `zotero_insert_citation_docx` calcula el texto de la cita (numeración,
  desambiguación) con las citas del propio documento, no con el registro en memoria
  de la sesión; `zotero_update_bibliography_docx` genera las referencias desde los
  campos de cita del documento.
- `@modelcontextprotocol/sdk` 1.32.2 y zod 4.
- `server.js` dividido en módulos (`app.js`, `context.js`, `src/tools/`) y migrado de
  `server.tool` (obsoleto) a `registerTool`. Las herramientas no cambian.
- La versión del servidor y del User-Agent se lee de `package.json`.

### Corregido

- Word: abrir y guardar un `.docx` reordenaba tablas e hipervínculos y alteraba texto
  numérico (`007`, `1.50`); la bibliografía podía salir vacía.
- Markdown: actualizar la sección de referencias borraba el texto anterior al
  encabezado; ya no se escribe una bibliografía vacía ni más corta que la actual sin
  `force: true`.
- Las citas incluían entidades HTML (`&#38;`).
- Al desambiguar (`2020a`/`2020b`) se devolvía la cita nueva concatenada con las
  actualizadas.
- Con más de 100 citas, la bibliografía fallaba con un falso «No se encontraron en
  Zotero los items».

### Seguridad

- Corregidas las vulnerabilidades de las dependencias (`npm audit`: de 9 paquetes
  vulnerables, 1 crítico y 4 altos, a 0).

## [0.1.0] - 2026-08-04

### Añadido

- Servidor MCP para la API local de Zotero: `zotero_status`, `zotero_search`,
  `zotero_get_item`, `zotero_list_collections`, `zotero_cite` y
  `zotero_bibliography`, con la sección de referencias de Markdown auto-actualizable.
- Citas con citeproc-js en 6 estilos CSL (APA, MLA, Chicago autor-fecha, Harvard,
  IEEE, Vancouver) y locales `es-ES` y `en-US`.
- Documentos Word: `zotero_read_docx`, `zotero_insert_citation_docx` y
  `zotero_update_bibliography_docx`.
- Skill `zotero-research`.

[Sin publicar]: https://github.com/Robernetes/zotero-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Robernetes/zotero-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Robernetes/zotero-mcp/releases/tag/v0.1.0
