# zotero-mcp

**Antigravity** plugin that adds an **MCP** server connected to your **local Zotero library** to:

- **Search** items in your library (by text, type and collection).
- **Cite** with CSL styles: APA, MLA, Chicago (author-date), Harvard, IEEE and Vancouver.
- **Auto-update bibliographies**: add a new citation and the document's references section regenerates automatically.

Installable from GitHub with:

```powershell
agy plugin install https://github.com/Robernetes/zotero-mcp
```

## What can the AI do with this MCP?

- **Answer questions about your library**: search for sources on a topic, filter by type (articles, books, theses) or collection, and get full details of any item (abstract, authors, year, URL, DOI).
- **Cite correctly**: generate in-text citations with the right style (APA, MLA, Chicago, Harvard, IEEE, Vancouver) and language (es-ES, en-US), with page locators (`(Author, 2020, p. 15)`), prefixes and suffixes.
- **Write academic documents with real references**: the AI inserts citations and keeps the bibliography synced: add citations with `zotero_cite` and the document's references section regenerates with `zotero_bibliography`.
- **Verify sources**: never invents references; every item is validated against Zotero before citing.
- **Diagnostics**: `zotero_status` tells you whether Zotero is available.

**Limits (v1):** read-only access to the Zotero library (cannot add/edit/delete items).

## Requirements

- **Zotero** installed and open, with the setting
  *"Allow other applications on this computer to communicate with Zotero"* enabled
  (Edit → Settings → Advanced). The server uses the local API (port 23119), no API key needed.
- **Node.js ≥ 18** (tested with Node 24).

## Installation

```powershell
agy plugin install https://github.com/Robernetes/zotero-mcp
```

If the plugin doesn't run dependency installation automatically:

```powershell
git clone https://github.com/Robernetes/zotero-mcp
cd zotero-mcp
npm install          # or: powershell -File scripts/setup.ps1  /  sh scripts/setup.sh
```

## Configuration

The server works out of the box (default values). Optional variables
(defined in `.env.example`; passed to the server via `mcp_config.json` with `${VAR}`):

| Variable | Default | Description |
|---|---|---|
| `ZOTERO_API_URL` | `http://127.0.0.1:23119/api` | Zotero local API URL |
| `ZOTERO_DEFAULT_STYLE` | `apa` | Default CSL style |
| `ZOTERO_LOCALE` | `es-ES` | Default style locale |

## MCP Tools

| Tool | Description |
|---|---|
| `zotero_status` | Check connection to the local API. |
| `zotero_search` | Search items (`query`, `qmode`, `itemType`, `collectionKey`, `limit`, `sort`, `direction`). |
| `zotero_get_item` | Full item details by `key`. |
| `zotero_list_collections` | List collections. |
| `zotero_cite` | Textual citation (`key`, `style`, `locale`, `locator`, `label`, `prefix`, `suffix`, `register`). |
| `zotero_bibliography` | Bibliography from registered citations or explicit `keys`; with `filePath` + `apply: true` updates the references section of a `.md` file. |
| `zotero_read_docx` | Read paragraphs from a `.docx` (index, text, whether it already has Zotero fields). |
| `zotero_insert_citation_docx` | Insert an `ADDIN ZOTERO_ITEM CSL_CITATION` field at the end of a paragraph in a `.docx`. |
| `zotero_update_bibliography_docx` | Insert or update the `ADDIN ZOTERO_BIBL` field in a `.docx`. |

## Usage examples (JSON)

Examples use placeholder Zotero keys (`ABC12345`, `DEF67890`); replace with real keys
from `zotero_search` output.

### 1. Check connection

```json
{ "tool": "zotero_status" }
```
```json
{ "ok": true, "baseUrl": "http://127.0.0.1:23119/api", "library": "local (users/0)" }
```

### 2. Search items

```json
{ "tool": "zotero_search", "args": { "query": "artificial intelligence", "limit": 10 } }
```
Additional filters: `itemType` (`journalArticle`, `book`, `thesis`, `conferencePaper`…),
`collectionKey` (from `zotero_list_collections`), `sort`/`direction`. Empty `query` = list all.

### 3. Item details

```json
{ "tool": "zotero_get_item", "args": { "key": "ABC12345" } }
```

### 4. List collections

```json
{ "tool": "zotero_list_collections" }
```

### 5. Cite

```json
{ "tool": "zotero_cite", "args": { "key": "ABC12345", "style": "apa", "locale": "en-US" } }
```
→ `(Author, 2020)`

With exact page:

```json
{ "tool": "zotero_cite", "args": { "key": "ABC12345", "style": "apa", "locator": "15", "label": "page" } }
```
→ `(Author, 2020, p. 15)`

With prefix/suffix:

```json
{ "tool": "zotero_cite", "args": { "key": "ABC12345", "style": "apa", "prefix": "see ", "suffix": ", for a full analysis" } }
```

With `register: false` the citation is generated but not added to the bibliography.

### 6. Bibliography (auto-updating)

From registered citations (recommended):

```json
{ "tool": "zotero_bibliography", "args": { "style": "apa", "locale": "en-US" } }
```

From explicit keys (without affecting the register):

```json
{ "tool": "zotero_bibliography", "args": { "keys": ["ABC12345", "DEF67890"], "style": "ieee" } }
```

Update the references section of a Markdown document (with diff preview):

```json
{ "tool": "zotero_bibliography", "args": { "filePath": "C:/docs/paper.md", "dryRun": true } }
```

Write the file:

```json
{ "tool": "zotero_bibliography", "args": { "filePath": "C:/docs/paper.md", "apply": true } }
```

If the document has no references section, create it at the end with `createSection: true`
(uses the heading `## Bibliography`). Output formats: `plaintext`, `markdown` (default), `html`.

### Complete typical flow

1. `zotero_search { "query": "artificial intelligence" }` → get the item's `key`.
2. `zotero_cite { "key": "ABC12345", "style": "apa" }` → insert `(Author, 2020)` in the text.
3. `zotero_bibliography { "filePath": "C:/docs/paper.md", "apply": true }` → regenerate the
   `## Bibliography` (or `References`, `Works Cited`, etc.) section with all registered citations.

The bibliography stays updated automatically: just add a citation with `zotero_cite` and call
`zotero_bibliography` again. To review before writing, omit `apply` (dryRun mode returns the diff).

### 7. Read a Word document structure

```json
{ "tool": "zotero_read_docx", "args": { "filePath": "C:/docs/paper.docx" } }
```
→ `{ paragraphs: [{ index: 0, text: "Lorem ipsum...", hasZoteroField: false }, ...] }`

### 8. Insert a citation in Word (dynamic Zotero field)

```json
{ "tool": "zotero_insert_citation_docx", "args": { "filePath": "C:/docs/paper.docx", "key": "ABC12345", "paragraphIndex": 0, "style": "apa", "apply": true } }
```

With locator:

```json
{ "tool": "zotero_insert_citation_docx", "args": { "filePath": "C:/docs/paper.docx", "key": "ABC12345", "paragraphIndex": 2, "locator": "15", "label": "page", "apply": true } }
```

### 9. Update bibliography in Word

```json
{ "tool": "zotero_update_bibliography_docx", "args": { "filePath": "C:/docs/paper.docx", "style": "apa", "apply": true } }
```

The citation is inserted as an `ADDIN ZOTERO_ITEM CSL_CITATION` field with the item's CSL JSON. When the `.docx` is opened in Word with the Zotero plugin, the citation renders correctly and the bibliography updates automatically.

### Typical Word flow

1. `zotero_read_docx` → learn the structure (paragraphs and their indices).
2. For each citation: `zotero_insert_citation_docx` at the correct paragraph.
3. `zotero_update_bibliography_docx` → adds/updates the BIBL field at the end.

## Included skill

`zotero-research` teaches the agent when and how to use each tool (search, citation and
bibliography maintenance). It activates automatically when the user asks to search, cite or update bibliographies.

## Included styles and locales

- CSL styles (CC-BY-SA 3.0 from the [citation-style-language/styles](https://github.com/citation-style-language/styles) project): `apa`, `mla`, `chicago-author-date`, `harvard-cite-them-right`, `ieee`, `vancouver`.
- Locales (CC-BY-SA 3.0 from [citation-style-language/locales](https://github.com/citation-style-language/locales)): `es-ES`, `en-US`.

To add styles or locales, place the file in `src/csl/` or `src/locales/` with the correct name.

## Security

- **Read-only** access to the Zotero library: the MCP does not add, edit or delete items.
- The only write operations are the **references section** of Markdown files and **Zotero fields** in Word files (.docx), and only with explicit `apply: true`.
- No secrets in the repository; credentials (if any) go through environment variables.
- Parameter validation, connection timeout (8 s) and file size limit (2 MB).

## Troubleshooting

| Symptom | Cause | Solution |
|---|---|---|
| `zotero_status` → `ok: false` | Zotero closed or local API disabled | Open Zotero and enable *"Allow other applications on this computer to communicate with Zotero"* (Edit → Settings → Advanced). No restart required. |
| `zotero_cite` → "Item not found with key..." | Wrong key or deleted item | Search again with `zotero_search` and copy the exact `key`. |
| `zotero_bibliography` → "Unsupported style" | Style not included | Use one of: `apa`, `mla`, `chicago-author-date`, `harvard-cite-them-right`, `ieee`, `vancouver` (or add the `.csl` file to `src/csl/`). |
| "No references section found" | Document has no bibliography heading | Pass `createSection: true` to create it at the end. |
| "filePath must be a .md file..." | `.docx` or other extension was passed | v1 only updates Markdown (`.md`/`.markdown`). |
| Numeric citations "reset" | Style changed mid-document | Use the same `style`/`locale` throughout the document (changing style resets numbering). |

## Development

```powershell
npm test                              # test suite (node --test)
npm start                             # start the MCP server via stdio
node scripts/smoke.mjs                # MCP handshake + list registered tools
node scripts/e2e.mjs '{"tool":"zotero_status"}' '{"tool":"zotero_search","args":{"query":"x"}}'   # test tools against your Zotero
```

The structure follows the complete Antigravity plugin pattern
(`plugin.json`, `mcp_config.json`, `server/` → `src/`, `skills/`, `scripts/`).

## License

MIT — see `LICENSE`. CSL styles and locales are CC-BY-SA 3.0 (see "Included styles and locales").
