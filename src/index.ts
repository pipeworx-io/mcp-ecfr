interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * eCFR (Electronic Code of Federal Regulations) MCP.
 *
 * Keyless full-text search and structure of all 50 titles of the US Code of
 * Federal Regulations — the codified regulations of every federal agency.
 * Backed by the official ecfr.gov API (govinfo / Office of the Federal
 * Register). No key required.
 */


const BASE = 'https://www.ecfr.gov/api';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';
const HEADERS = { Accept: 'application/json', 'User-Agent': UA };

function stripHtml(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function ecfrGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'search_regulations',
    description:
      'Full-text search across all 50 titles of the US Code of Federal Regulations (federal agency regulations) via the official eCFR API. Returns matching sections with citation, heading, and excerpt. e.g. "drone operation", "food labeling", "overtime pay". Optionally restrict to one CFR title number. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search phrase, e.g. "drone operation", "food labeling", "overtime pay", "hazardous waste".',
        },
        title: {
          type: 'number',
          description:
            'Optional CFR title number (1–50) to restrict the search to. Use list_titles to see the title index, e.g. 14 = Aeronautics and Space, 21 = Food and Drugs, 29 = Labor.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10, max 20).',
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default 1).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_titles',
    description:
      'List all 50 titles of the US Code of Federal Regulations (Title 1 General Provisions … Title 50 Wildlife and Fisheries), with currency dates. This is the index for the `title` filter in search_regulations. Keyless.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'title_structure',
    description:
      'Get the top-level structure (chapters/subtitles) of one CFR title — the agencies and major divisions within that title. Returns a summarized one-level view, not the full deep tree. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'number',
          description: 'CFR title number, 1–50 (e.g. 14 = Aeronautics and Space).',
        },
        date: {
          type: 'string',
          description:
            "Optional point-in-time date, YYYY-MM-DD. If omitted, the title's current 'up_to_date_as_of' date is used automatically.",
        },
      },
      required: ['title'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'search_regulations':
        return searchRegulations(args);
      case 'list_titles':
        return listTitles();
      case 'title_structure':
        return titleStructure(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function searchRegulations(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { error: 'provide a query', query: args.query ?? null };

  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
  const page = Math.max(Number(args.page) || 1, 1);

  const params = new URLSearchParams({
    query,
    per_page: String(limit),
    page: String(page),
    order: 'relevance',
  });
  if (args.title !== undefined && args.title !== null && `${args.title}` !== '') {
    // eCFR title filter is the bracket-array param hierarchy[title]={n}.
    params.append('hierarchy[title]', String(args.title));
  }

  const data = await ecfrGet(`/search/v1/results?${params.toString()}`);
  const meta = (data.meta as Record<string, unknown> | undefined) ?? {};
  const rawResults = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];

  const results = rawResults.map((r) => {
    const h = (r.hierarchy as Record<string, unknown> | undefined) ?? {};
    const headings = (r.headings as Record<string, unknown> | undefined) ?? {};
    const hHeadings = (r.hierarchy_headings as Record<string, unknown> | undefined) ?? {};

    const t = h.title != null ? String(h.title) : null;
    const part = h.part != null ? String(h.part) : null;
    const section = h.section != null ? String(h.section) : null;

    // Citation: prefer "{title} CFR {section}" (section already encodes part, e.g. 744.3),
    // else fall back to part-level.
    let citation: string | null = null;
    if (t && section) citation = `${t} CFR ${section}`;
    else if (t && part) citation = `${t} CFR part ${part}`;
    else if (t) citation = `${t} CFR`;

    const heading =
      (typeof headings.section === 'string' && stripHtml(headings.section)) ||
      (typeof hHeadings.section === 'string' && stripHtml(hHeadings.section)) ||
      null;

    // Build a stable current-eCFR URL, deep-linking to the section/part when known.
    let url: string | null = t ? `https://www.ecfr.gov/current/title-${t}` : null;
    if (url && part) {
      url += `/part-${part}`;
      if (section) url += `/section-${section}`;
    }

    return {
      title: t,
      part,
      section,
      heading,
      citation,
      excerpt: stripHtml(r.full_text_excerpt).slice(0, 300),
      date: r.starts_on ?? null,
      type: r.type ?? null,
      score: r.score ?? null,
      url,
    };
  });

  return {
    query,
    title: args.title ?? null,
    total: meta.total_count ?? null,
    count: results.length,
    page,
    results,
  };
}

async function listTitles(): Promise<unknown> {
  const data = await ecfrGet('/versioner/v1/titles.json');
  const list = Array.isArray(data.titles) ? (data.titles as Array<Record<string, unknown>>) : [];
  return {
    count: list.length,
    titles: list.map((t) => ({
      number: t.number,
      name: t.name,
      up_to_date_as_of: t.up_to_date_as_of,
      latest_amended_on: t.latest_amended_on,
      reserved: t.reserved,
    })),
  };
}

async function titleStructure(args: Record<string, unknown>): Promise<unknown> {
  const title = Number(args.title);
  if (!Number.isInteger(title) || title < 1 || title > 50) {
    return { error: 'provide a title number 1–50', title: args.title ?? null };
  }

  let date = typeof args.date === 'string' ? args.date.trim() : '';
  let dateNote: string | undefined;

  if (!date) {
    // Look up the title's currency date from titles.json.
    const titlesData = await ecfrGet('/versioner/v1/titles.json');
    const titles = Array.isArray(titlesData.titles)
      ? (titlesData.titles as Array<Record<string, unknown>>)
      : [];
    const match = titles.find((t) => Number(t.number) === title);
    const upToDate = match && typeof match.up_to_date_as_of === 'string' ? match.up_to_date_as_of : '';
    if (upToDate) {
      date = upToDate;
    } else {
      // Reserved/empty title or null currency date → recent fallback.
      date = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      dateNote = `no up_to_date_as_of for title ${title}; used recent fallback date`;
    }
  }

  const data = await ecfrGet(`/versioner/v1/structure/${date}/title-${title}.json`);
  const children = Array.isArray(data.children) ? (data.children as Array<Record<string, unknown>>) : [];

  return {
    title,
    date,
    ...(dateNote ? { note: dateNote } : {}),
    label: stripHtml(data.label),
    type: data.type ?? null,
    reserved: data.reserved ?? null,
    children_total: children.length,
    note_children:
      'one level shown (chapters/subtitles); each may have its own nested children (subchapters/parts/sections) not expanded here',
    children: children.slice(0, 50).map((c) => ({
      type: c.type ?? null,
      identifier: c.identifier ?? null,
      label: stripHtml(c.label),
      reserved: c.reserved ?? null,
      has_children: Array.isArray(c.children) && c.children.length > 0,
    })),
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
