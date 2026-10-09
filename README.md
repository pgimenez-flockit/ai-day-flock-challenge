# Catálogo de Software

Servicios, librerías y aplicaciones reutilizables. Catálogo de servicios, librerías, herramientas y funcionalidades del equipo, consultable por personas (web) y por agentes de IA (servidor MCP). Idea: antes de escribir código, el agente pregunta si ya existe.

```
Repos (catalog-info.yaml) ──> Ingestor ──┐
                                         ▼
Web UI ──┐
         ├──> API REST (Express) ──> Postgres
MCP ─────┘
```

Detalle completo en [SPEC.md](SPEC.md).

## Ejecutar en local

Requiere Node 20+ y un Postgres.

```bash
docker run -d --name catalog-pg -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16

npm install
export DATABASE_URL=postgres://postgres:pg@localhost:5432/postgres
npm start            # http://localhost:3000
```

La tabla `items` se crea (y migra, si venía de una versión anterior) sola al iniciar. Para cargar datos de ejemplo (una sola vez):

```bash
psql "$DATABASE_URL" -f seed.sql
```

Variables: `DATABASE_URL` (obligatoria), `PORT` (default 3000), `PGSSL=disable|require` (opcional; por defecto sin SSL para `localhost` y `*.railway.internal`, con SSL en el resto), `ANTHROPIC_API_KEY` y `ASK_MODEL` (opcionales, ver [Preguntar al catálogo](#preguntar-al-catálogo)).

## Deploy en Railway

1. Nuevo proyecto → **Deploy from GitHub repo** y elegir este repositorio.
2. Agregar un servicio **PostgreSQL** al mismo proyecto.
3. En el servicio de la app, crear la variable `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
4. Settings → Networking → **Generate Domain**.
5. Settings → Deploy → **Healthcheck Path**: `/health`.
6. Mantener **App Sleeping** desactivado.

### Seed

Una sola vez después del primer deploy: pegar el contenido de `seed.sql` en la pestaña **Query** de la base de Railway, o desde tu máquina:

```bash
psql "$DATABASE_PUBLIC_URL" -f seed.sql
```

## Preguntar al catálogo

La web incluye un cuadro "Preguntar al catálogo": una pregunta en lenguaje natural (por ejemplo "¿qué servicios siguen en Java 8?") que se responde con Claude, basándose solo en los ítems del catálogo. Cada ítem mencionado en la respuesta es un botón que lo abre en la lista.

- `ANTHROPIC_API_KEY`: clave de la API de Anthropic. Sin ella el cuadro se oculta y `POST /api/ask` responde 503. En Railway se define como variable del servicio de la app.
- `ASK_MODEL`: modelo a usar (default `claude-opus-5-5`). `claude-haiku-5-5` es una opción más económica que puede elegir quien administre el deploy.
- Endpoints: `GET /api/ask/status` devuelve `{ enabled }`; `POST /api/ask` recibe `{ question }` (3 a 500 caracteres) y devuelve `{ answer, items: [{ id, name }] }`.
- Límites: máximo 10 consultas cada 5 minutos por IP y 200 por hora en total (en memoria; se reinician con cada deploy). Superarlos devuelve 429.
- Costo: cada consulta envía el catálogo completo (hasta 500 ítems) como contexto, que se cachea entre consultas (prompt caching). El gasto crece con el tamaño del catálogo y la cantidad de consultas.

> **El endpoint es público.** Como el resto de la API, no tiene autenticación: cualquiera con el enlace puede hacer consultas y consumir el crédito de la clave. Conviene usar una clave dedicada con límite de gasto mensual y revisar el consumo.

## Servidor MCP (Claude Code)

El servidor MCP corre localmente por stdio y consulta la API desplegada.

```bash
claude mcp add catalog -e CATALOG_API_URL=https://<app>.up.railway.app -- node <ruta-absoluta>/mcp/server.js
claude mcp list   # catalog debe figurar como conectado
```

Herramientas: `search_catalog` (`query` y/o filtros `type`, `language`, `languageVersion`, `framework`; al menos uno) y `get_item` (id). Permite preguntas como "qué servicios siguen en Java 8" (`language=java`, `languageVersion=8`) y muestra el stack de cada ítem. Los ítems deprecados se marcan explícitamente.

## Catálogo como código

Cada repositorio se describe a sí mismo con un `catalog-info.yaml` en la raíz; un monorepo (o un repositorio de ejemplos) puede tener además uno por carpeta de módulo. El ingestor lee esos archivos desde GitHub y los carga como ítems `GIT` (se muestran con la insignia "desde git").

```yaml
apiVersion: catalog/v1
name: Validador de CUIT
type: LIBRARY              # SERVICE | TOOL | FEATURE | LIBRARY
description: >
  Valida y formatea números de CUIT/CUIL. Usarlo en lugar de reimplementar
  el dígito verificador en cada aplicación.
owner: Equipo Backend
status: ACTIVE             # opcional: ACTIVE | DEPRECATED
docsUrl: https://...       # opcional
install: npm i @flock/cuit # opcional
usageExample: |            # opcional
  import { isValidCuit } from '@flock/cuit';
tags: [validacion, afip]   # opcional
stack:                     # opcional (todas las claves son opcionales)
  language: java           # minúsculas
  languageVersion: "21"    # siempre entre comillas
  framework: spring-boot
  frameworkVersion: "3.2.5"
```

Un ítem por cada `catalog-info.yaml`. El de la raíz se identifica como `owner/repo`; los de carpetas internas como `owner/repo:carpeta/modulo`, y su URL apunta a esa carpeta en la rama por defecto. Se ignoran los archivos dentro de `node_modules/` y `dist/`, y se leen hasta 100 por repositorio (si hay más, el resumen lo indica). Las claves desconocidas se rechazan y `repoUrl` no se define en el YAML (se toma del repositorio). Los repositorios archivados dejan todos sus ítems como `DEPRECATED`.

El `stack` permite buscar por tecnología (por ejemplo `java 8` en el buscador, o `language=java&languageVersion=8` en la API) y resalta en la web los servicios con Java anterior a 17. `language` y `framework` van en minúsculas (`^[a-z0-9][a-z0-9.+-]{0,39}$`); las versiones aceptan letras, números, `.`, `+` y `-` (hasta 20 caracteres).

### Ejecutar el ingestor

```bash
export DATABASE_URL=postgres://...      # la misma base que usa la API
export GITHUB_OWNER=mi-usuario-u-org    # obligatoria
export GITHUB_TOKEN=github_pat_...      # opcional
npm run ingest -- --dry-run             # simula: no escribe nada
npm run ingest
```

- Sin `GITHUB_TOKEN` solo ve repositorios públicos (límite de 60 solicitudes/hora). Con token usa un token *fine-grained* de solo lectura: permisos **Contents** y **Metadata** (read-only).
- El resumen indica creados, actualizados, sin cambios, inválidos (con el motivo), sin catalogar (repositorios sin ningún `catalog-info.yaml`) y huérfanos (ítems git cuyo archivo ya no existe o no es válido; no se eliminan solos). Cada entrada se lista por su clave (`owner/repo` o `owner/repo:carpeta`).
- Es idempotente: ejecutarlo de nuevo sin cambios no duplica nada. `last_reviewed_at` solo cambia cuando cambia el contenido del YAML.
- Termina con código 1 solo ante errores fatales (base de datos o GitHub inaccesibles, credenciales inválidas).
- Para la base de Railway se puede ejecutar desde tu máquina con `DATABASE_URL` apuntando a `DATABASE_PUBLIC_URL`.

> **No ingerir repositorios de clientes en el deploy público.** La API no tiene autenticación: todo lo que se ingiere queda visible para cualquiera con el enlace.

### Skill `/catalog-item`

Este repositorio incluye una skill de Claude Code que redacta el `catalog-info.yaml` de un repositorio (lee README, manifiesto y puntos de entrada, y muestra el borrador para tu aprobación; nunca hace commit ni push). Para usarla en cualquier repositorio, cópiala a tu carpeta de skills:

```bash
mkdir -p ~/.claude/skills && cp -r .claude/skills/catalog-item ~/.claude/skills/
```

Luego, en Claude Code, dentro del repositorio a catalogar: `/catalog-item` (detecta también el `stack` desde `pom.xml` o `package.json`; en un monorepo propone un `catalog-info.yaml` por módulo). Este repositorio tiene su propio `catalog-info.yaml`.

## Guion de demo

1. En un repositorio de demo, ejecutar `/catalog-item` en Claude Code, revisar el `catalog-info.yaml` y subirlo.
2. Ejecutar `npm run ingest` y mostrar el resumen (creados / sin catalogar).
3. Mostrar el ítem en el catálogo web con la insignia "desde git" y hacer una pregunta en "Preguntar al catálogo".
4. En Claude Code, en una carpeta que no tenga ese proyecto clonado: "Necesito <tarea que resuelve el ítem>".
5. El agente encuentra el ítem vía MCP y explica cómo usarlo.

## Aviso

El enlace y la API son públicos y no tienen autenticación: no cargar secretos, credenciales, hosts internos ni información confidencial de clientes, ni ingerir repositorios de clientes.
