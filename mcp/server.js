import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TYPES = ['SERVICE', 'TOOL', 'FEATURE', 'LIBRARY'];
const DEPRECATED_FLAG = '⚠ DEPRECATED — do not use for new work';

class ToolError extends Error {}

async function api(pathAndQuery) {
  const base = (process.env.CATALOG_API_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new ToolError('CATALOG_API_URL is not set. Configure it with the base URL of the catalog API.');
  }
  let res;
  try {
    res = await fetch(`${base}${pathAndQuery}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const reason =
      err?.name === 'TimeoutError' ? 'request timed out after 15s' : err?.cause?.code || err?.message || 'network error';
    throw new ToolError(`Could not reach the catalog API at ${base}: ${reason}`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body
  }
  if (!res.ok) {
    const detail = data?.error ? `: ${data.error}` : '';
    throw new ToolError(`Catalog API responded ${res.status}${detail}`);
  }
  if (data === null) throw new ToolError('Catalog API returned an invalid response');
  return data;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (err) => {
  const message = err instanceof ToolError ? err.message : `Unexpected error: ${err?.message || err}`;
  console.error(message);
  return { isError: true, content: [{ type: 'text', text: message }] };
};

const oneLine = (s, max = 160) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function formatItem(item) {
  const lines = [
    `# ${item.name} (id ${item.id})`,
    item.status === 'DEPRECATED' ? DEPRECATED_FLAG : null,
    `Type: ${item.type}`,
    `Status: ${item.status}`,
    `Owner: ${item.owner}`,
    `Description: ${item.description}`,
    `Repository: ${item.repoUrl || '(none)'}`,
    `Docs: ${item.docsUrl || '(none)'}`,
    `Tags: ${item.tags?.length ? item.tags.join(', ') : '(none)'}`,
    item.source === 'GIT' ? `Source: git (${item.sourceRepo})` : 'Source: manual',
    item.lastSyncedAt ? `Last synced: ${item.lastSyncedAt}` : null,
    `Last reviewed: ${item.lastReviewedAt}`,
    `Created: ${item.createdAt}`,
    '',
    'Install:',
    item.install || '(not provided)',
    '',
    'Usage example:',
    item.usageExample || '(not provided)',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

const server = new McpServer({ name: 'internal-catalog', version: '1.0.0' });

server.registerTool(
  'search_catalog',
  {
    description:
      "Search the team's internal catalog of existing services, libraries, tools and features. Call this BEFORE implementing new functionality to check whether something reusable already exists.",
    inputSchema: {
      query: z.string().describe('Free text: name, tag, owner or keyword'),
      type: z.enum(TYPES).optional().describe('Optional filter by item type'),
    },
  },
  async ({ query, type }) => {
    try {
      const params = new URLSearchParams({ q: query });
      if (type) params.set('type', type);
      const items = await api(`/api/items?${params}`);
      if (!Array.isArray(items) || items.length === 0) {
        return text(`No catalog items found for "${query}".`);
      }
      const shown = items.slice(0, 10);
      const lines = shown.map((i) => {
        const flag = i.status === 'DEPRECATED' ? ` ${DEPRECATED_FLAG}` : '';
        const origin = i.source === 'GIT' ? ' [git]' : '';
        return `- [id ${i.id}] ${i.name}${origin} | ${i.type} | ${i.status} | ${oneLine(i.description)} | owner: ${i.owner}${flag}`;
      });
      const more = items.length > shown.length ? `\n(${items.length - shown.length} more not shown; refine the query)` : '';
      return text(`${shown.length} result(s). Use get_item with the id for full details.\n${lines.join('\n')}${more}`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'get_item',
  {
    description: 'Get full details of a catalog item, including repository, install instructions and usage example.',
    inputSchema: {
      id: z.number().int().describe('Catalog item id'),
    },
  },
  async ({ id }) => {
    try {
      const item = await api(`/api/items/${encodeURIComponent(id)}`);
      return text(formatItem(item));
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error('Catalog MCP server running on stdio');
