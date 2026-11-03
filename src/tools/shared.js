// tools/shared.js
// Respuestas MCP comunes a todas las herramientas.

/** Convierte un error a una respuesta MCP de error. */
export function fail(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

export function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** Ejecuta un handler con captura de errores uniforme. */
export async function run(handler) {
  try {
    return await handler();
  } catch (err) {
    return fail(err && err.message ? err.message : String(err));
  }
}
