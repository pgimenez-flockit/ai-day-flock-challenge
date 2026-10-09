# Catálogo de Software (internal catalog) — MVP Spec

## 1. Purpose

**Problem:** the team rebuilds features, services, and tools that already exist, because that knowledge lives in people's heads and chat history.

**Solution:** a catalog that both **people** and **AI agents** can query before building something new, fed from the repositories themselves (**catalog as code**).

> Pitch: *"Before writing code, your agent asks whether it already exists."*

**MVP goal:** deployed and demoable today. Web UI + backend + own database + an MCP server so coding agents (e.g. Claude Code) can search the catalog without having the projects cloned locally + a git ingestor that keeps the catalog in sync with `catalog-info.yaml` files in each repository.

## 2. Scope

### In scope
- List and search catalog items (web UI and API).
- Create a new catalog item from the UI (manual items).
- Agent-ready items: each item carries enough info to go from "it exists" to "I can use it" (repo, install, usage example).
- Local MCP server (stdio) exposing `search_catalog` and `get_item`, backed by the deployed API.
- **Catalog as code:** each repository describes itself in a `catalog-info.yaml`; an ingestor reads those files from GitHub and upserts them.
- **Claude Code skill** `/catalog-item` that drafts a repository's `catalog-info.yaml` for human review.
- Persistent storage in Postgres.
- Public deploy reachable by URL.

### Out of scope (MVP)
- Authentication / authorization.
- Edit and delete from the UI.
- Automated tests, CI/CD pipeline.
- Remote (hosted) MCP server.
- Semantic search (embeddings / pgvector).
- LLM calls inside the ingestor (the ingestor is deterministic; see section 8).
- GitLab support (GitHub only for the demo; the source adapter is isolated so GitLab is an addition, not a rewrite).
- Scheduled ingestion (run manually for the demo; Railway cron is a later step).
- Review reminders for stale items.

## 3. Architecture

```
                          ┌─ Dev: Claude Code /catalog-item ─> catalog-info.yaml ─> PR review ─> merge
                          │
GitHub repos ──> Ingestor (npm run ingest) ──┐
                                             ▼
Person ──> Web UI (public/index.html) ──> REST API (Express) ──> Postgres (Railway)
AI agent ──> MCP server (stdio, local) ──┘
```

- The MCP server is a thin adapter over the public REST API. It holds no data and no business logic.
- The ingestor writes directly to Postgres (it is a trusted job, not a public endpoint), so git and database credentials never live in the web app.
- AI is used only where it is already approved: on the developer's machine (Claude Code) to draft the YAML, with a human reviewing it in the pull request. No repository content is sent to an LLM by the ingestor.

## 4. Stack

| Layer | Choice |
|---|---|
| Runtime / API | Node.js 20+ with Express |
| UI | Static `public/index.html` + vanilla JS (served by Express) |
| Database | Railway Postgres (same project as the app), accessed with `pg` |
| MCP server | `@modelcontextprotocol/sdk`, stdio transport, Node `fetch` |
| Ingestor | Node script, GitHub REST API via `fetch`, `yaml` package for parsing |
| Hosting | Railway service, deployed from GitHub; `DATABASE_URL` referenced from the Postgres service, `PORT` injected by Railway |
| Config | API: `DATABASE_URL`, `PORT`. MCP: `CATALOG_API_URL`. Ingestor: `DATABASE_URL`, `GITHUB_OWNER`, `GITHUB_TOKEN` (optional) |

## 5. Data model

Table `items`:

| Column | Type | Rules |
|---|---|---|
| `id` | `serial` | PK |
| `name` | `text` | required, max 120 chars |
| `type` | `text` | required, one of `SERVICE`, `TOOL`, `FEATURE`, `LIBRARY` |
| `description` | `text` | required, max 1000 chars. What it does and when to use it. |
| `owner` | `text` | required (team or person to contact) |
| `status` | `text` | one of `ACTIVE`, `DEPRECATED`; default `ACTIVE` |
| `repo_url` | `text` | optional, must start with `http://` or `https://` |
| `docs_url` | `text` | optional, must start with `http://` or `https://` |
| `install` | `text` | optional, max 500 chars (e.g. Maven dependency, npm command) |
| `usage_example` | `text` | optional, max 2000 chars (short snippet) |
| `tags` | `text[]` | optional, default `{}` |
| `stack` | `jsonb` | optional, `NULL` when absent. Object with optional string keys `language`, `languageVersion`, `framework`, `frameworkVersion` (see below) |
| `source` | `text` | `MANUAL` or `GIT`; default `MANUAL` |
| `source_repo` | `text` | source key of git items, `NULL` for manual ones; **unique**. `owner/repo` for the `catalog-info.yaml` at the repository root, `owner/repo:<dir path>` for nested ones (e.g. `acme/samples:policy-service`) |
| `last_synced_at` | `timestamptz` | set by the ingestor on every sync; `NULL` for manual items |
| `last_reviewed_at` | `timestamptz` | default `now()`; for git items, updated only when the YAML content changes |
| `created_at` | `timestamptz` | default `now()` |

**`stack` rules** (shared validation module, used by the API and the ingestor):
- Must be a plain object when present; unknown keys are rejected; an empty object is stored as `NULL`.
- `language` and `framework`: lowercase, `^[a-z0-9][a-z0-9.+-]{0,39}$` (e.g. `java`, `typescript`, `spring-boot`, `angular`).
- `languageVersion` and `frameworkVersion`: strings matching `^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$` (e.g. `"8"`, `"21"`, `"3.2.5"`). Numbers are rejected (quote them in YAML).

Schema bootstrap on startup: `CREATE TABLE IF NOT EXISTS`, then `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for the `source`, `source_repo`, `last_synced_at`, and `stack` columns, so existing databases migrate in place without data loss.

## 6. REST API

JSON fields use camelCase (`repoUrl`, `docsUrl`, `usageExample`, `stack`, `source`, `sourceRepo`, `lastSyncedAt`, `lastReviewedAt`, `createdAt`).

### `GET /api/items?q=<text>&type=<TYPE>&status=<STATUS>&source=<SOURCE>&language=<l>&languageVersion=<v>&framework=<f>`
- Returns `200` with a JSON array of items, ordered by `name` ascending, max 50.
- `q` (optional): case-insensitive match on `name`, `description`, `owner`, any tag, or the stack label (`language languageVersion framework frameworkVersion` joined by spaces, so `q=java 8` matches Java 8 but not Java 17).
- `type`, `status`, `source`, `language`, `languageVersion`, `framework` (optional): exact match.
- Invalid `type`, `status`, or `source`, or a `language` / `languageVersion` / `framework` that does not match the `stack` rules → `400`.

### `GET /api/items/:id`
- Returns `200` with the full item, `404` if not found, `400` if `id` is not an integer.

### `POST /api/items`
- Body: `{ name, type, description, owner, status?, repoUrl?, docsUrl?, install?, usageExample?, tags?, stack? }` (`tags` as string array, `stack` as object, see section 5).
- Always creates a `MANUAL` item (clients cannot set `source` or `sourceRepo`).
- Valid → `201` with the created item. Invalid → `400` with `{ error: "<message>" }`.

### `GET /health`
- Returns `200 { status: "ok" }` (used as Railway health check path).

All SQL uses parameterized queries. No string concatenation of user input. Validation rules live in one shared module used by both the API and the ingestor.

## 7. MCP server

Location: `mcp/server.js`. Runs locally over stdio; reads `CATALOG_API_URL` (base URL of the deployed API).

### Tool `search_catalog`
- **Description (for the agent):** "Search the team's internal catalog of existing services, libraries, tools and features. Call this BEFORE implementing new functionality to check whether something reusable already exists." plus a note that it can answer inventory questions such as "which services still run on Java 8" by filtering `language=java`, `languageVersion=8`.
- **Input:** `{ query?: string, type?: "SERVICE" | "TOOL" | "FEATURE" | "LIBRARY", language?: string, languageVersion?: string, framework?: string }`. At least one of `query` or a filter is required; otherwise the tool returns `isError: true` with a clear message.
- **Output:** compact text list (max 10): `id`, `name`, `type`, `status`, one-line description, `owner`, and the stack when present (e.g. `stack: Java 21 · Spring Boot 3.2.5`).

### Tool `get_item`
- **Description (for the agent):** "Get full details of a catalog item, including repository, install instructions and usage example."
- **Input:** `{ id: number }`
- **Output:** all item fields as readable text, including the stack (`Stack: Java 21 · Spring Boot 3.2.5`), source (`git: <source key>`, e.g. `owner/repo` or `owner/repo:dir`, or `manual`) and last sync.

### Behavior
- `DEPRECATED` items are flagged explicitly in both tools' output so the agent does not recommend them silently.
- HTTP timeout 15 s (Railway services do not sleep by default).
- API errors are returned as tool errors (`isError: true`) with a clear message; the server never crashes on a failed request.

### Registration (Claude Code)
```bash
claude mcp add catalog -e CATALOG_API_URL=https://<app>.up.railway.app -- node mcp/server.js
```

## 8. Catalog as code

### 8.1 `catalog-info.yaml` (repository root)

```yaml
apiVersion: catalog/v1
name: Validador de CUIT
type: LIBRARY              # SERVICE | TOOL | FEATURE | LIBRARY
description: >
  Valida y formatea números de CUIT/CUIL. Usarlo en lugar de reimplementar
  el dígito verificador en cada aplicación.
owner: Equipo Backend
status: ACTIVE             # ACTIVE | DEPRECATED (optional, default ACTIVE)
docsUrl: https://...       # optional
install: npm i @flock/cuit # optional
usageExample: |            # optional
  import { isValidCuit } from '@flock/cuit';
  isValidCuit('20-12345678-9');
tags: [validacion, afip]   # optional
stack:                     # optional; every key optional, versions always quoted strings
  language: java
  languageVersion: "21"
  framework: spring-boot
  frameworkVersion: "3.2.5"
```

- One item per `catalog-info.yaml`. A repository has one at its root and, for monorepos or sample repositories, may have one per module folder (e.g. `policy-service/catalog-info.yaml`).
- `apiVersion` must be `catalog/v1`; unknown keys are rejected so typos surface early.
- `repoUrl` is **not** set in the YAML: the ingestor derives it (the repository's GitHub URL for the root file; the folder's URL for nested files, see 8.2).
- `stack` follows the rules in section 5.
- Same validation rules as `POST /api/items`.

### 8.2 Ingestor (`scripts/ingest.js`, `npm run ingest`)

1. **Discover:** list repositories of `GITHUB_OWNER` through the GitHub REST API, following pagination.
   - With `GITHUB_TOKEN`: authenticated listing, includes private repositories the token can read.
   - Without token: public repositories only (60 requests/hour limit — enough for a demo).
   - Skip forks.
2. **Find and read:** for each repository, get the tree of the default branch (`GET /repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1`) and collect the blobs named `catalog-info.yaml` at the root or in any folder. Paths under `node_modules/` or `dist/` are skipped. At most 100 files per repository are read; if there are more, or the API reports the tree as truncated, the repository is listed in the report as partially read. Each file is fetched through the contents API (path URL-encoded). A repository with no such file (including an empty repository: tree `409`/`404`) is reported as **uncataloged**, never as a fatal error.
3. **Validate:** parse each YAML (no custom tags / no code execution) and validate with the shared rules. Invalid → reported with the error message, nothing written for that file; the other files of the same repository are still processed.
4. **Map:** archived repositories force all their items to `DEPRECATED`. `source` = `GIT`. The source key (`sourceRepo`) is `owner/repo` for the root file and `owner/repo:<dir path>` for nested ones. `repoUrl` is the repository URL for the root file and `<html_url>/tree/<default_branch>/<dir>` (path segments URL-encoded) for nested ones.
5. **Upsert:** `INSERT ... ON CONFLICT (source_repo) DO UPDATE`; `last_synced_at = now()` always; `last_reviewed_at = now()` only when content changed.
6. **Report:** print a summary — repositories reviewed, files found, created, updated, unchanged, invalid (with reasons), uncataloged (repositories with zero YAML files), partially read repositories, orphaned — listing items by their source key, and exit `0`. Exit `1` only on fatal errors (database or GitHub unreachable, auth failure).

Rules:
- `--dry-run` flag: does everything except writing to the database.
- Git items whose source key no longer has a valid YAML are left unchanged and listed as **orphaned** in the report (no automatic deletion). Detection works per source key, over the existing git items whose key starts with `owner/`.
- The token is never logged. Requests use a 15 s timeout.
- The GitHub access lives in its own module (`scripts/sources/github.js`) so a GitLab source can be added later without touching the rest.

### 8.3 Claude Code skill `/catalog-item`

Location: `.claude/skills/catalog-item/SKILL.md` (shipped in this repo; copy it to `~/.claude/skills/` to use it in any repository).

The skill instructs Claude Code to:
1. Read the current repository (README, `package.json` / `pom.xml`, main entry points).
2. Draft `catalog-info.yaml` following section 8.1, with the description written as "what it does and when to use it" and a short, real usage example. Detect the `stack` from the manifests (`pom.xml` `java.version` / `maven.compiler.release` / Spring Boot parent, `package.json` `@angular/core`, normalizing `1.8` to `8`) and quote the versions. In monorepos, propose one `catalog-info.yaml` per module folder.
3. **Never** include secrets, credentials, internal hostnames, IPs, or client-confidential data.
4. Show the file to the developer for review before writing it; never commit or push.

This repository ships its own `catalog-info.yaml` (the catalog catalogs itself).

## 9. UI

Single page with:
1. **Search bar** + type filter; results update on input (debounced ~300 ms).
2. **Results list** as cards: name, type badge, stack badges, status (deprecated visibly marked), description, owner, links, tags.
3. **Card detail** (expand): the stack (`Stack: Java 21 · Spring Boot 3.2.5`), install and usage example in a monospace block; for git items, the source key as is ("Sincronizado desde owner/repo:dir") and last sync time.
4. **Origin badge:** git items show a "desde git" badge.
5. **Stack badges** (not interactive): language badge (`Java 21`, `TypeScript 5.4`) and framework badge (`Spring Boot 3.2` as major.minor; `Angular 18` as major for frameworks versioned by major). Java language version below 17 → warning-style badge with title "Versión de Java legacy"; Java 17 or later → success-style badge; everything else neutral.
6. **Empty state:** invites the user to add the missing item.
7. **Create form:** fields from the data model, except `stack` (it comes from git, not from the form); on success the list refreshes, filters reset, and the new item is shown expanded; on error the API message is shown.

User-provided content is rendered as text (no `innerHTML` with raw data).

**UI language:** all user-facing copy is in neutral Spanish (e.g. "Catálogo de Software" with subtitle "Servicios, librerías y aplicaciones reutilizables", "Agregar ítem", "Buscar por nombre, etiqueta, responsable o stack", type labels Servicio / Librería / Herramienta / Funcionalidad, badges "deprecado", "listo para agentes", "desde git"). Code, identifiers, API fields, and enum values stay in English.

**Look and feel:** clean, flat, card-based layout; color-coded type badges; "listo para agentes" badge when an item has `install` and `usageExample`; deprecated items dimmed and struck through; light and dark mode support.

## 10. Seed data

`seed.sql` with 10–15 example items (no sensitive data). At least 3 items include `install` and `usageExample`. Seeded items are `MANUAL`. Run once against Railway Postgres after the first deploy (Railway database query tab or `psql "$DATABASE_PUBLIC_URL" -f seed.sql` from a local machine). For the demo, git-ingested items should be the protagonists; the seed is optional.

## 11. Acceptance criteria

### Web / API
- [ ] Opening the deployed URL shows the catalog.
- [ ] Searching a term present in a tag returns that item.
- [ ] Filtering by type shows only items of that type.
- [ ] Creating a valid item shows it in the list immediately and it persists after reload.
- [ ] Submitting without `name` shows a validation error and creates nothing.
- [ ] Data survives a Railway redeploy (stored in Postgres, not on the service filesystem).

### Catalog as code
- [ ] Running `npm run ingest` with `GITHUB_OWNER` set creates one `GIT` item per repository with a valid `catalog-info.yaml`.
- [ ] Running it again without changes reports all items as unchanged and creates no duplicates.
- [ ] Editing a YAML and re-running updates the item and its `last_reviewed_at`.
- [ ] A repository with an invalid YAML is reported with the reason and nothing is written for it.
- [ ] Repositories without YAML are listed as uncataloged (an empty repository included).
- [ ] A repository with several `catalog-info.yaml` files (monorepo) yields one item per file, keyed `owner/repo` (root) or `owner/repo:<dir>` (nested), with `repoUrl` pointing to the folder; files under `node_modules/` or `dist/` are ignored.
- [ ] Removing one nested YAML and re-running lists only that source key as orphaned.
- [ ] A `stack` in the YAML is stored, shown as badges (Java below 17 highlighted as legacy) and changes `last_reviewed_at` when edited.
- [ ] `q=java 8` and `language=java&languageVersion=8` return only Java 8 items; an invalid `language` returns `400`.
- [ ] `--dry-run` writes nothing.
- [ ] Ingested items show the "desde git" badge in the UI and are found by the MCP tools.
- [ ] Existing databases created by the previous schema migrate without losing data.

### Agent (MCP)
- [ ] `claude mcp list` shows `catalog` as connected.
- [ ] Asking Claude Code "I need to integrate with <item>" makes the agent call `search_catalog` and answer with the item's name, owner, and repo.
- [ ] Asking for details makes the agent call `get_item` and return install + usage example.
- [ ] An item created from the web UI is found by the agent without restarting anything.
- [ ] Asking "which services still run on Java 8" makes the agent call `search_catalog` with `language=java`, `languageVersion=8`; calling it with no query and no filter returns a tool error.
- [ ] With the API unreachable, the tool returns an error message and the MCP server keeps running.

## 12. Demo script

1. In a demo repository, run `/catalog-item` in Claude Code; review the drafted `catalog-info.yaml` and push it.
2. Run `npm run ingest`; show the summary (created / uncataloged).
3. Show the item in the web catalog with the "desde git" badge.
4. In Claude Code, in a folder without that project cloned: "I need to <task the item solves>". The agent finds it via MCP and explains how to use it.
5. Close with the path to production: same flow running inside the client's network, reading their GitLab, with SSO.

## 13. Project structure

```
ai-day-flock-challenge/
├── server.js                     # Express app: routes, static files
├── db.js                         # pg Pool + schema bootstrap/migration
├── lib/validation.js             # shared item + stack validation (API + ingestor)
├── mcp/server.js                 # MCP stdio server (adapter over REST API)
├── scripts/ingest.js             # git ingestor (npm run ingest)
├── scripts/sources/github.js     # GitHub source adapter (repos, tree, nested catalog-info.yaml)
├── .claude/skills/catalog-item/SKILL.md
├── catalog-info.yaml             # this repo's own catalog entry
├── seed.sql
├── public/index.html
├── package.json
├── README.md
└── SPEC.md
```

## 14. Known constraints

- Railway trial: one-time US$5 credit for 30 days; app + Postgres running continuously consume it. Keeping it online afterwards requires the Hobby plan or moving the database (e.g. Neon). Keep "App Sleeping" disabled for the demo.
- Link and API are public: do not store secrets, credentials, internal hostnames, or client-confidential information. **Do not ingest client repositories into the public deploy.**
- The app must listen on `process.env.PORT`.
- Each repository costs one tree request plus one request per `catalog-info.yaml`; monorepos consume the unauthenticated limit quickly.
- Unauthenticated GitHub API: 60 requests/hour; use `GITHUB_TOKEN` (fine-grained, read-only "Contents" and "Metadata") beyond a few repositories.

## 15. Path to production (client environment)

1. Deploy app, database, and ingestor inside the client's network (Kubernetes/OpenShift), behind corporate SSO.
2. GitLab source adapter with a read-only token stored in the client's secret manager.
3. Ingestor as a nightly job; uncataloged repositories reported to each team.
4. `/catalog-item` skill distributed to developers; a merge request rule asks for `catalog-info.yaml` in new libraries and services.
5. Hosted MCP server (streamable HTTP) with auth, so no local setup is needed.

## 16. Future evolution

1. Semantic search with embeddings in `pgvector`.
2. "Preguntar" box in the UI: natural-language answers grounded on catalog items.
3. Freshness: reminders to owners when `last_reviewed_at` is older than 90 days.
4. Stack inventory report (e.g. all services per Java version) and upgrade-deadline alerts for legacy runtimes.
