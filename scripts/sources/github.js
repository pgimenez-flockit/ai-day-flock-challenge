// GitHub source adapter for the ingestor. Only this module knows about the GitHub REST API,
// so a GitLab adapter can be added later without touching the ingestor.

const TIMEOUT_MS = 15000;
const CATALOG_FILE = 'catalog-info.yaml';
const MAX_FILES_PER_REPO = 100;
// Vendored / generated folders may contain copies of catalog files that do not describe this repository.
const IGNORED_DIRS = /(^|\/)(node_modules|dist)\//;

// fatal = the whole run cannot continue (auth, rate limit, network); otherwise it only affects one repository.
export class GitHubError extends Error {
  constructor(message, { fatal = true } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.fatal = fatal;
  }
}

function baseUrl() {
  return (process.env.GITHUB_API_URL || 'https://api.github.com').trim().replace(/\/+$/, '');
}

async function request(url, { tolerate = [] } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'internal-catalog-ingestor',
  };
  const token = (process.env.GITHUB_TOKEN || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const reason =
      err?.name === 'TimeoutError' ? `sin respuesta tras ${TIMEOUT_MS / 1000} s` : err?.cause?.code || err?.message || 'error de red';
    throw new GitHubError(`No se pudo conectar con GitHub (${baseUrl()}): ${reason}`);
  }
  if (res.ok || res.status === 404 || tolerate.includes(res.status)) return res;

  if (res.status === 401) {
    throw new GitHubError('GitHub rechazó las credenciales (401). Revisa que GITHUB_TOKEN sea válido y no haya vencido.');
  }
  if (res.status === 403 || res.status === 429) {
    const rateLimited = res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429;
    const hint = rateLimited
      ? ' Se alcanzó el límite de solicitudes de GitHub; espera un rato o usa GITHUB_TOKEN para ampliarlo.'
      : ' Revisa que el token tenga permisos de lectura (Contents y Metadata).';
    throw new GitHubError(`GitHub denegó el acceso (${res.status}).${hint}`);
  }
  throw new GitHubError(`GitHub respondió ${res.status} para ${new URL(url).pathname}`, { fatal: false });
}

function nextLink(res) {
  const match = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '');
  return match ? match[1] : null;
}

/** Lists the non-fork repositories of `owner` (including archived ones), following pagination. */
export async function listRepos(owner) {
  const authenticated = Boolean((process.env.GITHUB_TOKEN || '').trim());
  let url = authenticated
    ? `${baseUrl()}/user/repos?affiliation=owner,organization_member,collaborator&per_page=100`
    : `${baseUrl()}/users/${encodeURIComponent(owner)}/repos?type=owner&per_page=100`;

  const repos = [];
  while (url) {
    const res = await request(url);
    if (res.status === 404) throw new GitHubError(`No se encontró el usuario u organización "${owner}" en GitHub.`);
    const page = await res.json();
    if (!Array.isArray(page)) throw new GitHubError('Respuesta inesperada de GitHub al listar repositorios');
    for (const repo of page) {
      if (repo.fork) continue;
      // The authenticated listing returns everything the token can see; keep only the requested owner.
      if (authenticated && repo.owner?.login?.toLowerCase() !== owner.toLowerCase()) continue;
      repos.push({
        fullName: repo.full_name,
        name: repo.name,
        htmlUrl: repo.html_url,
        defaultBranch: repo.default_branch || null,
        archived: Boolean(repo.archived),
      });
    }
    url = nextLink(res);
  }
  return repos;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** Reads one file through the contents API. Returns its text, or null when it does not exist. */
async function getFile(owner, repo, path) {
  const res = await request(
    `${baseUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`,
  );
  if (res.status === 404) return null;
  const data = await res.json();
  if (Array.isArray(data) || data.type !== 'file') return null;
  if (data.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new GitHubError(`No se pudo leer ${path} (¿supera 1 MB?)`, { fatal: false });
  }
  return Buffer.from(data.content, 'base64').toString('utf8');
}

/** Directory of a catalog file path: '' for the repository root, 'a/b' for 'a/b/catalog-info.yaml'. */
const dirOf = (path) => path.slice(0, path.length - CATALOG_FILE.length).replace(/\/$/, '');

/** URL of a directory in the default branch of a repository (the repository URL itself for the root). */
export function directoryUrl(repo, dir) {
  if (!dir) return repo.htmlUrl;
  return `${repo.htmlUrl}/tree/${encodePath(repo.defaultBranch)}/${encodePath(dir)}`;
}

/**
 * Finds every catalog-info.yaml in the default branch (root and nested, e.g. monorepos) and reads them.
 * Returns { files: [{ dir, text } | { dir, error }], truncated: string | null }; `files` is empty when the
 * repository has none (an empty repository counts as having none). `error` marks a file that could not be read.
 */
export async function getCatalogFiles(repo) {
  const [owner, name] = repo.fullName.split('/');
  if (!repo.defaultBranch) return { files: [], truncated: null };

  const res = await request(
    `${baseUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(repo.defaultBranch)}?recursive=1`,
    { tolerate: [404, 409] },
  );
  // 409 = empty repository, 404 = default branch without commits.
  if (res.status === 404 || res.status === 409) return { files: [], truncated: null };
  const tree = await res.json();
  if (!Array.isArray(tree.tree)) throw new GitHubError('Respuesta inesperada de GitHub al leer el árbol del repositorio', { fatal: false });

  let truncated = tree.truncated ? 'GitHub devolvió el árbol del repositorio incompleto' : null;
  let paths = tree.tree
    .filter((e) => e.type === 'blob' && (e.path === CATALOG_FILE || e.path.endsWith(`/${CATALOG_FILE}`)))
    .map((e) => e.path)
    .filter((p) => !IGNORED_DIRS.test(p))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (paths.length > MAX_FILES_PER_REPO) {
    truncated = `se leyeron solo ${MAX_FILES_PER_REPO} de ${paths.length} archivos ${CATALOG_FILE}`;
    paths = paths.slice(0, MAX_FILES_PER_REPO);
  }

  const files = [];
  for (const path of paths) {
    const dir = dirOf(path);
    try {
      const text = await getFile(owner, name, path);
      if (text !== null) files.push({ dir, text });
    } catch (err) {
      if (err instanceof GitHubError && !err.fatal) files.push({ dir, error: err.message });
      else throw err;
    }
  }
  return { files, truncated };
}
