// smoke.mjs
// Verificación rápida: arranca el servidor MCP, hace el handshake por stdio
// y lista las herramientas registradas. Uso: node scripts/smoke.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
  send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.1' },
  }, idInit);
  await Promise.race([awaitReply(idInit), timeout(10000)]);

  send('notifications/initialized', {}, undefined);

  const idList = nextId++;
  send('tools/list', {}, idList);
  const result = await Promise.race([awaitReply(idList), timeout(10000)]);

  const tools = result.tools.map((t) => t.name);
  console.log('Herramientas registradas (%d):', tools.length);
  for (const name of tools) console.log('  -', name);
  console.log('total:', tools.length);

  const idShutdown = nextId++;
  send('shutdown', {}, idShutdown);
  await Promise.race([awaitReply(idShutdown).catch(() => null), timeout(3000)]);

  const EXPECTED = [
    'zotero_status',
    'zotero_search',
    'zotero_get_item',
    'zotero_list_collections',
    'zotero_cite',
    'zotero_bibliography',
  ];
  if (EXPECTED.every((t) => tools.includes(t))) {
    console.log('OK: todas las herramientas esperadas están presentes.');
    process.exitCode = 0;
  } else {
    console.error('FALTA: algunas herramientas esperadas no se registraron.');
    process.exitCode = 1;
  }
} catch (err) {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
