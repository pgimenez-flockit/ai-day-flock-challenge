---
name: catalog-item
description: Draft a catalog-info.yaml for the current repository so it can be ingested into the team's internal catalog. Use when the developer says "/catalog-item", "catalog-info.yaml", "catalogar repo", "catalogar este repositorio", "add this repo to the catalog" or asks to describe a repo for the catalog.
---

# catalog-item

Draft `catalog-info.yaml` at the repository root so the catalog ingestor can list this repo. A human reviews every draft; you never publish it.

## Steps

1. Read the repository: `README*`, the manifest (`package.json`, `pom.xml` or `build.gradle*`) and the main entry points (exported API, controllers/routes, CLI entry, `main`). If a `catalog-info.yaml` already exists, read it and propose an update instead of a rewrite.
2. Decide `type`: `SERVICE` (runs and exposes an API/events), `LIBRARY` (imported as a dependency), `TOOL` (CLI/script/utility people run), `FEATURE` (a reusable functionality or module that is neither of the above).
3. Draft the file using the template below and ONLY the keys listed in it.
4. Show the full draft to the developer and wait for explicit approval or edits. Do not write the file before that.
5. After approval, write `catalog-info.yaml` at the repository root. Do NOT run `git add`, `git commit` or `git push`; tell the developer to review it in a pull request.

## Rules

- Allowed keys: `apiVersion`, `name`, `type`, `description`, `owner`, `status`, `docsUrl`, `install`, `usageExample`, `tags`. Unknown keys are rejected by the ingestor. Never add `repoUrl` (it comes from the repository).
- `apiVersion` is always `catalog/v1`.
- `description` (max 1000 chars): write it in Spanish, explaining what it does and when to use it, so someone can decide not to rebuild it. No marketing language.
- `usageExample` (max 2000 chars): a short, real snippet taken from the README or the code. Never invent APIs, function names or parameters. If no reliable example exists, omit the key.
- `install` (max 500 chars): the real command or dependency coordinates (npm, Maven, Gradle, `git clone ...`). Omit it if unknown.
- `owner`: use CODEOWNERS or README if evident; otherwise ask the developer. Do not guess.
- `status`: omit unless the repo is clearly deprecated (`DEPRECATED`); archived repos are marked automatically.
- `tags`: up to 20 short lowercase words (domain, technology, business concept).
- NEVER include secrets, credentials, tokens, internal hostnames, IP addresses, internal URLs or client-confidential data, even if they appear in the code or README. Leave them out and tell the developer you omitted them.
- Only keep `docsUrl` if it is a documentation link you saw in the repo and it is safe to expose.
- The catalog may be public: write nothing you would not put on a public page.

## Template

```yaml
apiVersion: catalog/v1
name: Validador de CUIT
type: LIBRARY              # SERVICE | TOOL | FEATURE | LIBRARY
description: >
  Valida y formatea números de CUIT/CUIL. Usarlo en lugar de reimplementar
  el dígito verificador en cada aplicación.
owner: Equipo Backend
status: ACTIVE             # optional: ACTIVE | DEPRECATED (default ACTIVE)
docsUrl: https://...       # optional
install: npm i @flock/cuit # optional
usageExample: |            # optional
  import { isValidCuit } from '@flock/cuit';
  isValidCuit('20-12345678-9');
tags: [validacion, afip]   # optional
```
