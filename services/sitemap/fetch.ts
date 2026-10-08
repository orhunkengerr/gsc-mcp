// Site haritası XML'ini okuyup URL'leri çıkarır; site haritası dizinlerini (Shopify gibi) izler.

const MAX_CHILD_SITEMAPS = 50;

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/g)].map((m) =>
    m[1].trim().replace(/&amp;/g, "&"),
  );
}

async function fetchXml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "gsc-mcp sitemap reader" } });
  if (!res.ok) throw new Error(`Site haritası okunamadı: ${url} (${res.status})`);
  return res.text();
}

export async function fetchSitemapUrls(sitemapUrl: string): Promise<{ urls: string[]; sitemaps: string[] }> {
  const xml = await fetchXml(sitemapUrl);
  if (!/<sitemapindex[\s>]/i.test(xml)) return { urls: extractLocs(xml), sitemaps: [sitemapUrl] };

  const children = extractLocs(xml).slice(0, MAX_CHILD_SITEMAPS);
  const xmls = await Promise.all(children.map(fetchXml));
  return { urls: xmls.flatMap(extractLocs), sitemaps: children };
}
