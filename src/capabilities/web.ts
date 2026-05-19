// Web capabilities — search + scrape + chunked read, ported from autonomous-company-v2's
// MCP tools (firecrawl-scrape.ts, web-search.ts, fetch-chunk.ts).
//
// The chunking pattern is the load-bearing detail: large fetched pages would blow the
// agent's context if returned whole. firecrawl_scrape stores the full markdown in a
// WebCache (in-process map, scoped to one Cycle / one lattice). fetch_chunk reads
// slices on demand, so the agent can incrementally consume a 50KB article over multiple
// cycles without ever holding more than ~4KB in any single turn.
//
// API key priority (matches V2's operator-decided order from 2026-05-08):
//   1. FIRECRAWL_API_KEY → Firecrawl /v1/search (default)
//   2. WEB_SEARCH_API_KEY → Brave Search (fallback when Firecrawl errors)
//   3. neither → returns clear unconfigured error

import type { Capability } from '../types.js';

export interface WebCacheEntry {
  url: string;
  markdown: string;
  fetchedAt: number;
}

/** Per-lattice in-process cache. firecrawl_scrape writes, fetch_chunk reads. */
export class WebCache {
  private readonly store = new Map<string, WebCacheEntry>();
  set(url: string, markdown: string): void { this.store.set(url, { url, markdown, fetchedAt: Date.now() }); }
  get(url: string): WebCacheEntry | undefined { return this.store.get(url); }
  size(): number { return this.store.size; }
  urls(): string[] { return [...this.store.keys()]; }
}

export interface WebKeys {
  firecrawlApiKey?: string;
  braveApiKey?: string;
}

interface BraveResult { title?: string; url?: string; description?: string; }
interface FirecrawlSearchResult { title?: string; url?: string; description?: string; markdown?: string; }

async function searchBrave(apiKey: string, query: string, limit: number): Promise<{ results: Array<{ title: string; url: string; snippet: string }> } | { error: string }> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const res = await fetch(url, { headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' } });
  if (!res.ok) return { error: `brave ${res.status}: ${res.statusText}` };
  const data = (await res.json()) as { web?: { results?: BraveResult[] } };
  const results = (data.web?.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? '', url: r.url ?? '', snippet: r.description ?? '',
  }));
  return { results };
}

async function searchFirecrawl(apiKey: string, query: string, limit: number): Promise<{ results: Array<{ title: string; url: string; snippet: string }> } | { error: string }> {
  const res = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { error: `firecrawl ${res.status}: ${res.statusText} — ${body.slice(0, 200)}` };
  }
  const data = (await res.json()) as { data?: FirecrawlSearchResult[] };
  const results = (data.data ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? '', url: r.url ?? '', snippet: r.description ?? r.markdown?.slice(0, 200) ?? '',
  }));
  return { results };
}

/** Build the three web capabilities (web_search / firecrawl_scrape / fetch_chunk).
 *  Each lattice gets its own WebCache so scrapes don't leak between agents. */
export function createWebCapabilities(keys: WebKeys = {}): Capability[] {
  const cache = new WebCache();
  const firecrawlKey = keys.firecrawlApiKey ?? process.env['FIRECRAWL_API_KEY'] ?? '';
  const braveKey = keys.braveApiKey ?? process.env['WEB_SEARCH_API_KEY'] ?? '';

  const webSearch: Capability = {
    name: 'web_search',
    description: 'Search the web. args: {"query": string, "limit"?: 1-20 default 10}. Returns title + url + snippet for top results. Use this to find sources, then firecrawl_scrape to read one.',
    handler: async (args) => {
      const query = typeof args['query'] === 'string' ? args['query'] : '';
      const limit = typeof args['limit'] === 'number' ? Math.min(20, Math.max(1, args['limit'])) : 10;
      if (!query) return JSON.stringify({ error: 'query required' });
      if (!firecrawlKey && !braveKey) return JSON.stringify({ error: 'web_search_unconfigured', hint: 'Set FIRECRAWL_API_KEY (default) or WEB_SEARCH_API_KEY (Brave fallback)' });
      try {
        if (firecrawlKey) {
          const primary = await searchFirecrawl(firecrawlKey, query, limit);
          if (!('error' in primary)) return JSON.stringify({ provider: 'firecrawl', query, results: primary.results });
          if (braveKey) {
            const fb = await searchBrave(braveKey, query, limit);
            if (!('error' in fb)) return JSON.stringify({ provider: 'brave', query, firecrawlError: primary.error, results: fb.results });
            return JSON.stringify({ error: `firecrawl failed (${primary.error}); brave also failed (${fb.error})` });
          }
          return JSON.stringify({ error: primary.error });
        }
        const r = await searchBrave(braveKey, query, limit);
        return 'error' in r ? JSON.stringify({ error: r.error }) : JSON.stringify({ provider: 'brave', query, results: r.results });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : 'web_search_failure' });
      }
    },
  };

  const firecrawlScrape: Capability = {
    name: 'firecrawl_scrape',
    description: 'Scrape a URL via Firecrawl. args: {"url": string}. Returns first 2KB of markdown + caches the full page in this lattice\'s WebCache. Use fetch_chunk to read the rest incrementally without blowing context.',
    handler: async (args) => {
      const url = typeof args['url'] === 'string' ? args['url'] : '';
      if (!url) return JSON.stringify({ error: 'url required' });
      if (!firecrawlKey) return JSON.stringify({ error: 'firecrawl_unconfigured', hint: 'FIRECRAWL_API_KEY not set' });
      try {
        const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { Authorization: `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, formats: ['markdown'] }),
        });
        if (!res.ok) return JSON.stringify({ error: `firecrawl ${res.status}: ${res.statusText}` });
        const data = (await res.json()) as { data?: { markdown?: string } };
        const markdown = data.data?.markdown ?? '';
        cache.set(url, markdown);
        const preview = markdown.slice(0, 2048);
        return JSON.stringify({
          url, totalLength: markdown.length, cached: true, preview,
          hasMore: markdown.length > 2048,
          hint: markdown.length > 2048 ? `Read more with INVOKE: fetch_chunk {"url":"${url}","offset":2048}` : 'whole page fit in preview',
        });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : 'firecrawl_failure' });
      }
    },
  };

  const fetchChunk: Capability = {
    name: 'fetch_chunk',
    description: 'Read a slice of a previously-scraped URL from the lattice\'s WebCache. args: {"url": string, "offset"?: int default 0, "size"?: int 256-16384 default 4096}. Returns content + hasMore so you can iterate without re-scraping.',
    handler: async (args) => {
      const url = typeof args['url'] === 'string' ? args['url'] : '';
      const offset = typeof args['offset'] === 'number' ? Math.max(0, args['offset']) : 0;
      const size = typeof args['size'] === 'number' ? Math.min(16384, Math.max(256, args['size'])) : 4096;
      if (!url) return JSON.stringify({ error: 'url required' });
      const entry = cache.get(url);
      if (!entry) return JSON.stringify({ error: 'not_cached', hint: 'Call firecrawl_scrape({url}) first.', knownUrls: cache.urls() });
      const total = entry.markdown.length;
      const content = entry.markdown.slice(offset, offset + size);
      return JSON.stringify({
        url, offset, size, totalLength: total, hasMore: offset + size < total,
        nextOffset: offset + size < total ? offset + size : null,
        content,
      });
    },
  };

  return [webSearch, firecrawlScrape, fetchChunk];
}
