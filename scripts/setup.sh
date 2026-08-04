#!/usr/bin/env sh
# Instala las dependencias del servidor MCP de Zotero.
set -e
cd "$(dirname "$0")" || exit 1
echo "Instalando dependencias npm..."
npm install
echo "Listo. Prueba con: npm test"
