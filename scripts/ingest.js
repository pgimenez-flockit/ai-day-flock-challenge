// Git ingestor: reads every catalog-info.yaml (root and nested) from the repositories of GITHUB_OWNER
// and upserts them as GIT items.
// Usage: npm run ingest [-- --dry-run]
// Env:   DATABASE_URL, GITHUB_OWNER (required); GITHUB_TOKEN, GITHUB_API_URL (optional).
import YAML from 'yaml';
import { pool, initSchema } from '../db.js';
import { ValidationError, validateItem } from '../lib/validation.js';
import { GitHubError, listRepos, getCatalogFiles, directoryUrl } from './sources/github.js';

const API_VERSION = 'catalog/v1';
const ALLOWED_KEYS = [
  'apiVersion', 'name', 'type', 'description', 'owner', 'status', 'docsUrl', 'install', 'usageExample', 'tags', 'stack',
];

const dryRun = process.argv.includes('--dry-run');
const owner = (process.env.GITHUB_OWNER || '').trim();

function fatal(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

/** Parses and validates one catalog-info.yaml. Returns the validated item or throws ValidationError. */
function parseManifest(text) {
  let doc;
  try {
    doc = YAML.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new ValidationError(`YAML inválido: ${String(err.message).split('\n')[0]}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ValidationError('El archivo debe ser un objeto YAML con los campos del ítem');
  }
  if (doc.apiVersion !== API_VERSION) {
    throw new ValidationError(`apiVersion debe ser ${API_VERSION}`);
  }
  for (const key of Object.keys(doc)) {
    if (key === 'repoUrl') throw new ValidationError('repoUrl no se define en el YAML: se toma del repositorio');
    if (!ALLOWED_KEYS.includes(key)) {
      throw new ValidationError(`Campo desconocido "${key}" (permitidos: ${ALLOWED_KEYS.join(', ')})`);
    }
  }
  return validateItem(doc);
}

// Used only by --dry-run to classify updated vs unchanged (the real run lets Postgres decide).
const CONTENT_FIELDS = ['name', 'type', 'description', 'owner', 'status', 'repo_url', 'docs_url', 'install', 'usage_example'];
const canonicalStack = (stack) => JSON.stringify(stack ? Object.fromEntries(Object.entries(stack).sort()) : null);
function sameContent(row, item) {
  const mapped = {
    name: item.name, type: item.type, description: item.description, owner: item.owner, status: item.status,
    repo_url: item.repoUrl, docs_url: item.docsUrl, install: item.install, usage_example: item.usageExample,
  };
  return CONTENT_FIELDS.every((f) => row[f] === mapped[f])
    && JSON.stringify(row.tags) === JSON.stringify(item.tags)
    && canonicalStack(row.stack) === canonicalStack(item.stack);
}

async function loadExistingGitItems() {
  try {
    const { rows } = await pool.query(`SELECT * FROM items WHERE source = 'GIT'`);
    return rows;
  } catch (err) {
    // Dry run against a database that has not been migrated yet: nothing exists, nothing to compare.
    if (dryRun && (err.code === '42P01' || err.code === '42703')) return [];
    throw err;
  }
}

// now() is fixed per statement, so `last_reviewed_at = now()` in RETURNING is true only when the row
// was just inserted or its content changed; that is how created / updated / unchanged are told apart.
async function upsert(sourceKey, item) {
  const { rows } = await pool.query(
    `INSERT INTO items (name, type, description, owner, status, repo_url, docs_url, install, usage_example, tags,
                        stack, source, source_repo, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'GIT', $12, now())
     ON CONFLICT (source_repo) DO UPDATE SET
       name = EXCLUDED.name, type = EXCLUDED.type, description = EXCLUDED.description, owner = EXCLUDED.owner,
       status = EXCLUDED.status, repo_url = EXCLUDED.repo_url, docs_url = EXCLUDED.docs_url,
       install = EXCLUDED.install, usage_example = EXCLUDED.usage_example, tags = EXCLUDED.tags,
       stack = EXCLUDED.stack,
       last_synced_at = now(),
       last_reviewed_at = CASE
         WHEN (items.name, items.type, items.description, items.owner, items.status, items.repo_url,
               items.docs_url, items.install, items.usage_example, items.tags, items.stack)
              IS DISTINCT FROM
              (EXCLUDED.name, EXCLUDED.type, EXCLUDED.description, EXCLUDED.owner, EXCLUDED.status,
               EXCLUDED.repo_url, EXCLUDED.docs_url, EXCLUDED.install, EXCLUDED.usage_example, EXCLUDED.tags,
               EXCLUDED.stack)
         THEN now() ELSE items.last_reviewed_at END
     RETURNING (xmax = 0) AS inserted, (last_reviewed_at = now()) AS changed`,
    [item.name, item.type, item.description, item.owner, item.status, item.repoUrl, item.docsUrl, item.install,
      item.usageExample, item.tags, item.stack ? JSON.stringify(item.stack) : null, sourceKey],
  );
  return rows[0];
}

function printReport(r) {
  const list = (title, entries, fmt) => {
    console.log(`\n${title} (${entries.length})`);
    for (const e of entries) console.log(`  - ${fmt(e)}`);
  };
  console.log(`\n=== Resumen de ingesta${dryRun ? ' (simulacro: no se escribió nada)' : ''} ===`);
  console.log(`Repositorios revisados: ${r.total}`);
  console.log(`Archivos catalog-info.yaml encontrados: ${r.files}`);
  console.log(`${dryRun ? 'Se crearían' : 'Creados'}: ${r.created.length}`);
  console.log(`${dryRun ? 'Se actualizarían' : 'Actualizados'}: ${r.updated.length}`);
  console.log(`Sin cambios: ${r.unchanged.length}`);
  console.log(`Inválidos: ${r.invalid.length}`);
  console.log(`Sin catalogar: ${r.uncataloged.length}`);
  console.log(`Huérfanos: ${r.orphaned.length}`);
  if (r.created.length) list(dryRun ? 'Se crearían' : 'Creados', r.created, (x) => x);
  if (r.updated.length) list(dryRun ? 'Se actualizarían' : 'Actualizados', r.updated, (x) => x);
  if (r.invalid.length) list('Inválidos (no se escribió nada)', r.invalid, (x) => `${x.repo}: ${x.reason}`);
  if (r.uncataloged.length) list('Sin catalogar (falta catalog-info.yaml)', r.uncataloged, (x) => x);
  if (r.partial.length) list('Lectura parcial (puede faltar algún catalog-info.yaml)', r.partial, (x) => `${x.repo}: ${x.reason}`);
  if (r.orphaned.length) {
    list('Huérfanos (en el catálogo, sin YAML válido en esta corrida; no se eliminan)', r.orphaned, (x) => x);
  }
}

async function main() {
  if (!owner) {
    return fatal('Falta GITHUB_OWNER (usuario u organización de GitHub a ingerir). Ejemplo: GITHUB_OWNER=mi-org npm run ingest');
  }
  if (!process.env.DATABASE_URL) return fatal('Falta DATABASE_URL.');

  // A dry run must not write anything, not even the schema.
  if (!dryRun) await initSchema();
  const auth = process.env.GITHUB_TOKEN ? 'con token' : 'sin token: solo repositorios públicos';
  console.log(`Ingestando repositorios de "${owner}" (${auth})${dryRun ? ' [simulacro]' : ''}...`);

  const existing = await loadExistingGitItems();
  const existingByRepo = new Map(existing.map((row) => [row.source_repo.toLowerCase(), row]));

  const repos = await listRepos(owner);
  const report = {
    total: repos.length, files: 0, created: [], updated: [], unchanged: [], invalid: [], uncataloged: [], partial: [], orphaned: [],
  };
  const valid = new Set();

  for (const repo of repos) {
    let found;
    try {
      found = await getCatalogFiles(repo);
    } catch (err) {
      if (err instanceof GitHubError && !err.fatal) {
        report.invalid.push({ repo: repo.fullName, reason: err.message });
        continue;
      }
      throw err;
    }
    if (found.truncated) report.partial.push({ repo: repo.fullName, reason: found.truncated });
    if (found.files.length === 0) {
      report.uncataloged.push(repo.fullName);
      continue;
    }

    for (const file of found.files) {
      report.files += 1;
      // Identity of the item: "owner/repo" for the root file, "owner/repo:dir" for nested ones.
      const key = file.dir ? `${repo.fullName}:${file.dir}` : repo.fullName;
      if (file.error) {
        report.invalid.push({ repo: key, reason: file.error });
        continue;
      }

      let item;
      try {
        item = parseManifest(file.text);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        report.invalid.push({ repo: key, reason: err.message });
        continue;
      }
      item.repoUrl = directoryUrl(repo, file.dir);
      if (repo.archived) item.status = 'DEPRECATED';
      valid.add(key.toLowerCase());

      if (dryRun) {
        const row = existingByRepo.get(key.toLowerCase());
        if (!row) report.created.push(key);
        else if (sameContent(row, item)) report.unchanged.push(key);
        else report.updated.push(key);
      } else {
        const result = await upsert(key, item);
        if (result.inserted) report.created.push(key);
        else if (result.changed) report.updated.push(key);
        else report.unchanged.push(key);
      }
    }
  }

  const prefix = `${owner.toLowerCase()}/`;
  for (const [key, row] of existingByRepo) {
    if (key.startsWith(prefix) && !valid.has(key)) report.orphaned.push(row.source_repo);
  }

  printReport(report);
}

try {
  await main();
} catch (err) {
  if (err instanceof GitHubError) fatal(err.message);
  else if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(err?.code)) {
    fatal(`No se pudo conectar con la base de datos (${err.code}).`);
  } else fatal(err?.message || String(err));
} finally {
  await pool.end();
}
