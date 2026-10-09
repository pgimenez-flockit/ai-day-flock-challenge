# Internal Catalog — MVP Spec

## 1. Purpose

**Problem:** the team rebuilds features, services, and tools that already exist, because that knowledge lives in people's heads and chat history.

**Solution:** a catalog that both **people** and **AI agents** can query before building something new.

> Pitch: *"Before writing code, your agent asks whether it already exists."*

**MVP goal:** deployed and demoable today. Web UI + backend + own database + an MCP server so coding agents (e.g. Claude Code) can search the catalog without having the projects cloned locally.

## 2. Scope

### In scope
- List and search catalog items (web UI and API).
- Create a new catalog item from the UI.
- Agent-ready items: each item carries enough info to go from "it exists" to "I can use it" (repo, install, usage example).
- Local MCP server (stdio) exposing `search_catalog` and `get_item`, backed by the deployed API.
- Persistent storage in Postgres.
- Public deploy reachable by URL.

### Out of scope (MVP)
- Authentication / authorization.
- Edit and delete.
- Automated tests, CI/CD pipeline.
- Remote (hosted) MCP server.
- Semantic search (embeddings / pgvector).
- Automatic ingestion from repositories.
- Review reminders for stale items.

## 3. Architecture

```
Person ──> Web UI (public/index.html) ──┐
                                        ├──> REST API (Express) ──> Postgres (Railway)
AI agent ──> MCP server (stdio, local) ─┘
```

The MCP server is a thin adapter over the public REST API. It holds no data and no business logic. This keeps a future hosted MCP a deployment change, not a rewrite.

## 4. Stack

| Layer | Choice |
|---|---|
| Runtime / API | Node.js 20+ with Express |
| UI | Static `public/index.html` + vanilla JS (served by Express) |
| Database | Railway Postgres (same project as the app), accessed with `pg` |
| MCP server | `@modelcontextprotocol/sdk`, stdio transport, Node `fetch` |
| Hosting | Railway service, deployed from GitHub; `DATABASE_URL` referenced from the Postgres service, `PORT` injected by Railway |
| Config | API: `DATABASE_URL`, `PORT`. MCP: `CATALOG_API_URL` |

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
| `last_reviewed_at` | `timestamptz` | default `now()` |
| `created_at` | `timestamptz` | default `now()` |

The table is created on startup if it does not exist (`CREATE TABLE IF NOT EXISTS`).

## 6. REST API

JSON fields use camelCase (`repoUrl`, `docsUrl`, `usageExample`, `lastReviewedAt`, `createdAt`).

### `GET /api/items?q=<text>&type=<TYPE>&status=<STATUS>`
- Returns `200` with a JSON array of items, ordered by `name` ascending, max 50.
- `q` (optional): case-insensitive match on `name`, `description`, `owner`, or any tag.
- `type`, `status` (optional): exact match.
- Invalid `type` or `status` → `400`.

### `GET /api/items/:id`
- Returns `200` with the full item, `404` if not found, `400` if `id` is not an integer.

### `POST /api/items`
- Body: `{ name, type, description, owner, status?, repoUrl?, docsUrl?, install?, usageExample?, tags? }` (`tags` as string array).
- Valid → `201` with the created item.
- Invalid → `400` with `{ error: "<message>" }`.

### `GET /health`
- Returns `200 { status: "ok" }` (used as Railway health check path).

All SQL uses parameterized queries. No string concatenation of user input.

## 7. MCP server

Location: `mcp/server.js`. Runs locally over stdio; reads `CATALOG_API_URL` (base URL of the deployed API).

### Tool `search_catalog`
- **Description (for the agent):** "Search the team's internal catalog of existing services, libraries, tools and features. Call this BEFORE implementing new functionality to check whether something reusable already exists."
- **Input:** `{ query: string, type?: "SERVICE" | "TOOL" | "FEATURE" | "LIBRARY" }`
- **Output:** compact text list (max 10): `id`, `name`, `type`, `status`, one-line description, `owner`.

### Tool `get_item`
- **Description (for the agent):** "Get full details of a catalog item, including repository, install instructions and usage example."
- **Input:** `{ id: number }`
- **Output:** all item fields as readable text.

### Behavior
- `DEPRECATED` items are flagged explicitly in both tools' output so the agent does not recommend them silently.
- HTTP timeout 15 s (Railway services do not sleep by default).
- API errors are returned as tool errors (`isError: true`) with a clear message; the server never crashes on a failed request.

### Registration (Claude Code)
```bash
claude mcp add catalog -e CATALOG_API_URL=https://<app>.up.railway.app -- node mcp/server.js
```

## 8. UI

Single page with:
1. **Search bar** + type filter; results update on input (debounced ~300 ms).
2. **Results list** as cards: name, type badge, status (deprecated visibly marked), description, owner, links, tags.
3. **Card detail** (expand): install and usage example in a monospace block.
4. **Empty state:** "No results — add it below."
5. **Create form:** fields from the data model; on success the list refreshes and the form resets; on error the API message is shown.

User-provided content is rendered as text (no `innerHTML` with raw data).

**UI language:** all user-facing copy is in neutral Spanish (e.g. "Catálogo del equipo", "Agregar ítem", "Buscar por nombre, etiqueta o responsable", type labels Servicio / Librería / Herramienta / Funcionalidad, badges "deprecado" and "listo para agentes"). Code, identifiers, API fields, and enum values stay in English.

**Look and feel:** clean, flat, card-based layout; color-coded type badges; "listo para agentes" badge when an item has `install` and `usageExample`; deprecated items dimmed and struck through; light and dark mode support.

## 9. Seed data

`seed.sql` with 10–15 real items (no sensitive data) collected from recurring chat questions. At least 3 items include `install` and `usageExample` for the demo. Run once against Railway Postgres after the first deploy (Railway database query tab or `psql "$DATABASE_PUBLIC_URL" -f seed.sql` from a local machine).

## 10. Acceptance criteria

### Web / API
- [ ] Opening the deployed URL shows the catalog with seed items.
- [ ] Searching a term present in a tag returns that item.
- [ ] Filtering by type shows only items of that type.
- [ ] Creating a valid item shows it in the list immediately and it persists after reload.
- [ ] Submitting without `name` shows a validation error and creates nothing.
- [ ] Data survives a Railway redeploy (stored in Postgres, not on the service filesystem).

### Agent (MCP)
- [ ] `claude mcp list` shows `catalog` as connected.
- [ ] Asking Claude Code "I need to integrate with <seeded item>" makes the agent call `search_catalog` and answer with the item's name, owner, and repo.
- [ ] Asking for details makes the agent call `get_item` and return install + usage example.
- [ ] An item created from the web UI is found by the agent without restarting anything.
- [ ] With the API unreachable, the tool returns an error message and the MCP server keeps running.

## 11. Demo script

1. Show the web catalog and search for an item.
2. Add a new item from the form.
3. In Claude Code (in a folder without that project cloned): "I need to <task the new item solves>".
4. The agent finds the item via MCP and explains how to use it.

## 12. Project structure

```
ai-day-flock-challenge/
├── server.js          # Express app: routes, validation, static files
├── db.js              # pg Pool + schema bootstrap
├── mcp/server.js      # MCP stdio server (adapter over REST API)
├── seed.sql
├── public/index.html
├── package.json       # "start": "node server.js"
├── README.md          # run, deploy, register MCP
└── SPEC.md
```

## 13. Known constraints

- Railway trial: one-time US$5 credit for 30 days; app + Postgres running continuously consume it. Keeping it online afterwards requires the Hobby plan or moving the database (e.g. Neon). Keep "App Sleeping" disabled for the demo.
- Link and API are public: do not store secrets, credentials, internal hostnames, or client-confidential information.
- The app must listen on `process.env.PORT`.

## 14. Future evolution (post-MVP)

1. Hosted MCP server (streamable HTTP) with auth, so no local setup is needed.
2. Semantic search with embeddings in `pgvector`.
3. Ingestion: an LLM drafts items from repository READMEs; a human approves them.
4. Freshness: reminders to owners when `last_reviewed_at` is older than 90 days.
5. Corporate SSO and ownership by team.
