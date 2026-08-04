# Estructura de Skills, MCP y Plugins para Antigravity

Esta guía reúne ejemplos de estructuras de repositorios GitHub que pueden instalarse con:

```powershell
agy plugin install https://github.com/usuario/mi-plugin
```

La idea principal es distinguir entre:

- **Skill:** instrucciones y conocimiento para el agente.
- **MCP:** herramientas reales que el agente puede ejecutar.
- **Plugin:** paquete instalable que puede contener Skills, MCP, reglas, hooks y agentes.

---

# 1. Estructura mínima de un plugin

```text
mi-plugin/
├── plugin.json
└── README.md
```

## `plugin.json`

```json
{
  "$schema": "https://antigravity.google/schemas/v1/plugin.json",
  "name": "mi-plugin",
  "description": "Descripción breve de lo que agrega este plugin."
}
```

Un plugin vacío no realiza ninguna acción. Debe incluir al menos una Skill, un MCP, una regla, un hook o un agente.

---

# 2. Plugin que contiene solamente una Skill

```text
mi-skill-plugin/
├── plugin.json
├── README.md
└── skills/
    └── sql-review/
        ├── SKILL.md
        ├── scripts/
        │   └── validate_sql.py
        ├── examples/
        │   └── example.sql
        └── resources/
            └── checklist.md
```

## `plugin.json`

```json
{
  "$schema": "https://antigravity.google/schemas/v1/plugin.json",
  "name": "sql-review-tools",
  "description": "Skill para revisar y optimizar consultas SQL."
}
```

## `skills/sql-review/SKILL.md`

```markdown
---
name: sql-review
description: Revisa consultas SQL para detectar errores, problemas de rendimiento, joins incorrectos, filtros deficientes e índices potenciales. Usar cuando el usuario solicite revisar, corregir u optimizar SQL.
---

# SQL Review

Analiza la consulta SQL siguiendo este orden:

1. Identifica el motor de base de datos.
2. Verifica errores de sintaxis.
3. Revisa los JOIN y sus condiciones.
4. Detecta filtros que impidan utilizar índices.
5. Identifica conversiones innecesarias.
6. Revisa agrupaciones y duplicados.
7. Propón una versión corregida.
8. Explica brevemente cada cambio.

## Reglas

- No cambies la lógica funcional sin indicarlo.
- No inventes tablas ni columnas.
- Mantén los nombres originales.
- Distingue entre SQL Server, MySQL, PostgreSQL y SAP HANA.
- Advierte antes de recomendar operaciones destructivas.

## Recursos

Consulta `resources/checklist.md` cuando la revisión sea extensa.

## Scripts

Cuando necesites validar formato, ejecuta:

```bash
python scripts/validate_sql.py --help
```
```

---

# 3. Plugin que contiene solamente un MCP

```text
mi-mcp-plugin/
├── plugin.json
├── mcp_config.json
├── README.md
├── package.json
├── package-lock.json
└── src/
    └── server.js
```

## `plugin.json`

```json
{
  "$schema": "https://antigravity.google/schemas/v1/plugin.json",
  "name": "company-database-mcp",
  "description": "Herramientas MCP de consulta segura para la base de datos empresarial."
}
```

## `mcp_config.json` para un MCP local por `stdio`

```json
{
  "mcpServers": {
    "company-database": {
      "command": "node",
      "args": [
        "./src/server.js"
      ],
      "env": {
        "DB_HOST": "${DB_HOST}",
        "DB_PORT": "${DB_PORT}",
        "DB_USER": "${DB_USER}",
        "DB_PASSWORD": "${DB_PASSWORD}"
      }
    }
  }
}
```

## MCP remoto

```json
{
  "mcpServers": {
    "company-api": {
      "serverUrl": "https://mcp.ejemplo.com/mcp",
      "headers": {
        "Authorization": "Bearer ${COMPANY_MCP_TOKEN}"
      }
    }
  }
}
```

No coloques secretos reales dentro del repositorio.

---

# 4. Plugin completo: Skill + MCP

```text
sap-business-one-plugin/
├── plugin.json
├── mcp_config.json
├── README.md
├── LICENSE
├── .env.example
├── skills/
│   ├── sap-query/
│   │   ├── SKILL.md
│   │   └── resources/
│   │       └── sap-tables.md
│   └── sap-document-review/
│       └── SKILL.md
├── server/
│   ├── package.json
│   ├── package-lock.json
│   └── src/
│       ├── index.js
│       └── tools/
│           ├── query-stock.js
│           └── find-business-partner.js
├── rules/
│   └── sap-safety.md
└── scripts/
    ├── setup.ps1
    └── setup.sh
```

| Componente | Función |
|---|---|
| `plugin.json` | Identifica el repositorio como plugin |
| `skills/` | Enseña al agente cuándo y cómo ejecutar un proceso |
| `mcp_config.json` | Registra servidores y herramientas MCP |
| `server/` | Implementa el servidor MCP |
| `rules/` | Define restricciones permanentes |
| `hooks.json` | Ejecuta comprobaciones antes o después de herramientas |
| `agents/` | Define subagentes especializados |
| `.env.example` | Documenta variables necesarias sin incluir secretos |

## Ejemplo de Skill que usa el MCP

```markdown
---
name: sap-stock-query
description: Consulta y analiza inventario de artículos en SAP Business One. Usar cuando el usuario solicite stock, comprometido, pedido o disponibilidad por sucursal.
---

# Consulta de inventario SAP

Cuando el usuario solicite inventario:

1. Solicita el código del artículo si no fue proporcionado.
2. Identifica la sucursal o almacén.
3. Usa la herramienta MCP `sap_get_stock`.
4. Presenta:
   - Existencia
   - Comprometido
   - Pedido
   - Disponible
5. No ejecutes actualizaciones.
6. No muestres credenciales ni cadenas de conexión.

La disponibilidad se calcula como:

`OnHand - IsCommited + OnOrder`
```

---

# 5. Plugin con Hooks

```text
formatter-plugin/
├── plugin.json
├── hooks.json
├── scripts/
│   └── format.ps1
└── skills/
    └── format-project/
        └── SKILL.md
```

## Ejemplo de `hooks.json`

```json
{
  "format-after-edit": {
    "PostToolUse": [
      {
        "matcher": "write_file",
        "hooks": [
          {
            "type": "command",
            "command": "pwsh -File ./scripts/format.ps1",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Los hooks pueden usarse para ejecutar formateadores, pruebas, validaciones de seguridad y registros de auditoría.

---

# 6. Monorepo con varios plugins

```text
mis-plugins/
├── README.md
└── plugins/
    ├── sql-tools/
    │   ├── plugin.json
    │   └── skills/
    │       └── sql-review/
    │           └── SKILL.md
    ├── sap-tools/
    │   ├── plugin.json
    │   ├── mcp_config.json
    │   └── skills/
    │       └── sap-query/
    │           └── SKILL.md
    └── excel-tools/
        ├── plugin.json
        └── skills/
            └── excel-report/
                └── SKILL.md
```

Instalación desde una ruta concreta:

```powershell
agy plugin install https://github.com/usuario/mis-plugins/tree/main/plugins/sql-tools
```

Si la versión de `agy` no admite subdirectorios por URL:

```powershell
git clone https://github.com/usuario/mis-plugins
cd mis-plugins
agy plugin install .\plugins\sql-tools
```

---

# 7. Repositorio mínimo funcional de una Skill

```text
agy-sql-review/
├── plugin.json
├── README.md
└── skills/
    └── sql-review/
        └── SKILL.md
```

## `plugin.json`

```json
{
  "$schema": "https://antigravity.google/schemas/v1/plugin.json",
  "name": "agy-sql-review",
  "description": "Revisión y optimización de consultas SQL."
}
```

## `skills/sql-review/SKILL.md`

```markdown
---
name: sql-review
description: Revisa, corrige y optimiza consultas SQL Server, MySQL, PostgreSQL y SAP HANA.
---

# SQL Review

Cuando se solicite revisar SQL:

1. Identifica el motor.
2. Valida sintaxis.
3. Revisa JOIN, WHERE, GROUP BY y ORDER BY.
4. Detecta problemas de rendimiento.
5. Devuelve la consulta corregida.
6. Explica los cambios importantes.
7. No inventes objetos de base de datos.
```

---

# 8. Ejemplo de `.env.example`

```env
DB_HOST=localhost
DB_PORT=1433
DB_NAME=database_name
DB_USER=database_user
DB_PASSWORD=change_me
COMPANY_MCP_TOKEN=change_me
```

## `.gitignore`

```gitignore
.env
.env.*
!.env.example
node_modules/
target/
dist/
logs/
```

---

# 9. Instalación y verificación

## Instalar desde GitHub

```powershell
agy plugin install https://github.com/usuario/agy-sql-review
```

## Ver plugins instalados

```powershell
agy plugin list
```

## Ver ayuda

```powershell
agy plugin --help
```

## Instalar desde una carpeta local

```powershell
agy plugin install .
```

## Posible validación

```powershell
agy plugin validate .
```

Comprueba primero si el comando existe:

```powershell
agy plugin --help
```

Dentro de Antigravity:

```text
/skills
/mcp
/hooks
```

---

# 10. Recomendaciones de portabilidad

- Utiliza rutas relativas.
- No escribas rutas absolutas de Windows.
- No incluyas contraseñas.
- Documenta las variables de entorno.
- Incluye `.env.example`.
- Incluye instrucciones para instalar dependencias.
- No asumas que Node.js, Python o Rust ya están instalados.
- Evita depender de comandos específicos del sistema operativo.
- Incluye scripts separados para PowerShell y Bash cuando sea necesario.
- Define versiones compatibles de dependencias.
- Añade `LICENSE`.
- Añade ejemplos de uso en `README.md`.

---

# 11. Errores que debes evitar

- Colocar `SKILL.md` directamente dentro de `skills/` sin una carpeta propia.
- Guardar credenciales en `plugin.json`.
- Guardar secretos en `mcp_config.json`.
- Utilizar rutas absolutas como `C:\Users\Nombre\Proyecto`.
- Exponer un comando de shell genérico.
- Permitir consultas destructivas sin controles.
- No validar parámetros recibidos por el MCP.
- Confiar en que el plugin ejecutará automáticamente un instalador.
- No documentar dependencias.
- Incluir `node_modules`, `target` o binarios grandes en GitHub.
- Dar permisos excesivos al agente.
- No agregar timeouts.
- No registrar errores.
- No validar rutas de archivos.

---

# 12. Diferencia entre Skill, MCP y Plugin

```text
Skill
= instrucciones, conocimiento y procedimiento para el agente

MCP
= herramientas reales que el agente puede ejecutar

Plugin
= paquete instalable que puede contener Skills, MCP, Hooks, reglas y agentes
```

## Ejemplo práctico

```text
Plugin SAP Business One
│
├── Skill
│   └── Explica cuándo consultar stock y cómo presentar el resultado
│
├── MCP
│   └── Ejecuta realmente la consulta contra SAP o una API
│
├── Rule
│   └── Prohíbe DELETE, UPDATE y exposición de credenciales
│
└── Hook
    └── Registra todas las consultas ejecutadas
```

---

# 13. Estructura recomendada para un plugin profesional

```text
mi-plugin/
├── plugin.json
├── README.md
├── LICENSE
├── .gitignore
├── .env.example
├── mcp_config.json
├── skills/
│   └── mi-skill/
│       ├── SKILL.md
│       ├── resources/
│       ├── examples/
│       └── scripts/
├── server/
│   ├── package.json
│   ├── src/
│   └── tests/
├── rules/
├── hooks/
├── agents/
├── scripts/
│   ├── setup.ps1
│   └── setup.sh
└── docs/
    ├── installation.md
    ├── configuration.md
    └── security.md
```

---

# 14. Flujo recomendado para crear un plugin

1. Define el problema que resolverá.
2. Decide si solo necesita una Skill o también un MCP.
3. Crea `plugin.json`.
4. Crea una carpeta por cada Skill.
5. Escribe descripciones claras en el frontmatter.
6. Implementa el servidor MCP con herramientas pequeñas y específicas.
7. Valida todos los parámetros.
8. Agrega controles de seguridad.
9. Incluye `.env.example`.
10. Documenta instalación y uso.
11. Prueba la instalación local.
12. Publica en GitHub.
13. Instala usando `agy plugin install`.
14. Verifica `/skills`, `/mcp` y `/hooks`.
