// e2e.mjs
// Cliente de prueba: invoca herramientas del servidor MCP de Zotero por stdio.
// Uso:
//   node scripts/e2e.mjs '{"tool":"zotero_status"}' '{"tool":"zotero_search","args":{"query":"adultos mayores"}}'
//   node scripts/e2e.mjs '{"tool":"zotero_cite","args":{"key":"EUKGH89J","style":"apa"}}' '{"tool":"zotero_bibliography"}'
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const calls = process.argv.slice(2);
if (calls.length === 0) {
  console.error('Uso: node scripts/e2e.mjs \'{"tool":"zotero_status"}\' ...');
  process.exit(2);
}

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });

let buffer = '';
const pending = new Map();
let nextId = 1;

function send(method, params, id) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
}
function awaitReply(id) {
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const waiter = msg.id != null ? pending.get(msg.id) : null;
    if (waiter) {
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    }
  }
});

const timeout = (ms) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout tras ${ms} ms`)), ms));

try {
  const idInit = nextId++;
  send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0.0.1' } }, idInit);
  await Promise.race([awaitReply(idInit), timeout(10000)]);
  send('notifications/initialized', {}, undefined);

  for (const callJson of calls) {
    const { tool, args = {} } = JSON.parse(callJson);
    const id = nextId++;
    send('tools/call', { name: tool, arguments: args }, id);
    const result = await Promise.race([awaitReply(id), timeout(20000)]);
    const text = result.content && result.content[0] ? result.content[0].text : '(sin contenido)';
    console.log(`\n===== ${tool} =====`);
    if (result.isError) console.log(text);
    else console.log(text.slice(0, 4000));
  }

  process.exitCode = 0;
} catch (err) {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
