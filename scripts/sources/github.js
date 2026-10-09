// GitHub source adapter for the ingestor. Only this module knows about the GitHub REST API,
// so a GitLab adapter can be added later without touching the ingestor.

const TIMEOUT_MS = 15000;
const CATALOG_FILE = 'catalog-info.yaml';

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

async function request(url) {
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
  if (res.ok || res.status === 404) return res;

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
        archived: Boolean(repo.archived),
      });
    }
    url = nextLink(res);
  }
  return repos;
}

/** Returns the text of catalog-info.yaml in the default branch, or null when the repository has none. */
export async function getCatalogFile(fullName) {
  const [owner, repo] = fullName.split('/');
  const res = await request(
    `${baseUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${CATALOG_FILE}`,
  );
  if (res.status === 404) return null;
  const data = await res.json();
  if (Array.isArray(data) || data.type !== 'file') return null;
  if (data.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new GitHubError(`No se pudo leer ${CATALOG_FILE} (¿supera 1 MB?)`, { fatal: false });
  }
  return Buffer.from(data.content, 'base64').toString('utf8');
}
