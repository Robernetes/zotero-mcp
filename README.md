# zotero-mcp

[![CI](https://github.com/Robernetes/zotero-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Robernetes/zotero-mcp/actions/workflows/ci.yml)

**MCP** server connected to your **local Zotero library**, packaged as an **Antigravity** plugin and usable from any MCP client ([other clients](#use-with-other-mcp-clients)), to:

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
- **Find new sources**: search outside your library (OpenAlex and Crossref) by topic, title, author or DOI, see which results are already in your library, and save the ones you choose (by DOI) into a collection.
- **Verify sources**: never invents references; every item is validated against Zotero before citing.
- **Diagnostics**: `zotero_status` tells you whether Zotero is available.

**Limits:** the MCP can only **add** new items (`zotero_add_item`, Zotero must be open); it never edits or deletes existing items. It saves metadata only (no PDFs).

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

## Use with other MCP clients

The server is a standard MCP server (stdio), so it works with any MCP client, not only Antigravity: Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI… Only `plugin.json` and `mcp_config.json` are specific to the Antigravity plugin.

1. Clone the repository and install the dependencies (see [Installation](#installation)).
2. Register the server in your client with `node` and the **absolute path** to `src/server.js`. On Windows you can write the path with `/` to avoid escaping `\\` in JSON.
3. Pass the variables you need in `env` (see [Configuration](#configuration)). Write real values: `${VAR}` placeholders like the ones in `mcp_config.json` only work in clients that expand environment variables (if one arrives unexpanded, the server ignores it and uses the default).
4. Restart the client and run `zotero_status`: `ok: true` confirms the connection with Zotero, and `workspace` shows the folders where documents can be read and written. If `source` is the server start folder, the client does not report its working folders (*roots*): set `ZOTERO_MCP_ALLOWED_DIRS` with the folders of your documents.

**Claude Code** (`--scope user` makes it available in all your projects):

```powershell
claude mcp add zotero --scope user -e ZOTERO_LOCALE=es-ES -- node C:/path/to/zotero-mcp/src/server.js
```

To also use the `zotero-research` skill, copy the `skills/zotero-research` folder to `~/.claude/skills/` (or to `.claude/skills/` in a project).

**Claude Desktop, Cursor, Windsurf, Gemini CLI** and most clients use an `mcpServers` block:

```json
{
  "mcpServers": {
    "zotero": {
      "command": "node",
      "args": ["C:/path/to/zotero-mcp/src/server.js"],
      "env": {
        "ZOTERO_DEFAULT_STYLE": "apa",
        "ZOTERO_LOCALE": "es-ES",
        "ZOTERO_MCP_ALLOWED_DIRS": "C:/Users/you/Documents/Thesis"
      }
    }
  }
}
```

| Client | Configuration file |
|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (Windows), `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json` |

`ZOTERO_MCP_ALLOWED_DIRS` is especially useful in clients without a project folder, such as Claude Desktop.

**VS Code** (`.vscode/mcp.json` in the project) uses the `servers` key and the `stdio` type:

```json
{
  "servers": {
    "zotero": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/zotero-mcp/src/server.js"],
      "env": { "ZOTERO_LOCALE": "es-ES" }
    }
  }
}
```

## Configuration

The server works out of the box (default values). Optional variables
(defined in `.env.example`; passed to the server via `mcp_config.json` with `${VAR}`):

| Variable | Default | Description |
|---|---|---|
| `ZOTERO_API_URL` | `http://127.0.0.1:23119/api` | Zotero local API URL |
| `ZOTERO_DEFAULT_STYLE` | `apa` | Default CSL style |
| `ZOTERO_LOCALE` | `es-ES` | Default style locale |
| `ZOTERO_MCP_BACKUP` | `true` | Copy the document to `<file>.bak` before overwriting it (`false` to disable) |
| `OPENALEX_API_KEY` | (empty) | Free [OpenAlex API key](https://openalex.org/settings/api) for `zotero_find_external`. Without it, the free daily quota is shared by everyone on your IP; when it runs out, the search falls back to Crossref |
| `ZOTERO_MCP_CONTACT_EMAIL` | (empty) | Contact email sent to OpenAlex and Crossref (their "polite pool": faster, more stable responses). Nothing is sent if empty |
| `ZOTERO_MCP_ALLOWED_DIRS` | (empty) | Folders where `.md`/`.docx` documents can be read and written, separated by `;` on Windows (`:` on Linux/macOS). If empty, the MCP client's working folders (*roots*) are used, or else the folder the server was started from |

Writes to `.md`/`.docx` files are atomic (temporary file in the same folder + rename), are refused if the file changed on disk since it was read, and are serialized per file, so parallel calls do not overwrite each other. The `.bak` keeps only the previous version.

Documents are only read and written inside the **allowed folders**: those in `ZOTERO_MCP_ALLOWED_DIRS`; if it is not set, the working folders the MCP client reports (*roots*, usually the open project); and if the client reports none, the folder the server was started from. Relative paths are resolved from the first allowed folder, and links (symlinks/junctions) pointing outside are rejected. `zotero_status` shows the allowed folders in `workspace`; if `source` is the server start folder, your client does not report roots and you need `ZOTERO_MCP_ALLOWED_DIRS` to work with documents elsewhere.

## MCP Tools

| Tool | Description |
|---|---|
| `zotero_status` | Check connection to the local API. |
| `zotero_search` | Search items (`query`, `qmode`, `itemType`, `collectionKey`, `limit`, `sort`, `direction`). |
| `zotero_get_item` | Full item details by `key`. |
| `zotero_list_collections` | List collections (`key`, `name`, `parentKey`). |
| `zotero_cite` | Textual citation (`key`, `style`, `locale`, `locator`, `label`, `prefix`, `suffix`, `register`). |
| `zotero_bibliography` | Bibliography from registered citations or explicit `keys`; with `filePath` + `apply: true` updates the references section of a `.md` file. |
| `zotero_read_docx` | Read paragraphs from a `.docx` (index, text, whether it already has Zotero fields). |
| `zotero_insert_citation_docx` | Insert an `ADDIN ZOTERO_ITEM CSL_CITATION` field in a `.docx` right after the sentence it supports (`afterText`) or at the end of a paragraph; with `keys`, one grouped citation for several sources. |
| `zotero_update_bibliography_docx` | Insert or update the `ADDIN ZOTERO_BIBL` field in a `.docx` (one paragraph per reference). |
| `zotero_find_external` | Search publications **outside** the library in OpenAlex/Crossref (`query` or `doi`, `source`, `limit`, `yearFrom`, `yearTo`, `includeAbstract`); `inLibrary` tells whether each one is already in Zotero. |
| `zotero_add_item` | Save a publication to the library by `doi` or `openAlexId`, optionally into `collectionKey` with `tags`. Preview without `apply: true`; never saves duplicates unless `allowDuplicate: true`. |

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

Update the references section of a Markdown document (without `apply` it only returns the diff preview):

```json
{ "tool": "zotero_bibliography", "args": { "filePath": "C:/docs/paper.md" } }
```

Write the file:

```json
{ "tool": "zotero_bibliography", "args": { "filePath": "C:/docs/paper.md", "apply": true } }
```

If the document has no references section, create it at the end with `createSection: true`
(uses the heading `## Bibliografía`). Output formats: `plaintext`, `markdown` (default), `html`.

### Complete typical flow

1. `zotero_search { "query": "artificial intelligence" }` → get the item's `key`.
2. `zotero_cite { "key": "ABC12345", "style": "apa" }` → insert `(Author, 2020)` in the text.
3. `zotero_bibliography { "filePath": "C:/docs/paper.md", "apply": true }` → regenerate the
   `## Bibliography` (or `References`, `Works Cited`, etc.) section with all registered citations.

The bibliography stays updated automatically: just add a citation with `zotero_cite` and call
`zotero_bibliography` again. To review before writing, omit `apply`: the response has `dryRun: true` and the diff.

### 7. Read a Word document structure

```json
{ "tool": "zotero_read_docx", "args": { "filePath": "C:/docs/paper.docx" } }
```
→ `{ paragraphs: [{ index: 0, text: "Lorem ipsum...", hasZoteroField: false }, ...] }`

### 8. Insert a citation in Word (dynamic Zotero field)

```json
{ "tool": "zotero_insert_citation_docx", "args": { "filePath": "C:/docs/paper.docx", "key": "ABC12345", "afterText": "the process of analyzing a subject system", "style": "apa", "apply": true } }
```

`afterText` is an exact fragment of the text returned by `zotero_read_docx` (repeated spaces, typographic quotes and dashes are ignored); it must appear only once, and `paragraphIndex` narrows the search. Without `afterText` the citation goes at the end of `paragraphIndex`. Either way it is placed before the punctuation that closes the sentence and separated by a space, as in academic writing: `…a subject system (Chikofsky & Cross, 1990).` The response includes `preview` with the surrounding text, so you can check it before writing with `apply: true`.

Several sources supporting the same statement, in a single grouped citation `(Costin et al., 2016; Pang et al., 2021)`:

```json
{ "tool": "zotero_insert_citation_docx", "args": { "filePath": "C:/docs/paper.docx", "keys": ["ABC12345", "DEF67890"], "afterText": "binaries and embedded firmware", "apply": true } }
```

With locator:

```json
{ "tool": "zotero_insert_citation_docx", "args": { "filePath": "C:/docs/paper.docx", "key": "ABC12345", "paragraphIndex": 2, "locator": "15", "label": "page", "apply": true } }
```

### 9. Update bibliography in Word

```json
{ "tool": "zotero_update_bibliography_docx", "args": { "filePath": "C:/docs/paper.docx", "style": "apa", "apply": true } }
```

The citation is inserted as an `ADDIN ZOTERO_ITEM CSL_CITATION` field with the item's CSL JSON, in the same format the Zotero Word plugin writes (the item's real library URI, random `citationID`, `noteIndex` 0), so pressing *Refresh* in Word links it to the item in your library.

`style` and `locale` are optional: if the document already has Zotero document preferences, its style and locale are used. If it has none, they are created (`docProps/custom.xml`, `ZOTERO_PREF_n`) with the style and locale used, so Word does not ask for a style on Refresh. Existing preferences are never modified; if you pass a different `style`, the response includes a warning because Zotero will use the document's style when refreshing.

### Typical Word flow

1. `zotero_read_docx` → learn the structure (paragraphs and their indices).
2. For each statement that needs a source: `zotero_insert_citation_docx` with `afterText` (and `keys` when several sources support it).
3. `zotero_update_bibliography_docx` → adds/updates the BIBL field at the end.

### 10. Search outside your library

```json
{ "tool": "zotero_find_external", "args": { "query": "older adults technology adoption", "yearFrom": 2018, "limit": 5 } }
{ "tool": "zotero_find_external", "args": { "doi": "10.1017/S0144686X19000230", "includeAbstract": true } }
```

Each result includes `title`, `authors`, `year`, `type`, `venue`, `publisher`, `doi`, `url`, `openAccessUrl`, `citedBy` and `inLibrary` (`{ key, title }` if the item is already in Zotero, matched by DOI or exact title; `null` otherwise). With `source: "auto"` (default) it uses OpenAlex and falls back to Crossref if OpenAlex fails; a DOI is looked up in Crossref and then OpenAlex. Nothing is saved to Zotero.

### 11. Save to your library

```json
{ "tool": "zotero_add_item", "args": { "doi": "10.1017/S0144686X19000230", "collectionKey": "2HTJ2CWF", "tags": ["thesis"] } }
{ "tool": "zotero_add_item", "args": { "doi": "10.1017/S0144686X19000230", "collectionKey": "2HTJ2CWF", "tags": ["thesis"], "apply": true } }
```

Without `apply: true` it returns a preview: the metadata that will be saved, the destination collection and whether the item is already in the library. With `apply: true` it saves it and returns its `key`, ready for `zotero_cite`. Metadata comes from Crossref (or OpenAlex for DOIs Crossref does not have, and for `openAlexId`) and is imported by Zotero's own *CSL JSON* translator through the connector server (`/connector/import`, the same local server the browser extension uses). Without `collectionKey` the item goes to the collection currently selected in Zotero. Saving selects the destination collection and the new item in the Zotero window. If the item already exists (same DOI or title) nothing is saved and its `key` is returned. The connector is an internal Zotero interface, tested with Zotero 9.

## Included skill

`zotero-research` teaches the agent when and how to use each tool (search, citation and
bibliography maintenance). It activates automatically when the user asks to search, cite or update bibliographies.

## Included styles and locales

- CSL styles (CC-BY-SA 3.0 from the [citation-style-language/styles](https://github.com/citation-style-language/styles) project): `apa`, `mla`, `chicago-author-date`, `harvard-cite-them-right`, `ieee`, `vancouver`.
- Locales (CC-BY-SA 3.0 from [citation-style-language/locales](https://github.com/citation-style-language/locales)): `es-ES`, `en-US`.

To add a style, copy its `.csl` file to `src/csl/` (the file name, without `.csl`, is the style name); to add a locale, copy `locales-<code>.xml` to `src/locales/`. Restart the MCP client to load them. If the requested locale is not available, one of the same language is used (`es-MX` → `es-ES`) and, failing that, `en-US`.

## Security

- The only change to the Zotero library is **adding** new items with `zotero_add_item` and explicit `apply: true`; existing items are never edited or deleted.
- `zotero_find_external` only sends the search text or DOI to OpenAlex/Crossref (plus `OPENALEX_API_KEY` and `ZOTERO_MCP_CONTACT_EMAIL` if you set them); never the content of your documents or library.
- The only write operations are the **references section** of Markdown files and **Zotero fields** in Word files (.docx), and only with explicit `apply: true`.
- No secrets in the repository; credentials (if any) go through environment variables.
- Documents are only read and written inside the allowed folders (`ZOTERO_MCP_ALLOWED_DIRS`, the client's roots or the server start folder).
- Parameter validation, timeouts (8 s for the local API, 15 s for OpenAlex/Crossref, 20 s for saving) and file size limit (2 MB).

## Troubleshooting

| Symptom | Cause | Solution |
|---|---|---|
| `zotero_status` → `ok: false` | Zotero closed or local API disabled | Open Zotero and enable *"Allow other applications on this computer to communicate with Zotero"* (Edit → Settings → Advanced). No restart required. |
| `zotero_cite` → "Item not found with key..." | Wrong key or deleted item | Search again with `zotero_search` and copy the exact `key`. |
| `zotero_bibliography` → "Unsupported style" | Style not included | Use one of: `apa`, `mla`, `chicago-author-date`, `harvard-cite-them-right`, `ieee`, `vancouver` (or add the `.csl` file to `src/csl/` and restart the client). |
| "No references section found" | Document has no bibliography heading | Pass `createSection: true` to create it at the end. |
| "filePath must be a .md file..." | `.docx` or other extension was passed | `zotero_bibliography` only updates Markdown (`.md`/`.markdown`); for Word use `zotero_update_bibliography_docx`. |
| "Could not write/read ...: the file is open or locked by another application" | The document is open in Word (or locked by another program) | Close it and run the tool again; the original is not modified. |
| "The file changed since it was read" | The document was edited or saved while the tool was running | Run the tool again so it works on the latest version. |
| "No references to write: the citation registry is empty" | The in-memory registry was lost (server restart or style/locale change) | Cite again with `zotero_cite` or pass explicit `keys`. The file is not modified. |
| "The new bibliography has N references and the current section M" | The new list is shorter than the existing one (partial registry) | Review the `diff` from the dry run and repeat with `force: true` if you really want to replace it. |
| `zotero_find_external` → "OpenAlex: HTTP 429, free daily quota used up" | The shared OpenAlex quota for your IP ran out | With `source: "auto"` it already falls back to Crossref; for your own quota set `OPENALEX_API_KEY`. |
| "... is outside the allowed folders" | The document is not in the working folder (or your client does not report roots) | Check `workspace` in `zotero_status` and add the document's folder to `ZOTERO_MCP_ALLOWED_DIRS`. |
| `zotero_add_item` → "Could not connect to Zotero" | Zotero is closed | Open Zotero: saving requires the desktop app. |
| `zotero_add_item` → "There are N collections named ..." | Two collections with the same name and parent | Rename one in Zotero, or save without `collectionKey` after selecting the collection in Zotero. |
| Numeric citations "reset" | Style changed mid-document | Use the same `style`/`locale` throughout the document (changing style resets numbering). |

## Development

```powershell
npm test                              # test suite (node --test)
npm start                             # start the MCP server via stdio
node scripts/smoke.mjs                # MCP handshake + list registered tools
node scripts/e2e.mjs '{"tool":"zotero_status"}' '{"tool":"zotero_search","args":{"query":"x"}}'   # test tools against your Zotero
```

Run `e2e.mjs` from Git Bash or PowerShell 7 (`pwsh`): Windows PowerShell 5.1 strips the quotes from the JSON. Calls with `apply: true` are rejected unless you add `--allow-write`, because they write to your library or your documents.

CI (GitHub Actions, `.github/workflows/ci.yml`) runs on every push to `main` and every pull request: the test suite and the MCP smoke test on Node 18, 20, 22 and 24 (Linux) and Node 22 (Windows), plus `npm audit`, which fails on high or critical vulnerabilities. Tests do not need Zotero: they use mocked responses.

The structure follows the complete Antigravity plugin pattern
(`plugin.json`, `mcp_config.json`, `server/` → `src/`, `skills/`, `scripts/`).

In `src/`: `server.js` is the entry point (stdio), `app.js` builds the MCP server, `context.js` reads the configuration and creates the clients, and `tools/` registers the tools by area: `library.js` (search and collections), `citations.js` (citations and Markdown), `word.js` (`.docx`) and `external.js` (external search and saving to the library). The Zotero clients (`zotero-client.js`, `zotero-connector.js`, `external-search.js`) and the document logic (`cite.js`, `docx.js`, `bib-section.js`, `file-io.js`) do not depend on MCP. `tests/server.test.js` tests the full server in memory with mocked clients.

## License

MIT — see `LICENSE`. CSL styles and locales are CC-BY-SA 3.0 (see "Included styles and locales").
