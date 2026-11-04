# zotero-mcp

[![CI](https://github.com/Robernetes/zotero-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Robernetes/zotero-mcp/actions/workflows/ci.yml)

Servidor **MCP** conectado a la **biblioteca local de Zotero**, empaquetado como plugin de **Antigravity** y utilizable desde cualquier cliente MCP ([otros clientes](#uso-con-otros-clientes-mcp)), para:

- **Buscar** items en la biblioteca (por texto, tipo y colección).
- **Citar** con estilos CSL: APA, MLA, Chicago (author-date), Harvard, IEEE y Vancouver.
- **Actualizar la bibliografía automáticamente**: al añadir una cita nueva, la sección de referencias del documento se regenera sola.

Instalable desde GitHub con:

```powershell
agy plugin install https://github.com/Robernetes/zotero-mcp
```

## ¿Qué puede hacer la IA con este MCP?

- **Responder preguntas sobre tu biblioteca**: buscar fuentes sobre un tema, filtrar por tipo (artículos, libros, tesis) o por colección, y obtener el detalle completo de cualquier item (resumen, autores, año, URL, DOI).
- **Citar correctamente**: generar citas en texto con el estilo correcto (APA, MLA, Chicago, Harvard, IEEE, Vancouver) e idioma (es-ES, en-US), con localizador de página (`(Autor, 2020, p. 15)`), prefijos y sufijos.
- **Redactar documentos académicos con referencias reales**: la IA inserta las citas y mantiene la bibliografía sincronizada: añade citas con `zotero_cite` y la sección de referencias del documento se regenera sola con `zotero_bibliography`.
- **Encontrar fuentes nuevas**: buscar fuera de tu biblioteca (OpenAlex y Crossref) por tema, título, autor o DOI, ver cuáles de los resultados ya están en tu biblioteca y guardar los que elijas (por DOI) en una colección.
- **Verificar fuentes**: nunca inventa referencias; todo item se valida contra Zotero antes de citar.
- **Diagnosticar**: `zotero_status` indica si Zotero está disponible.

**Límites:** el MCP solo puede **añadir** items nuevos (`zotero_add_item`, con Zotero abierto); nunca edita ni borra los existentes. Guarda solo los metadatos (sin PDF).

## Requisitos

- **Zotero** instalado y abierto, con el ajuste
  *"Allow other applications on this computer to communicate with Zotero"* habilitado
  (Editar → Configuración → Avanzado). El servidor usa la API local (puerto 23119), sin API key.
- **Node.js ≥ 18** (probado con Node 24).

## Instalación

```powershell
agy plugin install https://github.com/Robernetes/zotero-mcp
```

Si el plugin no ejecuta la instalación de dependencias automáticamente:

```powershell
git clone https://github.com/Robernetes/zotero-mcp
cd zotero-mcp
npm install          # o: powershell -File scripts/setup.ps1  /  sh scripts/setup.sh
```

## Uso con otros clientes MCP

El servidor es un servidor MCP estándar (stdio), así que funciona con cualquier cliente MCP, no solo con Antigravity: Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI… Solo `plugin.json` y `mcp_config.json` son específicos del plugin de Antigravity.

1. Clona el repositorio e instala las dependencias (ver [Instalación](#instalación)).
2. Registra el servidor en tu cliente con `node` y la **ruta absoluta** a `src/server.js`. En Windows puedes escribir la ruta con `/` para no tener que escapar `\\` en JSON.
3. Pasa en `env` las variables que necesites (ver [Configuración](#configuración)). Escribe valores reales: los `${VAR}` como los de `mcp_config.json` solo funcionan en clientes que expanden variables de entorno (si uno llega sin expandir, el servidor lo ignora y usa el valor por defecto).
4. Reinicia el cliente y ejecuta `zotero_status`: `ok: true` confirma la conexión con Zotero, y `workspace` muestra las carpetas donde se pueden leer y escribir documentos. Si `source` es la carpeta de arranque del servidor, el cliente no indica sus carpetas de trabajo (*roots*): define `ZOTERO_MCP_ALLOWED_DIRS` con las carpetas de tus documentos.

**Claude Code** (`--scope user` lo deja disponible en todos tus proyectos):

```powershell
claude mcp add zotero --scope user -e ZOTERO_LOCALE=es-ES -- node C:/ruta/a/zotero-mcp/src/server.js
```

Para usar también la skill `zotero-research`, copia la carpeta `skills/zotero-research` a `~/.claude/skills/` (o a `.claude/skills/` en un proyecto).

**Claude Desktop, Cursor, Windsurf, Gemini CLI** y la mayoría de clientes usan un bloque `mcpServers`:

```json
{
  "mcpServers": {
    "zotero": {
      "command": "node",
      "args": ["C:/ruta/a/zotero-mcp/src/server.js"],
      "env": {
        "ZOTERO_DEFAULT_STYLE": "apa",
        "ZOTERO_LOCALE": "es-ES",
        "ZOTERO_MCP_ALLOWED_DIRS": "C:/Users/tu-usuario/Documents/Tesis"
      }
    }
  }
}
```

| Cliente | Archivo de configuración |
|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (Windows), `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Cursor | `~/.cursor/mcp.json` (global) o `.cursor/mcp.json` (proyecto) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |

`ZOTERO_MCP_ALLOWED_DIRS` es especialmente útil en clientes sin carpeta de proyecto, como Claude Desktop.

**VS Code** (`.vscode/mcp.json` en el proyecto) usa la clave `servers` y el tipo `stdio`:

```json
{
  "servers": {
    "zotero": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/ruta/a/zotero-mcp/src/server.js"],
      "env": { "ZOTERO_LOCALE": "es-ES" }
    }
  }
}
```

## Configuración

El servidor funciona sin configuración (usa los valores por defecto). Variables opcionales
(definidas en `.env.example`; se pasan al servidor vía `mcp_config.json` con `${VAR}`):

| Variable | Default | Descripción |
|---|---|---|
| `ZOTERO_API_URL` | `http://127.0.0.1:23119/api` | URL de la API local de Zotero |
| `ZOTERO_DEFAULT_STYLE` | `apa` | Estilo CSL por defecto |
| `ZOTERO_LOCALE` | `es-ES` | Idioma por defecto del estilo |
| `ZOTERO_MCP_BACKUP` | `true` | Copiar el documento a `<archivo>.bak` antes de sobrescribirlo (`false` para desactivarlo) |
| `OPENALEX_API_KEY` | (vacío) | [API key gratuita de OpenAlex](https://openalex.org/settings/api) para `zotero_find_external`. Sin ella, la cuota diaria gratuita se comparte con todos los de tu IP; si se agota, la búsqueda pasa a Crossref |
| `ZOTERO_MCP_CONTACT_EMAIL` | (vacío) | Correo de contacto que se envía a OpenAlex y Crossref (su "polite pool": respuestas más rápidas y estables). Si está vacío no se envía nada |
| `ZOTERO_MCP_ALLOWED_DIRS` | (vacío) | Carpetas donde se pueden leer y escribir documentos `.md`/`.docx`, separadas por `;` en Windows (`:` en Linux/macOS). Si está vacío, se usan las carpetas de trabajo del cliente MCP (*roots*) o, si no las indica, la carpeta desde la que arrancó el servidor |

Las escrituras en `.md`/`.docx` son atómicas (archivo temporal en la misma carpeta + renombrado), se rechazan si el archivo cambió en disco desde que se leyó y se serializan por archivo, de modo que las llamadas en paralelo no se pisan. El `.bak` conserva solo la versión anterior.

Los documentos solo se leen y escriben dentro de las **carpetas permitidas**: las de `ZOTERO_MCP_ALLOWED_DIRS`; si no está definida, las carpetas de trabajo que indica el cliente MCP (*roots*, normalmente el proyecto abierto); y si el cliente no indica ninguna, la carpeta desde la que arrancó el servidor. Las rutas relativas se resuelven desde la primera carpeta permitida y se rechazan los enlaces (symlinks/junctions) que apunten fuera. `zotero_status` muestra las carpetas permitidas en `workspace`; si `source` es la carpeta de arranque del servidor, tu cliente no indica roots y necesitas `ZOTERO_MCP_ALLOWED_DIRS` para trabajar con documentos en otras carpetas.

## Herramientas MCP

| Herramienta | Descripción |
|---|---|
| `zotero_status` | Verifica la conexión con la API local. |
| `zotero_search` | Busca items (`query`, `qmode`, `itemType`, `collectionKey`, `limit`, `sort`, `direction`). |
| `zotero_get_item` | Detalle completo de un item por `key`. |
| `zotero_list_collections` | Lista las colecciones (`key`, `name`, `parentKey`). |
| `zotero_cite` | Cita textual (`key`, `style`, `locale`, `locator`, `label`, `prefix`, `suffix`, `register`). |
| `zotero_bibliography` | Bibliografía desde el registro de citas o `keys` explícitas; con `filePath` + `apply: true` actualiza la sección de referencias de un `.md`. |
| `zotero_read_docx` | Lee los párrafos de un `.docx` (índice, texto, si ya tiene campos Zotero). |
| `zotero_insert_citation_docx` | Inserta un campo `ADDIN ZOTERO_ITEM CSL_CITATION` al final de un párrafo en un `.docx`. |
| `zotero_update_bibliography_docx` | Inserta o actualiza el campo `ADDIN ZOTERO_BIBL` en un `.docx` (un párrafo por referencia). |
| `zotero_find_external` | Busca publicaciones **fuera** de la biblioteca en OpenAlex/Crossref (`query` o `doi`, `source`, `limit`, `yearFrom`, `yearTo`, `includeAbstract`); `inLibrary` indica si cada una ya está en Zotero. |
| `zotero_add_item` | Guarda una publicación en la biblioteca por `doi` u `openAlexId`, opcionalmente en `collectionKey` y con `tags`. Sin `apply: true` es una vista previa; no guarda duplicados salvo `allowDuplicate: true`. |

## Ejemplos de uso (JSON)

Los ejemplos usan claves de Zotero de ejemplo (`ABC12345`, `DEF67890`); reemplázalas por las reales
que devuelve `zotero_search`.

### 1. Verificar conexión

```json
{ "tool": "zotero_status" }
```
```json
{ "ok": true, "baseUrl": "http://127.0.0.1:23119/api", "library": "local (users/0)" }
```

### 2. Buscar items

```json
{ "tool": "zotero_search", "args": { "query": "inteligencia artificial", "limit": 10 } }
```
Filtros adicionales: `itemType` (`journalArticle`, `book`, `thesis`, `conferencePaper`…),
`collectionKey` (de `zotero_list_collections`), `sort`/`direction`. `query` vacío = listar.

### 3. Detalle de un item

```json
{ "tool": "zotero_get_item", "args": { "key": "ABC12345" } }
```

### 4. Listar colecciones

```json
{ "tool": "zotero_list_collections" }
```

### 5. Citar

```json
{ "tool": "zotero_cite", "args": { "key": "ABC12345", "style": "apa", "locale": "es-ES" } }
```
→ `(Autor, 2020)`

Con página exacta:

```json
{ "tool": "zotero_cite", "args": { "key": "ABC12345", "style": "apa", "locator": "15", "label": "page" } }
```
→ `(Autor, 2020, p. 15)`

Con prefijo/sufijo:

```json
{ "tool": "zotero_cite", "args": { "key": "ABC12345", "style": "apa", "prefix": "véase ", "suffix": ", para un análisis completo" } }
```

Con `register: false` la cita se genera sin registrarse para la bibliografía.

### 6. Bibliografía (auto-actualizable)

Desde las citas registradas (recomendado):

```json
{ "tool": "zotero_bibliography", "args": { "style": "apa", "locale": "es-ES" } }
```

Desde keys explícitas (sin tocar el registro):

```json
{ "tool": "zotero_bibliography", "args": { "keys": ["ABC12345", "DEF67890"], "style": "ieee" } }
```

Actualizar la sección de referencias de un documento Markdown (sin `apply` solo devuelve el diff):

```json
{ "tool": "zotero_bibliography", "args": { "filePath": "C:/docs/trabajo.md" } }
```

Escribir el archivo:

```json
{ "tool": "zotero_bibliography", "args": { "filePath": "C:/docs/trabajo.md", "apply": true } }
```

Si el documento no tiene sección de referencias, crearla al final con `createSection: true`
(usa el encabezado `## Bibliografía`). Formatos de salida: `plaintext`, `markdown` (default), `html`.

### Flujo típico completo

1. `zotero_search { "query": "inteligencia artificial" }` → obtén la `key` del item.
2. `zotero_cite { "key": "ABC12345", "style": "apa" }` → inserta `(Autor, 2020)` en el texto.
3. `zotero_bibliography { "filePath": "C:/docs/trabajo.md", "apply": true }` → regenera la sección
   `## Bibliografía` (o `Referencias`, `References`, etc.) con todas las citas registradas.

La bibliografía se mantiene actualizada sola: basta añadir la cita con `zotero_cite` y volver a
llamar `zotero_bibliography`. Para revisar antes de escribir, omite `apply`: la respuesta trae `dryRun: true` y el diff.

### 7. Leer estructura de un documento Word

```json
{ "tool": "zotero_read_docx", "args": { "filePath": "C:/docs/articulo.docx" } }
```
→ `{ paragraphs: [{ index: 0, text: "Lorem ipsum...", hasZoteroField: false }, ...] }`

### 8. Insertar cita en Word (campo dinámico Zotero)

```json
{ "tool": "zotero_insert_citation_docx", "args": { "filePath": "C:/docs/articulo.docx", "key": "ABC12345", "paragraphIndex": 0, "style": "apa", "apply": true } }
```

Con localizador:

```json
{ "tool": "zotero_insert_citation_docx", "args": { "filePath": "C:/docs/articulo.docx", "key": "ABC12345", "paragraphIndex": 2, "locator": "15", "label": "page", "apply": true } }
```

### 9. Actualizar bibliografía en Word

```json
{ "tool": "zotero_update_bibliography_docx", "args": { "filePath": "C:/docs/articulo.docx", "style": "apa", "apply": true } }
```

La cita se inserta como campo `ADDIN ZOTERO_ITEM CSL_CITATION` con el CSL JSON del item, en el mismo formato que escribe el plugin de Zotero para Word (URI real del item en tu biblioteca, `citationID` aleatorio, `noteIndex` 0), de modo que al pulsar *Refresh* en Word la cita queda enlazada con el item de tu biblioteca.

`style` y `locale` son opcionales: si el documento ya tiene preferencias de Zotero, se usan su estilo e idioma. Si no las tiene, se crean (`docProps/custom.xml`, `ZOTERO_PREF_n`) con el estilo y el idioma usados, para que Word no pida elegir estilo al refrescar. Las preferencias existentes nunca se modifican; si pasas otro `style`, la respuesta incluye un aviso porque Zotero usará el estilo del documento al refrescar.

### Flujo típico en Word

1. `zotero_read_docx` → conoce la estructura (párrafos y sus índices).
2. Para cada cita: `zotero_insert_citation_docx` en el párrafo correcto.
3. `zotero_update_bibliography_docx` → añade/actualiza el campo BIBL al final.

### 10. Buscar fuera de tu biblioteca

```json
{ "tool": "zotero_find_external", "args": { "query": "adultos mayores adopción de tecnología", "yearFrom": 2018, "limit": 5 } }
{ "tool": "zotero_find_external", "args": { "doi": "10.1017/S0144686X19000230", "includeAbstract": true } }
```

Cada resultado trae `title`, `authors`, `year`, `type`, `venue`, `publisher`, `doi`, `url`, `openAccessUrl`, `citedBy` e `inLibrary` (`{ key, title }` si el item ya está en Zotero, por DOI o por título exacto; `null` si no). Con `source: "auto"` (por defecto) usa OpenAlex y, si falla, Crossref; un DOI se busca en Crossref y luego en OpenAlex. No guarda nada en Zotero.

### 11. Guardar en tu biblioteca

```json
{ "tool": "zotero_add_item", "args": { "doi": "10.1017/S0144686X19000230", "collectionKey": "2HTJ2CWF", "tags": ["tesis"] } }
{ "tool": "zotero_add_item", "args": { "doi": "10.1017/S0144686X19000230", "collectionKey": "2HTJ2CWF", "tags": ["tesis"], "apply": true } }
```

Sin `apply: true` devuelve una vista previa: los metadatos que se guardarán, la colección destino y si el item ya está en la biblioteca. Con `apply: true` lo guarda y devuelve su `key`, lista para `zotero_cite`. Los metadatos salen de Crossref (o de OpenAlex para DOIs que Crossref no tiene y para `openAlexId`) y los importa el propio traductor *CSL JSON* de Zotero a través del servidor del conector (`/connector/import`, el mismo servidor local que usa la extensión del navegador). Sin `collectionKey` el item va a la colección seleccionada en Zotero. Al guardar, Zotero selecciona la colección destino y el item nuevo en su ventana. Si el item ya existe (mismo DOI o título) no se guarda nada y se devuelve su `key`. El conector es una interfaz interna de Zotero, probada con Zotero 9.

## Skill incluida

`zotero-research` enseña al agente cuándo y cómo usar cada herramienta (búsqueda, citación y
mantenimiento de la bibliografía). Se activa automáticamente al pedir buscar, citar o actualizar bibliografías.

## Estilos y locales incluidos

- Estilos CSL (licencia CC-BY-SA 3.0 del proyecto [citation-style-language/styles](https://github.com/citation-style-language/styles)): `apa`, `mla`, `chicago-author-date`, `harvard-cite-them-right`, `ieee`, `vancouver`.
- Locales (CC-BY-SA 3.0 de [citation-style-language/locales](https://github.com/citation-style-language/locales)): `es-ES`, `en-US`.

Para agregar un estilo, copia su `.csl` a `src/csl/` (el nombre del archivo, sin `.csl`, es el nombre del estilo); para agregar un locale, copia `locales-<código>.xml` a `src/locales/`. Reinicia el cliente MCP para cargarlos. Si el locale pedido no está, se usa uno del mismo idioma (`es-MX` → `es-ES`) y, si no hay, `en-US`.

## Seguridad

- El único cambio en la biblioteca de Zotero es **añadir** items nuevos con `zotero_add_item` y `apply: true` explícito; nunca se editan ni borran los existentes.
- `zotero_find_external` solo envía a OpenAlex/Crossref el texto buscado o el DOI (y `OPENALEX_API_KEY` y `ZOTERO_MCP_CONTACT_EMAIL` si los configuras); nunca el contenido de tus documentos ni de tu biblioteca.
- La única escritura es la **sección de referencias** de archivos Markdown y los **campos Zotero** en archivos Word (.docx), y solo con `apply: true` explícito.
- Sin secretos en el repositorio; las credenciales (si las hubiera) van por variables de entorno.
- Los documentos solo se leen y escriben dentro de las carpetas permitidas (`ZOTERO_MCP_ALLOWED_DIRS`, los roots del cliente o la carpeta de arranque del servidor).
- Validación de parámetros, tiempos de espera (8 s para la API local, 15 s para OpenAlex/Crossref, 20 s para guardar) y límite de tamaño de archivo (2 MB).

## Solución de problemas

| Síntoma | Causa | Solución |
|---|---|---|
| `zotero_status` → `ok: false` | Zotero cerrado o API local deshabilitada | Abre Zotero y marca *"Allow other applications on this computer to communicate with Zotero"* (Editar → Configuración → Avanzado). No requiere reiniciar. |
| `zotero_cite` → "No se encontró un item con key..." | Key mal copiada o item borrado | Vuelve a buscarlo con `zotero_search` y copia la `key` exacta. |
| `zotero_bibliography` → "Estilo no soportado" | Estilo no incluido | Usa uno de: `apa`, `mla`, `chicago-author-date`, `harvard-cite-them-right`, `ieee`, `vancouver` (o agrega el `.csl` en `src/csl/` y reinicia el cliente). |
| "No se encontró una sección de referencias" | El documento no tiene encabezado de bibliografía | Pasa `createSection: true` para crearla al final. |
| "filePath debe ser un archivo .md..." | Se pasó `.docx` u otra extensión | `zotero_bibliography` solo actualiza Markdown (`.md`/`.markdown`); para Word usa `zotero_update_bibliography_docx`. |
| "No se pudo escribir/leer ...: el archivo está abierto o bloqueado por otra aplicación" | El documento está abierto en Word (u otro programa lo bloquea) | Ciérralo y vuelve a ejecutar la herramienta; el original no se modifica. |
| "El archivo cambió desde que se leyó" | El documento se editó o guardó mientras se ejecutaba la herramienta | Vuelve a ejecutar la herramienta para trabajar sobre la versión más reciente. |
| "No hay referencias que escribir: el registro de citas está vacío" | Se perdió el registro en memoria (reinicio del servidor o cambio de style/locale) | Cita de nuevo con `zotero_cite` o pasa `keys` explícitas. El archivo no se modifica. |
| "La nueva bibliografía tiene N referencias y la sección actual M" | La lista nueva es más corta que la existente (registro parcial) | Revisa el `diff` del dryRun y repite con `force: true` si de verdad quieres reemplazarla. |
| "... está fuera de las carpetas permitidas" | El documento no está en la carpeta de trabajo (o tu cliente no indica roots) | Revisa `workspace` en `zotero_status` y añade la carpeta del documento a `ZOTERO_MCP_ALLOWED_DIRS`. |
| `zotero_add_item` → "No se pudo conectar con Zotero" | Zotero está cerrado | Abre Zotero: guardar requiere la aplicación de escritorio. |
| `zotero_add_item` → "Hay N colecciones llamadas ..." | Dos colecciones con el mismo nombre y padre | Renombra una en Zotero, o selecciona la colección en Zotero y guarda sin `collectionKey`. |
| `zotero_find_external` → "OpenAlex: HTTP 429, cuota diaria gratuita agotada" | Se agotó la cuota compartida de OpenAlex de tu IP | Con `source: "auto"` ya pasa a Crossref; para tener cuota propia configura `OPENALEX_API_KEY`. |
| Citas numéricas "reiniciadas" | Se cambió de estilo a mitad de documento | Usa el mismo `style`/`locale` en todo el documento (cambiar de estilo reinicia la numeración). |

## Desarrollo

```powershell
npm test                              # suite de tests (node --test)
npm start                             # arranca el servidor MCP por stdio
node scripts/smoke.mjs                # handshake MCP + lista de herramientas registradas
node scripts/e2e.mjs '{"tool":"zotero_status"}' '{"tool":"zotero_search","args":{"query":"x"}}'   # probar herramientas contra tu Zotero
```

Ejecuta `e2e.mjs` desde Git Bash o PowerShell 7 (`pwsh`): Windows PowerShell 5.1 quita las comillas del JSON. Las llamadas con `apply: true` se rechazan salvo que añadas `--allow-write`, porque escriben en tu biblioteca o en tus documentos.

El CI (GitHub Actions, `.github/workflows/ci.yml`) se ejecuta en cada push a `main` y en cada pull request: los tests y el smoke test del servidor MCP en Node 18, 20, 22 y 24 (Linux) y Node 22 (Windows), más `npm audit`, que falla con vulnerabilidades altas o críticas. Los tests no necesitan Zotero: usan respuestas simuladas.

La estructura sigue el patrón de plugin completo de Antigravity
(`plugin.json`, `mcp_config.json`, `server/` → `src/`, `skills/`, `scripts/`).

En `src/`: `server.js` es el punto de entrada (stdio), `app.js` construye el servidor MCP, `context.js` lee la configuración y crea los clientes, y `tools/` registra las herramientas por área: `library.js` (búsqueda y colecciones), `citations.js` (citas y Markdown), `word.js` (`.docx`) y `external.js` (búsqueda externa y guardado en la biblioteca). Los clientes de Zotero (`zotero-client.js`, `zotero-connector.js`, `external-search.js`) y la lógica de documentos (`cite.js`, `docx.js`, `bib-section.js`, `file-io.js`) no dependen de MCP. `tests/server.test.js` prueba el servidor completo en memoria con clientes simulados.

## Licencia

MIT — ver `LICENSE`. Los estilos CSL y locales son CC-BY-SA 3.0 (ver sección "Estilos y locales incluidos").
