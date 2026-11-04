import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { envValue, loadConfig } from '../src/context.js';

test('envValue ignora vacíos y variables sin expandir', () => {
  assert.equal(envValue(undefined), undefined);
  assert.equal(envValue('  '), undefined);
  assert.equal(envValue('${ZOTERO_API_URL}'), undefined);
  assert.equal(envValue(' apa '), 'apa');
});

test('loadConfig usa los valores por defecto si las variables llegan como ${VAR}', () => {
  // Como si se copiara mcp_config.json a un cliente que no expande variables.
  const placeholders = Object.fromEntries(
    ['ZOTERO_API_URL', 'ZOTERO_DEFAULT_STYLE', 'ZOTERO_LOCALE', 'ZOTERO_MCP_BACKUP', 'ZOTERO_MCP_ALLOWED_DIRS', 'OPENALEX_API_KEY', 'ZOTERO_MCP_CONTACT_EMAIL'].map(
      (n) => [n, `\${${n}}`]
    )
  );
  assert.deepEqual(loadConfig(placeholders), {
    apiUrl: 'http://127.0.0.1:23119/api',
    defaultStyle: 'apa',
    defaultLocale: 'es-ES',
    backup: true,
    allowedDirs: [],
    openAlexKey: undefined,
    contactEmail: undefined,
  });
});

test('loadConfig lee los valores reales', () => {
  const dir = path.resolve('/docs/tesis');
  const cfg = loadConfig({
    ZOTERO_API_URL: ' http://localhost:9999/api ',
    ZOTERO_DEFAULT_STYLE: 'ieee',
    ZOTERO_LOCALE: 'en-US',
    ZOTERO_MCP_BACKUP: 'false',
    ZOTERO_MCP_ALLOWED_DIRS: dir,
    OPENALEX_API_KEY: 'k',
  });
  assert.equal(cfg.apiUrl, 'http://localhost:9999/api');
  assert.equal(cfg.defaultStyle, 'ieee');
  assert.equal(cfg.defaultLocale, 'en-US');
  assert.equal(cfg.backup, false);
  assert.deepEqual(cfg.allowedDirs, [dir]);
  assert.equal(cfg.openAlexKey, 'k');
});
