interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
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

// Decode HTML/XML entities incl. numeric (&#167;) and hex (&#xA7;) forms — eCFR
// XML encodes the section symbol as &#xA7; and uses many typographic entities,
// which the old named-only replacements left raw (headings read "&#xA7; 120.1").
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(s: unknown): string {
  if (typeof s !== 'string') return '';
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Convert an eCFR content XML fragment to readable text: drop the heading
// (returned separately), turn block-element closers into line breaks, strip the
// remaining tags, and decode entities — preserving paragraph structure (which
// stripHtml's whitespace-collapse would destroy).
function xmlToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<HEAD>[\s\S]*?<\/HEAD>/g, '')
      .replace(/<\/(P|FP|HEAD|DIV\d+)>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// eCFR's /full/ (and occasionally /structure/) endpoints intermittently return
// 503 "Service Unavailable" under load — a plain fetch made get_section_text
// fail roughly half the time. Retry 503s with backoff; 200/404/other return
// immediately for the caller to handle.
// One eCFR request with a hard per-attempt timeout so a slow/hung /full/ call
// can't run the gateway Worker out of wall-clock (which returns an empty, useless
// response). A timeout is treated like a 503 → retried.
async function ecfrOnce(path: string, accept: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, { headers: { Accept: accept, 'User-Agent': UA }, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ecfrFetch(path: string, accept: string, retries = 3): Promise<Response> {
  let res: Response | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      res = await ecfrOnce(path, accept, 8000);
      if (res.status !== 503) return res;
    } catch {
      // aborted (timeout) or network error — fall through to retry
      res = null;
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  if (res) return res;
  // All attempts timed out — surface a real error, never an empty hang.
  throw new Error('eCFR temporarily unavailable (the /full/ endpoint is timing out — retry in a few seconds).');
}

async function ecfrGet(path: string): Promise<Record<string, unknown>> {
  const res = await ecfrFetch(path, 'application/json');
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
  {
    name: 'get_section_text',
    description:
      'Get the actual REGULATION TEXT currently in force — a single CFR section OR a whole CFR part. PREFER for "what does 14 CFR 91.113 say", "read the text of <citation>", "the exact wording of <regulation>", "text of 22 CFR part 120", "40 CFR part 261". Pass the title number plus EITHER a section (e.g. title 14, section "91.113" → that section) OR a part (e.g. title 22, part "120" → every section in the part). Returns the heading(s) and full paragraph text. Use search_regulations first to find the citation if unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'number',
          description: 'CFR title number, 1–50 (e.g. 14 = Aeronautics and Space, 29 = Labor, 22 = Foreign Relations).',
        },
        section: {
          type: 'string',
          description: 'A single section number including the part, e.g. "91.113", "1910.132", "744.11" (the part is the number before the dot). Returns just that section.',
        },
        part: {
          type: 'string',
          description: 'A part number, e.g. "120", "261". Returns the text of every section in that part. Ignored if `section` is given.',
        },
        date: {
          type: 'string',
          description: "Optional point-in-time date, YYYY-MM-DD. If omitted, the title's current 'up_to_date_as_of' date is used.",
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
      case 'get_section_text':
        return getSectionText(args);
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

async function getSectionText(args: Record<string, unknown>): Promise<unknown> {
  const title = Number(args.title);
  if (!Number.isInteger(title) || title < 1 || title > 50) {
    return { error: 'provide a title number 1–50', title: args.title ?? null };
  }
  const section = args.section != null ? String(args.section).replace(/^§\s*/, '').trim() : '';
  const part = args.part != null ? String(args.part).replace(/^part\s*/i, '').trim() : '';
  if (!section && !part) {
    return { error: 'provide a section number (e.g. "91.113") or a part number (e.g. "120")', title };
  }

  let date = typeof args.date === 'string' ? args.date.trim() : '';
  if (!date) {
    const titlesData = await ecfrGet('/versioner/v1/titles.json');
    const titles = Array.isArray(titlesData.titles)
      ? (titlesData.titles as Array<Record<string, unknown>>)
      : [];
    const match = titles.find((t) => Number(t.number) === title);
    date =
      match && typeof match.up_to_date_as_of === 'string' && match.up_to_date_as_of
        ? match.up_to_date_as_of
        : new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  }

  const params = new URLSearchParams();
  if (section) {
    params.set('part', section.split('.')[0]);
    params.set('section', section);
  } else {
    params.set('part', part);
  }
  const res = await ecfrFetch(`/versioner/v1/full/${date}/title-${title}.xml?${params.toString()}`, 'application/xml');
  if (res.status === 404) {
    return {
      error: `${section ? `Section ${section}` : `Part ${part}`} not found in title ${title} as of ${date}. Check the number (use search_regulations to find the citation).`,
      title,
      section: section || null,
      part: part || null,
      date,
    };
  }
  if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const xml = await res.text();

  // Single section: one heading + its text (original behavior).
  if (section) {
    const headMatch = xml.match(/<HEAD>([\s\S]*?)<\/HEAD>/);
    const heading = headMatch ? stripHtml(headMatch[1]) : null;
    const full = xmlToText(xml);
    const CAP = 30000;
    const truncated = full.length > CAP;
    return {
      title,
      section,
      part: section.split('.')[0],
      date,
      citation: `${title} CFR ${section}`,
      heading,
      url: `https://www.ecfr.gov/current/title-${title}/section-${section}`,
      truncated,
      text: truncated ? full.slice(0, CAP) : full,
    };
  }

  // Whole part: split into its sections (each <DIV8 …N="…">) so the agent gets a
  // navigable per-section breakdown rather than one undifferentiated blob.
  const blocks = xml.split(/<DIV8\b/).slice(1);
  let budget = 60000;
  const sections = blocks
    .map((raw) => {
      const n = raw.match(/\bN="([^"]+)"/)?.[1] ?? null;
      const headMatch = raw.match(/<HEAD>([\s\S]*?)<\/HEAD>/);
      return { section: n, heading: headMatch ? stripHtml(headMatch[1]) : null, text: xmlToText(`<DIV8${raw}`) };
    })
    .filter((s) => s.text || s.heading);
  const kept: typeof sections = [];
  for (const s of sections) {
    if (budget <= 0) break;
    const text = s.text.length > budget ? `${s.text.slice(0, budget)}…` : s.text;
    budget -= text.length;
    kept.push({ ...s, text });
  }
  return {
    title,
    part,
    date,
    citation: `${title} CFR Part ${part}`,
    url: `https://www.ecfr.gov/current/title-${title}/part-${part}`,
    section_count: sections.length,
    returned: kept.length,
    truncated: kept.length < sections.length,
    sections: kept,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
