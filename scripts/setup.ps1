# Instala las dependencias del servidor MCP de Zotero.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
Write-Host "Instalando dependencias npm..."
npm install
Write-Host "Listo. Prueba con: npm test"
