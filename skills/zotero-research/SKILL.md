---
name: zotero-research
description: Busca en la biblioteca local de Zotero, genera citas en formato CSL (APA, MLA, Chicago, Harvard, IEEE, Vancouver) y mantiene actualizada la sección de bibliografía de documentos Markdown. Usar cuando el usuario pida buscar referencias, citar fuentes, o actualizar/crear la bibliografía de un documento.
---

# Investigación y citas con Zotero

Este flujo conecta con la biblioteca **local** de Zotero (API local en el puerto 23119). Zotero debe estar abierto con el ajuste "Allow other applications on this computer to communicate with Zotero" habilitado.

## 1. Buscar referencias

1. Usa `zotero_search` con palabras clave (`query`).
2. Si el usuario menciona una carpeta/colección, consúltala con `zotero_list_collections` y filtra con `collectionKey`.
3. Presenta los resultados con: clave, título, autores y año. No inventes datos: usa solo lo que devuelve la herramienta.

## 2. Obtener detalles

Usa `zotero_get_item` con la `key` cuando necesites el detalle completo de un item.

## 3. Citar

1. Determina el estilo del documento (APA, MLA, Chicago, Harvard, IEEE, Vancouver). Si es ambiguo, pregunta al usuario.
2. Llama `zotero_cite` con:
   - `key` (de Zotero),
   - `style` (ej. `apa`),
   - `locator` y `label` cuando la cita apunte a una página concreta (ej. `locator: "15"`, `label: "page"`).
3. Inserta la cita devuelta en el texto donde corresponde.
4. Usa **siempre el mismo** `style` y `locale` para todo el documento; cambiar de estilo a mitad de documento reinicia la numeración.

## 4. Mantener la bibliografía actualizada

La bibliografía se actualiza sola al añadir citas:

1. Añade todas las citas del documento con `zotero_cite` (se registran automáticamente).
2. Llama `zotero_bibliography` con:
   - `filePath` = ruta del documento Markdown, y
   - `apply: true` para escribir el archivo.
3. La sección de referencias se regenera a partir de las citas registradas. Si el documento aún no tiene sección, pasa `createSection: true` para crearla al final (por defecto `## Bibliografía`).
4. Para revisar sin escribir, omite `apply` (actúa en modo `dryRun` y devuelve el diff).

## Reglas

- No inventes citas ni referencias: verifica siempre con `zotero_search` / `zotero_get_item` que el item exista.
- No modifiques la librería de Zotero: el MCP solo lee.
- No cambies el estilo de citación a mitad de documento.
- Respeta el idioma del documento (`locale: es-ES` para documentos en español).
- No expongas credenciales ni rutas absolutas del sistema.
- Si Zotero no está corriendo, `zotero_status` devolverá `ok: false`; indícalo al usuario y pídele que abra Zotero.
