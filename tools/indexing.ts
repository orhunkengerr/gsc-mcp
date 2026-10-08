import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { inspectUrl, listSitemaps } from "@/services/gsc/client";
import { fetchSitemapUrls } from "@/services/sitemap/fetch";
import { googleAccessToken } from "@/tools/auth";
import { siteUrlSchema, textResult } from "@/tools/shared";

const MAX_INSPECT_URLS = 20;
const MAX_SCAN_URLS = 100;
// Google dakikada 600 denetim izni veriyor; aynı anda az istek atıyoruz.
const INSPECT_CONCURRENCY = 5;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function registerIndexingTools(server: McpServer) {
  server.registerTool(
    "inspect_url",
    {
      title: "URL denetimi",
      description:
        "Bir veya birkaç URL'nin Google dizin durumunu denetler: dizinde mi, kapsam durumu, son tarama zamanı, " +
        "robots.txt, Google'ın ve kullanıcının seçtiği canonical, bulunduğu site haritaları, zengin sonuçlar. " +
        `Tek çağrıda en fazla ${MAX_INSPECT_URLS} URL. Google sınırı mülk başına günde 2000 denetim. ` +
        "URL'ler siteUrl mülküne ait olmalı.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        urls: z.array(z.string().url()).min(1).max(MAX_INSPECT_URLS).describe("Denetlenecek tam URL'ler"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const results = await mapLimited(args.urls, INSPECT_CONCURRENCY, async (url) => {
        try {
          return { url, ...(await inspectUrl(token, args.siteUrl, url)) };
        } catch (err) {
          // Bir URL'nin hatası diğerlerini düşürmesin.
          return { url, error: err instanceof Error ? err.message : String(err) };
        }
      });
      return textResult({ siteUrl: args.siteUrl, results });
    },
  );

  server.registerTool(
    "list_sitemaps",
    {
      title: "Site haritaları",
      description:
        "Mülke gönderilmiş site haritalarını listeler: son gönderim ve indirme zamanı, bekliyor mu, " +
        "hata ve uyarı sayısı, içerik türüne göre gönderilen URL sayısı.",
      inputSchema: z.object({ siteUrl: siteUrlSchema }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const sitemaps = await listSitemaps(googleAccessToken(ctx), args.siteUrl);
      return textResult({ siteUrl: args.siteUrl, sitemaps });
    },
  );

  server.registerTool(
    "sitemap_index_check",
    {
      title: "Site haritası indeks taraması",
      description:
        "Site haritasındaki URL'leri okur (site haritası dizinlerini de izler) ve URL denetimiyle toplu kontrol eder; " +
        "dizinde olmayanları nedenleriyle, ayrıca kapsam durumu özetini verir. " +
        `Tek çağrıda en fazla ${MAX_SCAN_URLS} URL; devamı offset ile taranır. ` +
        "Her URL Google'ın günlük 2000 denetim kotasından düşer. contains ile belirli yolları seç (örn. '/pages/').",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        sitemapUrl: z.string().url().describe("Örn. https://ornek.com/sitemap.xml"),
        contains: z.string().optional().describe("Sadece bunu içeren URL'ler"),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(MAX_SCAN_URLS).optional().describe("Varsayılan 50"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const { urls, sitemaps } = await fetchSitemapUrls(args.sitemapUrl);
      const selected = args.contains ? urls.filter((u) => u.includes(args.contains!)) : urls;
      const offset = args.offset ?? 0;
      const batch = selected.slice(offset, offset + (args.limit ?? 50));

      const results = await mapLimited(batch, INSPECT_CONCURRENCY, async (url) => {
        try {
          const r = await inspectUrl(token, args.siteUrl, url);
          const s = r.indexStatusResult ?? {};
          return {
            url,
            verdict: s.verdict as string | undefined,
            coverageState: s.coverageState as string | undefined,
            lastCrawlTime: s.lastCrawlTime as string | undefined,
            googleCanonical: s.googleCanonical as string | undefined,
          };
        } catch (err) {
          return { url, error: err instanceof Error ? err.message : String(err) };
        }
      });

      const coverage: Record<string, number> = {};
      for (const r of results) {
        const key = "error" in r ? "Hata" : (r.coverageState ?? "Bilinmiyor");
        coverage[key] = (coverage[key] ?? 0) + 1;
      }

      return textResult({
        siteUrl: args.siteUrl,
        sitemapsRead: sitemaps.length,
        totalUrlsInSitemap: urls.length,
        matchingUrls: selected.length,
        scanned: { offset, count: batch.length, nextOffset: offset + batch.length < selected.length ? offset + batch.length : null },
        coverage,
        notIndexed: results.filter((r) => "error" in r || r.verdict !== "PASS"),
        indexedCount: results.filter((r) => !("error" in r) && r.verdict === "PASS").length,
      });
    },
  );
}
