---
name: zotero-research
description: Busca en la biblioteca local de Zotero (y fuera de ella, en OpenAlex/Crossref), genera citas en formato CSL (APA, MLA, Chicago, Harvard, IEEE, Vancouver) y mantiene actualizada la sección de bibliografía de documentos Markdown y Word. Usar cuando el usuario pida buscar referencias, citar fuentes, o actualizar/crear la bibliografía de un documento.
---

# Investigación y citas con Zotero

Este flujo conecta con la biblioteca **local** de Zotero (API local en el puerto 23119). Zotero debe estar abierto con el ajuste "Allow other applications on this computer to communicate with Zotero" habilitado.

## 1. Buscar referencias

1. Usa `zotero_search` con palabras clave (`query`). Si ningún item las contiene todas, devuelve los que contienen alguna con `partialMatch: true` y `matchedWords`: revisa por el título que de verdad traten el tema antes de citarlos.
2. Si el usuario menciona una carpeta/colección, consúltala con `zotero_list_collections` y filtra con `collectionKey`.
3. Presenta los resultados con: clave, título, autores y año. No inventes datos: usa solo lo que devuelve la herramienta.

### Buscar fuera de la biblioteca

Si la biblioteca no tiene lo que el usuario necesita, o pide fuentes nuevas, usa `zotero_find_external`:

1. `query` con el tema, título o autores (en el idioma de las publicaciones buscadas; en inglés suele haber más resultados), o `doi` si ya lo conoces. Filtra con `yearFrom`/`yearTo` si pide fuentes recientes, y usa `includeAbstract: true` para juzgar la relevancia.
2. Presenta título, autores, año, revista y DOI. Señala cuáles tienen acceso abierto (`openAccessUrl`) y cuáles ya están en la biblioteca (`inLibrary.key`, con sus colecciones en `inLibrary.collections`): esas se pueden citar directamente con su key, sin guardarlas otra vez.
3. Las que no están en la biblioteca **no se pueden citar todavía**: hay que guardarlas antes con `zotero_add_item` (ver abajo).
4. Si llega un aviso de que OpenAlex no respondió, los resultados son de Crossref; menciónalo solo si importa (p. ej. no hay datos de acceso abierto).

### Guardar en la biblioteca

1. Guarda **solo lo que el usuario elija**: nunca guardes resultados por tu cuenta ni en bloque sin que lo pida.
2. Llama `zotero_add_item` con `doi` (o `openAlexId` si no tiene DOI), y `collectionKey` (de `zotero_list_collections`) y `tags` si el usuario los indica. Sin `apply` devuelve una vista previa: muéstrale título, autores, año y la colección destino (`target`).
3. Cuando confirme, repite la llamada con `apply: true`. La respuesta trae la `key` del item nuevo: úsala directamente con `zotero_cite` o `zotero_insert_citation_docx`.
4. Si responde `saved: false` porque ya existe (`inLibrary.key`), **usa esa key para citar**. Aunque el usuario haya pedido guardarlo en otra colección, **no uses `allowDuplicate`**: crearía un segundo item igual en su biblioteca. zotero-mcp no puede añadir un item existente a otra colección; si el usuario lo quiere también ahí, puede arrastrarlo en Zotero. Usa `allowDuplicate` solo si el usuario pide expresamente un duplicado.
   - Al terminar, dile qué publicaciones no se añadieron a la colección pedida porque ya estaban en la biblioteca, y en qué colecciones están (`inLibrary.collections`).
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

### Cómo citar bien

Estas reglas valen para Markdown y para Word:

1. **Cita la afirmación, no el párrafo.** La cita va justo después de la frase o idea que la fuente respalda, no amontonada al final del párrafo. Si un párrafo tiene varias ideas con fuentes distintas, cada una lleva su cita.
2. **Agrupa las fuentes de una misma idea en una sola cita**: "(Chikofsky & Cross, 1990; Pang et al., 2021)", nunca "(Chikofsky & Cross, 1990)(Pang et al., 2021)". En Word, usa `keys` con todas sus keys.
3. **La cita va antes del punto** que cierra la frase y separada por un espacio: "…del software (Autor, 2020)." (en Word se hace solo).
4. **Cada fuente debe sostener lo que dice el texto.** Antes de citar, comprueba con el título y el resumen (`includeAbstract: true` en `zotero_find_external`, o `zotero_get_item`) qué afirmación concreta respalda. Si ninguna frase del texto corresponde a una fuente, no la cites: díselo al usuario.
   - **Busca por afirmación.** Para cada idea que necesite respaldo, busca una fuente específica con `zotero_find_external` (una búsqueda por idea, con sus términos clave). Usa los items que ya están en la biblioteca o en una colección solo si encajan de verdad con esa afirmación, o si el usuario pide usar esos.
   - **Definiciones y conceptos: la fuente original.** Para una definición formal o un concepto acuñado, cita el trabajo que lo definió o la referencia clásica del campo (búscala por título o autor), no un trabajo reciente que solo lo menciona.
   - **Avisa de lo que queda sin fuente.** Al terminar, dile al usuario qué afirmaciones no tienen cita porque no encontraste una fuente adecuada.
5. **Sin relleno.** Normalmente bastan 1-3 fuentes por afirmación. No repitas la misma fuente en frases seguidas del mismo párrafo.
6. **Paráfrasis y citas textuales.** Para una cita textual o una idea de una página concreta, añade `locator` (p. ej. `"15"`) y `label: "page"`.
7. **Revisa antes de escribir.** Llama siempre primero sin `apply` y comprueba en `preview` que la cita queda junto a la frase correcta; muéstraselo al usuario antes de escribir con `apply: true`, salvo que haya pedido escribir sin revisar.

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
2. Identifica la frase exacta que respalda cada fuente (ver «Cómo citar bien»). Las citas ya insertadas tienen `hasZoteroField: true`.

### Insertar citas

1. `zotero_insert_citation_docx` con:
   - `filePath`,
   - `key` (una fuente) o `keys` (varias fuentes que respaldan la misma idea: una sola cita agrupada),
   - `afterText`: un fragmento **exacto** del texto de `zotero_read_docx` tras el que va la cita, normalmente el final de la frase que respalda (puedes incluir o no el punto: la cita se coloca antes). Debe aparecer una sola vez; si no, alarga el fragmento o acota con `paragraphIndex`,
   - `paragraphIndex` solo para acotar la búsqueda, o sin `afterText` para citar al final del párrafo,
   - `locator`, `label` (solo con una fuente), y `prefix`/`suffix` para texto dentro de la cita (p. ej. `prefix: "véase"`). **No uses `prefix` ni `suffix` para añadir espacios**: se ponen solos,
   - `style`/`locale` solo si el documento aún no tiene estilo: si ya está configurado en Zotero (preferencias del documento), se usan los suyos por defecto,
   - `apply: true` para escribir el archivo (sin `apply` solo hace dryRun).
2. La cita se inserta como campo dinámico `ADDIN ZOTERO_ITEM` en ese lugar, antes de la puntuación que cierra la frase y con su espacio. Revisa `preview` en la vista previa: muestra cómo queda el texto alrededor.
3. El campo incluye el CSL JSON del item para que Zotero pueda renderizarlo sin conexión.
4. El campo usa el mismo formato que el plugin de Zotero (URI real del item en tu biblioteca, `citationID` aleatorio, `noteIndex` 0), así que al pulsar *Refresh* Zotero enlaza la cita con el item de la biblioteca.
   Si el documento no tenía preferencias de Zotero, se crean con el estilo y el idioma usados (`documentPrefs: "creadas"`; en la vista previa, `"se crearían"`); así Word no pide elegir estilo al refrescar. Las preferencias existentes nunca se modifican.
   Si la respuesta trae `warnings` (p. ej. el documento está configurado con otro estilo), transmítelos al usuario.
5. El texto de la cita se calcula a partir de las citas que ya hay en el documento (antes y después de la nueva, también dentro del mismo párrafo), así que la numeración IEEE/Vancouver y la desambiguación ("2020a") corresponden al documento. Las citas de Word son independientes del registro de `zotero_cite`: no hace falta (ni sirve) llamar a `zotero_cite` antes de insertarlas.
6. Las citas ya insertadas no se reescriben: si una cita nueva cambia la numeración o la desambiguación de las anteriores, el plugin de Zotero las actualiza al pulsar *Refresh* en Word.

### Quitar o rehacer citas

Para deshacer citas (por ejemplo, para volver a citar con otras fuentes) usa `zotero_remove_citations_docx`; **nunca regeneres el documento ni copies su texto a un archivo nuevo**.

1. `zotero_remove_citations_docx { "filePath": "...", "keys": ["ABC12345"] }` quita las citas de esas fuentes (en una cita agrupada, solo esas fuentes) y muestra cómo quedan los párrafos. Sin `keys` quita todas las citas y la bibliografía.
2. Repite con `apply: true` para escribir. El resto del documento (texto, formato, estilos) no cambia, y también se quita el espacio que separaba la cita.
3. Si quitaste algunas fuentes y el documento conserva la bibliografía, actualízala después con `zotero_update_bibliography_docx`.

### Actualizar la bibliografía

1. Después de insertar todas las citas, llama `zotero_update_bibliography_docx` con `filePath` y `apply: true` (`style`/`locale` salen del documento si no se indican).
2. Inserta (o reemplaza si ya existe) el campo `ADDIN ZOTERO_BIBL` al final del documento, con un párrafo por referencia como el plugin.

### Escritura segura

- Solo se pueden leer y escribir documentos dentro de las carpetas permitidas (`workspace` en `zotero_status`), normalmente la carpeta de trabajo. Las rutas relativas se resuelven desde ella. Si un documento está "fuera de las carpetas permitidas", díselo al usuario y explica que puede añadir su carpeta a `ZOTERO_MCP_ALLOWED_DIRS`; no copies ni muevas el documento por tu cuenta.
- Pide al usuario que **cierre el documento en Word** antes de escribir con `apply: true`: si está abierto, la herramienta falla con "el archivo está abierto o bloqueado" y no modifica nada.
- Si la herramienta responde "El archivo cambió desde que se leyó", vuelve a ejecutarla (no hay que forzar nada).
- Antes de sobrescribir se guarda `<archivo>.bak` con la versión anterior (salvo `ZOTERO_MCP_BACKUP=false`); la ruta aparece en `backupPath`. Cada escritura lo reemplaza: solo guarda la versión inmediatamente anterior.
- **Modifica los documentos solo con las herramientas `zotero_*_docx`.** Nunca recrees, reescribas ni sobrescribas un documento con otras herramientas (python-docx, scripts, copiar el texto a un archivo nuevo): se pierden el formato, los estilos y la configuración del documento, y no se puede recuperar. Si algo no se puede hacer con las herramientas, explícaselo al usuario en lugar de improvisar.

### Flujo típico en Word

1. `zotero_read_docx` → conocer la estructura.
2. `zotero_insert_citation_docx` para cada afirmación que lleve cita, con `afterText` y, si varias fuentes respaldan la misma idea, `keys` (primero sin `apply`, revisando `preview`).
3. `zotero_update_bibliography_docx` → campo BIBL al final.
4. Para rehacer citas: `zotero_remove_citations_docx` y vuelve al paso 2.

Al abrir el archivo en Word con el plugin de Zotero, las citas se renderizan correctamente y la bibliografía se actualiza automáticamente.

## Reglas

- No inventes citas ni referencias: verifica siempre con `zotero_search` / `zotero_get_item` que el item exista.
- No modifiques la librería de Zotero salvo para añadir, con `zotero_add_item` y confirmación del usuario, los items que elija el usuario.
- No crees duplicados: si una publicación ya está en la biblioteca, cítala con su key aunque esté en otra colección (`allowDuplicate` solo si el usuario lo pide expresamente).
- No cites resultados de `zotero_find_external` que no estén en la biblioteca (`inLibrary: null`): guárdalos antes con `zotero_add_item`.
- No cambies el estilo de citación a mitad de documento.
- Cita cada fuente donde respalda una afirmación concreta y agrupa las de una misma idea (ver «Cómo citar bien»); no amontones citas al final de un párrafo.
- Respeta el idioma del documento (`locale: es-ES` para documentos en español).
- En documentos Word, no uses las herramientas de Markdown (zotero_cite textual en el .docx) — usa las de docx.
- Nunca recrees ni sobrescribas un documento del usuario con otras herramientas: para quitar citas usa `zotero_remove_citations_docx`.
- No expongas credenciales ni rutas absolutas del sistema.
- Si Zotero no está corriendo, `zotero_status` devolverá `ok: false`; indícalo al usuario y pídele que abra Zotero.
