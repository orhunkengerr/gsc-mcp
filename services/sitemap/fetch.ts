import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { gunzipSync } from "node:zlib";
import { mapLimited } from "@/lib/concurrency";

// Site haritası XML'ini okuyup URL'leri çıkarır; site haritası dizinlerini (Shopify gibi) izler.
// Sunucu kullanıcı adına dış adres çektiği için yalnızca mülkün kendi alan adına,
// herkese açık IP'lere, süre ve boyut sınırıyla gidilir.

const MAX_SITEMAPS = 50;
const MAX_DEPTH = 2;
const CHILD_CONCURRENCY = 5;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 20 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5;

export type SitemapUrls = {
  urls: string[];
  sitemaps: string[];
  failed: { url: string; error: string }[];
  // Sınır yüzünden okunmayan alt site haritası sayısı.
  skippedSitemaps: number;
};

// Aynı haritanın offset ile devam eden taramalarında tekrar indirmemek için.
const cache = new Map<string, { at: number; result: SitemapUrls }>();

// URL, GSC mülkünün alan adına mı ait? sc-domain alt alan adlarını da kapsar.
export function belongsToProperty(url: string, siteUrl: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length).toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  try {
    return host === new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`Site haritası adresi herkese açık değil: ${hostname}`);
  }
}

async function readLimited(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_BYTES) throw new Error("Site haritası 20 MB sınırını aşıyor");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Site haritası 20 MB sınırını aşıyor");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function fetchXml(url: string, siteUrl: string): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Desteklenmeyen adres: ${current}`);
    }
    if (!belongsToProperty(current, siteUrl)) {
      throw new Error(`Site haritası ${siteUrl} mülkünün alan adında olmalı: ${current}`);
    }
    await assertPublicHost(parsed.hostname);

    const res = await fetch(current, {
      headers: { "User-Agent": "gsc-mcp sitemap reader" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Site haritası okunamadı: ${current} (${res.status})`);

    let body = await readLimited(res);
    // .xml.gz dosyaları sıkıştırılmış gelir (gzip imzası 1f 8b).
    if (body[0] === 0x1f && body[1] === 0x8b) {
      body = gunzipSync(body, { maxOutputLength: MAX_BYTES });
    }
    return body.toString("utf8");
  }
  throw new Error(`Çok fazla yönlendirme: ${url}`);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/g)].map((m) =>
    decodeEntities(m[1].trim()),
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function fetchSitemapUrls(sitemapUrl: string, siteUrl: string): Promise<SitemapUrls> {
  const cacheKey = `${siteUrl}|${sitemapUrl}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const urls = new Set<string>();
  const read: string[] = [];
  const failed: SitemapUrls["failed"] = [];
  let skippedSitemaps = 0;

  // Dizin → alt dizin → URL listesi; seviye seviye, toplam MAX_SITEMAPS dosya.
  let level = [sitemapUrl];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const budget = MAX_SITEMAPS - read.length - failed.length;
    const allowed = level.slice(0, Math.max(budget, 0));
    skippedSitemaps += level.length - allowed.length;

    const results = await mapLimited(
      allowed,
      CHILD_CONCURRENCY,
      async (url): Promise<{ url: string; xml: string } | { url: string; error: string }> => {
        try {
          return { url, xml: await fetchXml(url, siteUrl) };
        } catch (err) {
          // Ana harita okunamazsa araç anlamlı bir hatayla dursun.
          if (depth === 0) throw err;
          return { url, error: errorMessage(err) };
        }
      },
    );

    const next: string[] = [];
    for (const r of results) {
      if ("error" in r) {
        failed.push({ url: r.url, error: r.error });
        continue;
      }
      const locs = extractLocs(r.xml);
      if (/<sitemapindex[\s>]/i.test(r.xml)) {
        if (depth < MAX_DEPTH) next.push(...locs);
        else skippedSitemaps += locs.length;
      } else {
        read.push(r.url);
        for (const loc of locs) urls.add(loc);
      }
    }
    level = next;
  }

  const result = { urls: [...urls], sitemaps: read, failed, skippedSitemaps };
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, { at: Date.now(), result });
  return result;
}
