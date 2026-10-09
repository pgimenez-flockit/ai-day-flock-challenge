import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, initSchema } from './db.js';
import { TYPES, STATUSES, SOURCES, ValidationError, validateItem, validateStackValue } from './lib/validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COLUMNS = `id, name, type, description, owner, status, repo_url, docs_url, install,
  usage_example, tags, stack, source, source_repo, last_synced_at, last_reviewed_at, created_at`;

function toItem(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    owner: row.owner,
    status: row.status,
    repoUrl: row.repo_url,
    docsUrl: row.docs_url,
    install: row.install,
    usageExample: row.usage_example,
    tags: row.tags,
    stack: row.stack,
    source: row.source,
    sourceRepo: row.source_repo,
    lastSyncedAt: row.last_synced_at,
    lastReviewedAt: row.last_reviewed_at,
    createdAt: row.created_at,
  };
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/items', async (req, res, next) => {
  try {
    const { q, type, status, source, language, languageVersion, framework } = req.query;
    const stackFilters = { language, languageVersion, framework };
    for (const v of [q, type, status, source, language, languageVersion, framework]) {
      if (v !== undefined && typeof v !== 'string') {
        return res.status(400).json({ error: 'Parámetros de búsqueda inválidos' });
      }
    }
    if (type && !TYPES.includes(type)) return res.status(400).json({ error: 'Tipo inválido' });
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Estado inválido' });
    if (source && !SOURCES.includes(source)) return res.status(400).json({ error: 'Origen inválido' });

    for (const [key, value] of Object.entries(stackFilters)) {
      if (value) validateStackValue(key, value);
    }

    const where = [];
    const params = [];
    if (q && q.trim()) {
      params.push(`%${escapeLike(q.trim())}%`);
      const p = `$${params.length}`;
      where.push(`(name ILIKE ${p} OR description ILIKE ${p} OR owner ILIKE ${p}
        OR concat_ws(' ', stack->>'language', stack->>'languageVersion', stack->>'framework',
                          stack->>'frameworkVersion') ILIKE ${p}
        OR EXISTS (SELECT 1 FROM unnest(tags) AS t WHERE t ILIKE ${p}))`);
    }
    if (type) {
      params.push(type);
      where.push(`type = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (source) {
      params.push(source);
      where.push(`source = $${params.length}`);
    }
    for (const [key, value] of Object.entries(stackFilters)) {
      if (!value) continue;
      params.push(value);
      // key comes from the fixed object above, never from user input.
      where.push(`stack->>'${key}' = $${params.length}`);
    }
    const sql = `SELECT ${COLUMNS} FROM items${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY name ASC LIMIT 50`;
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(toItem));
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

app.get('/api/items/:id', async (req, res, next) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(400).json({ error: 'Identificador inválido' });
    const { rows } = await pool.query(`SELECT ${COLUMNS} FROM items WHERE id = $1`, [Number(req.params.id)]);
    if (rows.length === 0) return res.status(404).json({ error: 'Ítem no encontrado' });
    res.json(toItem(rows[0]));
  } catch (err) {
    next(err);
  }
});

app.post('/api/items', async (req, res, next) => {
  try {
    // validateItem ignores source/sourceRepo: API-created items are always MANUAL (column default).
    const v = validateItem(req.body);
    const { rows } = await pool.query(
      `INSERT INTO items (name, type, description, owner, status, repo_url, docs_url, install, usage_example, tags, stack)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING ${COLUMNS}`,
      [v.name, v.type, v.description, v.owner, v.status, v.repoUrl, v.docsUrl, v.install, v.usageExample, v.tags,
        v.stack ? JSON.stringify(v.stack) : null],
    );
    res.status(201).json(toItem(rows[0]));
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Recurso no encontrado' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err.type === 'entity.too.large') return res.status(400).json({ error: 'Solicitud demasiado grande' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal error' });
});

const port = Number(process.env.PORT) || 3000;

try {
  await initSchema();
} catch (err) {
  console.error('Failed to initialize schema:', err);
  process.exit(1);
}
app.listen(port, '0.0.0.0', () => console.log(`Catalog listening on port ${port}`));
