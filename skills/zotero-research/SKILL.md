---
name: zotero-research
description: Busca en la biblioteca local de Zotero (y fuera de ella, en OpenAlex/Crossref), genera citas en formato CSL (APA, MLA, Chicago, Harvard, IEEE, Vancouver) y mantiene actualizada la sección de bibliografía de documentos Markdown y Word. Usar cuando el usuario pida buscar referencias, citar fuentes, o actualizar/crear la bibliografía de un documento.
---

# Investigación y citas con Zotero

Este flujo conecta con la biblioteca **local** de Zotero (API local en el puerto 23119). Zotero debe estar abierto con el ajuste "Allow other applications on this computer to communicate with Zotero" habilitado.

## 1. Buscar referencias

1. Usa `zotero_search` con palabras clave (`query`).
2. Si el usuario menciona una carpeta/colección, consúltala con `zotero_list_collections` y filtra con `collectionKey`.
3. Presenta los resultados con: clave, título, autores y año. No inventes datos: usa solo lo que devuelve la herramienta.

### Buscar fuera de la biblioteca

Si la biblioteca no tiene lo que el usuario necesita, o pide fuentes nuevas, usa `zotero_find_external`:

1. `query` con el tema, título o autores (en el idioma de las publicaciones buscadas; en inglés suele haber más resultados), o `doi` si ya lo conoces. Filtra con `yearFrom`/`yearTo` si pide fuentes recientes, y usa `includeAbstract: true` para juzgar la relevancia.
2. Presenta título, autores, año, revista y DOI. Señala cuáles tienen acceso abierto (`openAccessUrl`) y cuáles ya están en la biblioteca (`inLibrary.key`): esas se pueden citar directamente con su key.
3. Las que no están en la biblioteca **no se pueden citar todavía**: hay que guardarlas antes con `zotero_add_item` (ver abajo).
4. Si llega un aviso de que OpenAlex no respondió, los resultados son de Crossref; menciónalo solo si importa (p. ej. no hay datos de acceso abierto).

### Guardar en la biblioteca

1. Guarda **solo lo que el usuario elija**: nunca guardes resultados por tu cuenta ni en bloque sin que lo pida.
2. Llama `zotero_add_item` con `doi` (o `openAlexId` si no tiene DOI), y `collectionKey` (de `zotero_list_collections`) y `tags` si el usuario los indica. Sin `apply` devuelve una vista previa: muéstrale título, autores, año y la colección destino (`target`).
3. Cuando confirme, repite la llamada con `apply: true`. La respuesta trae la `key` del item nuevo: úsala directamente con `zotero_cite` o `zotero_insert_citation_docx`.
4. Si responde `saved: false` porque ya existe (`inLibrary.key`), usa esa key; no fuerces `allowDuplicate` salvo que el usuario lo pida.
5. Requiere Zotero abierto. Sin `collectionKey` se guarda en la colección seleccionada en Zotero: si el usuario no dijo dónde, pregúntale o díselo en la vista previa.

## 2. Obtener detalles

Usa `zotero_get_item` con la `key` cuando necesites el detalle completo de un item.

## 3. Citar

1. Determina el estilo del documento (APA, MLA, Chicago, Harvard, IEEE, Vancouver). Si es ambiguo, pregunta al usuario.
2. Llama `zotero_cite` con:
   - `key` (de Zotero),
   - `style` (ej. `apa`),
   - `locator` y `label` cuando la cita apunte a una página concreta (ej. `locator: "15"`, `label: "page"`).
3. Insertar la cita depende del formato del documento:
   - **Markdown:** la cita se inserta como texto en el flujo de edición.
   - **Word (.docx):** usa `zotero_insert_citation_docx` (ver sección 5).
4. Usa **siempre el mismo** `style` y `locale` para todo el documento; cambiar de estilo a mitad de documento reinicia la numeración.

## 4. Mantener la bibliografía actualizada en Markdown

La bibliografía se actualiza sola al añadir citas:

1. Añade todas las citas del documento con `zotero_cite` (se registran automáticamente).
2. Llama `zotero_bibliography` con:
   - `filePath` = ruta del documento Markdown, y
   - `apply: true` para escribir el archivo.
3. La sección de referencias se regenera a partir de las citas registradas. Si el documento aún no tiene sección, pasa `createSection: true` para crearla al final (por defecto `## Bibliografía`).
4. Para revisar sin escribir, omite `apply` (actúa en modo `dryRun` y devuelve el diff del documento completo).
5. El registro de citas vive en memoria y se pierde si el servidor se reinicia. Con el registro vacío no se escribe nada; si la nueva bibliografía tiene menos referencias que la sección actual, la herramienta se niega a escribir salvo con `force: true`. Ante cualquiera de los dos avisos, vuelve a citar con `zotero_cite` (o usa `keys`) en lugar de forzar.

## 5. Trabajar con documentos Word (.docx)

Para insertar citas y bibliografía en archivos Word, usa las herramientas específicas de docx. **No uses las herramientas de Markdown (zotero_cite textual, zotero_bibliography con filePath .md) en un .docx.**

### Leer la estructura

1. `zotero_read_docx { "filePath": "C:/docs/articulo.docx" }` → obtén la lista de párrafos con su índice y texto.
2. Identifica en qué párrafo debe ir cada cita. Edge: las citas ya insertadas tienen `hasZoteroField: true`.

### Insertar citas

1. `zotero_insert_citation_docx` con:
   - `filePath`, `key`, `paragraphIndex` (del paso anterior),
   - `locator`, `label`, `prefix`, `suffix` si hacen falta,
   - `style`/`locale` solo si el documento aún no tiene estilo: si ya está configurado en Zotero (preferencias del documento), se usan los suyos por defecto,
   - `apply: true` para escribir el archivo (sin `apply` solo hace dryRun).
2. La cita se inserta como campo dinámico `ADDIN ZOTERO_ITEM` al final del párrafo indicado.
3. El campo incluye el CSL JSON del item para que Zotero pueda renderizarlo sin conexión.
4. El campo usa el mismo formato que el plugin de Zotero (URI real del item en tu biblioteca, `citationID` aleatorio, `noteIndex` 0), así que al pulsar *Refresh* Zotero enlaza la cita con el item de la biblioteca.
   Si el documento no tenía preferencias de Zotero, se crean con el estilo y el idioma usados (`documentPrefs: "creadas"`); así Word no pide elegir estilo al refrescar. Las preferencias existentes nunca se modifican.
   Si la respuesta trae `warnings` (p. ej. el documento está configurado con otro estilo), transmítelos al usuario.
5. El texto de la cita se calcula a partir de las citas que ya hay en el documento (antes y después del párrafo), así que la numeración IEEE/Vancouver y la desambiguación ("2020a") corresponden al documento. Las citas de Word son independientes del registro de `zotero_cite`: no hace falta (ni sirve) llamar a `zotero_cite` antes de insertarlas.
6. Las citas ya insertadas no se reescriben: si una cita nueva cambia la numeración o la desambiguación de las anteriores, el plugin de Zotero las actualiza al pulsar *Refresh* en Word.

### Actualizar la bibliografía

1. Después de insertar todas las citas, llama `zotero_update_bibliography_docx` con `filePath` y `apply: true` (`style`/`locale` salen del documento si no se indican).
2. Inserta (o reemplaza si ya existe) el campo `ADDIN ZOTERO_BIBL` al final del documento, con un párrafo por referencia como el plugin.

### Escritura segura

- Pide al usuario que **cierre el documento en Word** antes de escribir con `apply: true`: si está abierto, la herramienta falla con "el archivo está abierto o bloqueado" y no modifica nada.
- Si la herramienta responde "El archivo cambió desde que se leyó", vuelve a ejecutarla (no hay que forzar nada).
- Antes de sobrescribir se guarda `<archivo>.bak` con la versión anterior (salvo `ZOTERO_MCP_BACKUP=false`); la ruta aparece en `backupPath`.

### Flujo típico en Word

1. `zotero_read_docx` → conocer la estructura.
2. `zotero_insert_citation_docx` para cada cita (una por párrafo).
3. `zotero_update_bibliography_docx` → campo BIBL al final.

Al abrir el archivo en Word con el plugin de Zotero, las citas se renderizan correctamente y la bibliografía se actualiza automáticamente.

## Reglas

- No inventes citas ni referencias: verifica siempre con `zotero_search` / `zotero_get_item` que el item exista.
- No modifiques la librería de Zotero salvo para añadir, con `zotero_add_item` y confirmación del usuario, los items que él elija.
- No cites resultados de `zotero_find_external` que no estén en la biblioteca (`inLibrary: null`): guárdalos antes con `zotero_add_item`.
- No cambies el estilo de citación a mitad de documento.
- Respeta el idioma del documento (`locale: es-ES` para documentos en español).
- En documentos Word, no uses las herramientas de Markdown (zotero_cite textual en el .docx) — usa las de docx.
- No expongas credenciales ni rutas absolutas del sistema.
- Si Zotero no está corriendo, `zotero_status` devolverá `ok: false`; indícalo al usuario y pídele que abra Zotero.
