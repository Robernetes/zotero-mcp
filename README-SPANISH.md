# zotero-mcp

Plugin de **Antigravity** que agrega un servidor **MCP** conectado a la **biblioteca local de Zotero** para:

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
- **Verificar fuentes**: nunca inventa referencias; todo item se valida contra Zotero antes de citar.
- **Diagnosticar**: `zotero_status` indica si Zotero está disponible.

**Límites (v1):** solo lectura sobre la librería de Zotero (no agrega/edita/borra items) y actualización de bibliografía solo en archivos Markdown (`.md`/`.markdown`), no Word.

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

## Configuración

El servidor funciona sin configuración (usa los valores por defecto). Variables opcionales
(definidas en `.env.example`; se pasan al servidor vía `mcp_config.json` con `${VAR}`):

| Variable | Default | Descripción |
|---|---|---|
| `ZOTERO_API_URL` | `http://127.0.0.1:23119/api` | URL de la API local de Zotero |
| `ZOTERO_DEFAULT_STYLE` | `apa` | Estilo CSL por defecto |
| `ZOTERO_LOCALE` | `es-ES` | Idioma por defecto del estilo |

## Herramientas MCP

| Herramienta | Descripción |
|---|---|
| `zotero_status` | Verifica la conexión con la API local. |
| `zotero_search` | Busca items (`query`, `qmode`, `itemType`, `collectionKey`, `limit`, `sort`, `direction`). |
| `zotero_get_item` | Detalle completo de un item por `key`. |
| `zotero_list_collections` | Lista las colecciones. |
| `zotero_cite` | Cita textual (`key`, `style`, `locale`, `locator`, `label`, `prefix`, `suffix`, `register`). |
| `zotero_bibliography` | Bibliografía desde el registro de citas o `keys` explícitas; con `filePath` + `apply: true` actualiza la sección de referencias de un `.md`. |

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

Actualizar la sección de referencias de un documento Markdown (con diff antes de escribir):

```json
{ "tool": "zotero_bibliography", "args": { "filePath": "C:/docs/trabajo.md", "dryRun": true } }
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
llamar `zotero_bibliography`. Para revisar antes de escribir, omite `apply` (modo `dryRun` devuelve el diff).

## Skill incluida

`zotero-research` enseña al agente cuándo y cómo usar cada herramienta (búsqueda, citación y
mantenimiento de la bibliografía). Se activa automáticamente al pedir buscar, citar o actualizar bibliografías.

## Estilos y locales incluidos

- Estilos CSL (licencia CC-BY-SA 3.0 del proyecto [citation-style-language/styles](https://github.com/citation-style-language/styles)): `apa`, `mla`, `chicago-author-date`, `harvard-cite-them-right`, `ieee`, `vancouver`.
- Locales (CC-BY-SA 3.0 de [citation-style-language/locales](https://github.com/citation-style-language/locales)): `es-ES`, `en-US`.

Para agregar estilos o locales, coloca el archivo en `src/csl/` o `src/locales/` con el nombre correcto.

## Seguridad

- **Solo lectura** sobre la librería de Zotero: el MCP no agrega, edita ni borra items.
- La única escritura es la **sección de referencias** de archivos Markdown, y solo con `apply: true` explícito.
- Sin secretos en el repositorio; las credenciales (si las hubiera) van por variables de entorno.
- Validación de parámetros, timeout de conexión (8 s) y límite de tamaño de archivo (2 MB).

## Solución de problemas

| Síntoma | Causa | Solución |
|---|---|---|
| `zotero_status` → `ok: false` | Zotero cerrado o API local deshabilitada | Abre Zotero y marca *"Allow other applications on this computer to communicate with Zotero"* (Editar → Configuración → Avanzado). No requiere reiniciar. |
| `zotero_cite` → "No se encontró un item con key..." | Key mal copiada o item borrado | Vuelve a buscarlo con `zotero_search` y copia la `key` exacta. |
| `zotero_bibliography` → "Estilo no soportado" | Estilo no incluido | Usa uno de: `apa`, `mla`, `chicago-author-date`, `harvard-cite-them-right`, `ieee`, `vancouver` (o agrega el `.csl` en `src/csl/`). |
| "No se encontró una sección de referencias" | El documento no tiene encabezado de bibliografía | Pasa `createSection: true` para crearla al final. |
| "filePath debe ser un archivo .md..." | Se pasó `.docx` u otra extensión | v1 solo actualiza Markdown (`.md`/`.markdown`). |
| Citas numéricas "reiniciadas" | Se cambió de estilo a mitad de documento | Usa el mismo `style`/`locale` en todo el documento (cambiar de estilo reinicia la numeración). |

## Desarrollo

```powershell
npm test                              # suite de tests (node --test)
npm start                             # arranca el servidor MCP por stdio
node scripts/smoke.mjs                # handshake MCP + lista de herramientas registradas
node scripts/e2e.mjs '{"tool":"zotero_status"}' '{"tool":"zotero_search","args":{"query":"x"}}'   # probar herramientas contra tu Zotero
```

La estructura sigue el patrón de plugin completo de Antigravity
(`plugin.json`, `mcp_config.json`, `server/` → `src/`, `skills/`, `scripts/`).

## Licencia

MIT — ver `LICENSE`. Los estilos CSL y locales son CC-BY-SA 3.0 (ver sección "Estilos y locales incluidos").
