import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mapLimited } from "@/lib/concurrency";
import {
  inspectUrl,
  listSitemaps,
  querySearchAnalyticsAll,
  type InspectionResult,
} from "@/services/gsc/client";
import { fetchSitemapUrls } from "@/services/sitemap/fetch";
import { googleAccessToken } from "@/tools/auth";
import {
  DEFAULT_LAG_DAYS,
  DEFAULT_RANGE_DAYS,
  READ_ONLY,
  isoDaysAgo,
  siteUrlSchema,
  textResult,
  urlKey,
} from "@/tools/shared";

const MAX_INSPECT_URLS = 20;
const MAX_SCAN_URLS = 50;
// Google dakikada 600 denetim izni veriyor; 10 eşzamanlı istek bunun altında kalır.
const INSPECT_CONCURRENCY = 10;

// Denetim sonucundan modelin ihtiyaç duyduğu alanlar.
function summarize(r: InspectionResult) {
  const s = r.indexStatusResult ?? {};
  return {
    verdict: s.verdict,
    coverageState: s.coverageState,
    indexingState: s.indexingState,
    robotsTxtState: s.robotsTxtState,
    pageFetchState: s.pageFetchState,
    lastCrawlTime: s.lastCrawlTime,
    crawledAs: s.crawledAs,
    googleCanonical: s.googleCanonical,
    userCanonical: s.userCanonical,
    sitemaps: s.sitemap,
    referringUrls: s.referringUrls?.slice(0, 5),
    richResults: r.richResultsResult
      ? {
          verdict: r.richResultsResult.verdict,
          types: r.richResultsResult.detectedItems?.map((i) => i.richResultType).filter(Boolean),
        }
      : undefined,
    link: r.inspectionResultLink,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerIndexingTools(server: McpServer) {
  server.registerTool(
    "inspect_url",
    {
      title: "URL denetimi",
      description:
        "Bir veya birkaç URL'nin Google dizin durumunu denetler: dizinde mi (verdict PASS), kapsam durumu, son tarama zamanı, " +
        "robots.txt, Google'ın ve kullanıcının seçtiği canonical, bulunduğu site haritaları, zengin sonuçlar. " +
        `Tek çağrıda en fazla ${MAX_INSPECT_URLS} URL. Google sınırı mülk başına günde 2000, dakikada 600 denetim. ` +
        "URL'ler siteUrl mülküne ait olmalı.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        urls: z.array(z.string().url()).min(1).max(MAX_INSPECT_URLS).describe("Denetlenecek tam URL'ler"),
        languageCode: z.string().optional().describe("Durum metinlerinin dili, varsayılan tr-TR"),
      }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const results = await mapLimited(args.urls, INSPECT_CONCURRENCY, async (url) => {
        try {
          return { url, ...summarize(await inspectUrl(token, args.siteUrl, url, args.languageCode)) };
        } catch (err) {
          // Bir URL'nin hatası diğerlerini düşürmesin.
          return { url, error: errorMessage(err) };
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
        "hata ve uyarı sayısı, içerik türüne göre gönderilen URL sayısı. Dizine eklenen sayıyı Google artık " +
        "vermiyor; dizin durumu için sitemap_index_check kullan.",
      inputSchema: z.object({ siteUrl: siteUrlSchema }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const sitemaps = await listSitemaps(googleAccessToken(ctx), args.siteUrl);
      return textResult({
        siteUrl: args.siteUrl,
        sitemaps: sitemaps.map((s) => ({
          path: s.path,
          lastSubmitted: s.lastSubmitted,
          lastDownloaded: s.lastDownloaded,
          isPending: s.isPending,
          isSitemapsIndex: s.isSitemapsIndex,
          errors: Number(s.errors ?? 0),
          warnings: Number(s.warnings ?? 0),
          // contents[].indexed Google tarafından kullanımdan kaldırıldı; hep 0 döner.
          submitted: s.contents?.map((c) => ({ type: c.type, submitted: Number(c.submitted ?? 0) })),
        })),
      });
    },
  );

  server.registerTool(
    "sitemap_index_check",
    {
      title: "Site haritası indeks taraması",
      description:
        "Site haritasındaki URL'leri okur (site haritası dizinlerini ve .xml.gz'yi de izler) ve URL denetimiyle toplu kontrol eder; " +
        "dizinde olmayanları nedenleriyle, ayrıca kapsam ve sonuç (verdict) özetini verir. " +
        "Kota için varsayılan olarak son 28 günde gösterim alan URL'ler denetlenmez (dizinde sayılır, withImpressions). " +
        `Tek çağrıda en fazla ${MAX_SCAN_URLS} URL; devamı nextOffset ile taranır. ` +
        "Her denetlenen URL Google'ın günlük 2000 denetim kotasından düşer. contains ile belirli yolları seç (örn. '/pages/'). " +
        "Site haritası mülkün alan adında olmalı. verdict NEUTRAL genelde bilinçli dışlamadır (noindex, alternatif canonical).",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        sitemapUrl: z.string().url().describe("Örn. https://ornek.com/sitemap.xml"),
        contains: z.string().optional().describe("Sadece bunu içeren URL'ler"),
        skipPagesWithImpressions: z
          .boolean()
          .optional()
          .describe("Son 28 günde gösterim alan URL'leri denetleme; varsayılan true"),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(MAX_SCAN_URLS).optional().describe("Varsayılan 25"),
      }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const skipSeen = args.skipPagesWithImpressions ?? true;
      const [sitemap, seen] = await Promise.all([
        fetchSitemapUrls(args.sitemapUrl, args.siteUrl),
        skipSeen
          ? querySearchAnalyticsAll(token, args.siteUrl, {
              startDate: isoDaysAgo(DEFAULT_LAG_DAYS + DEFAULT_RANGE_DAYS - 1),
              endDate: isoDaysAgo(DEFAULT_LAG_DAYS),
              dimensions: ["page"],
              dataState: "final",
            })
          : Promise.resolve(null),
      ]);
      const seenKeys = new Set((seen?.rows ?? []).map((r) => urlKey(r.keys?.[0] ?? "")));

      const selected = args.contains ? sitemap.urls.filter((u) => u.includes(args.contains!)) : sitemap.urls;
      const withImpressions = selected.filter((u) => seenKeys.has(urlKey(u)));
      const toInspect = selected.filter((u) => !seenKeys.has(urlKey(u)));
      const offset = args.offset ?? 0;
      const batch = toInspect.slice(offset, offset + (args.limit ?? 25));

      const results = await mapLimited(batch, INSPECT_CONCURRENCY, async (url) => {
        try {
          const s = (await inspectUrl(token, args.siteUrl, url)).indexStatusResult ?? {};
          return {
            url,
            verdict: s.verdict,
            coverageState: s.coverageState,
            lastCrawlTime: s.lastCrawlTime,
            googleCanonical: s.googleCanonical,
          };
        } catch (err) {
          return { url, error: errorMessage(err) };
        }
      });

      const coverage: Record<string, number> = {};
      const verdicts: Record<string, number> = {};
      for (const r of results) {
        const cov = "error" in r ? "Hata" : (r.coverageState ?? "Bilinmiyor");
        const ver = "error" in r ? "ERROR" : (r.verdict ?? "UNKNOWN");
        coverage[cov] = (coverage[cov] ?? 0) + 1;
        verdicts[ver] = (verdicts[ver] ?? 0) + 1;
      }

      return textResult({
        siteUrl: args.siteUrl,
        sitemapsRead: sitemap.sitemaps.length,
        sitemapsFailed: sitemap.failed,
        sitemapsSkipped: sitemap.skippedSitemaps,
        totalUrlsInSitemap: sitemap.urls.length,
        matchingUrls: selected.length,
        withImpressions: withImpressions.length,
        toInspect: toInspect.length,
        scanned: {
          offset,
          count: batch.length,
          nextOffset: offset + batch.length < toInspect.length ? offset + batch.length : null,
        },
        verdicts,
        coverage,
        notIndexed: results.filter((r) => "error" in r || r.verdict !== "PASS"),
        indexedCount: results.filter((r) => !("error" in r) && r.verdict === "PASS").length,
      });
    },
  );
}
