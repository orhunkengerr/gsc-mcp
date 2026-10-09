import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { querySearchAnalyticsAll } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";
import {
  DEFAULT_LAG_DAYS,
  READ_ONLY,
  assertRange,
  excludeBrandSchema,
  filterGroups,
  filtersSchema,
  isoDaysAgo,
  mergeRows,
  metrics,
  round,
  shiftDate,
  siteUrlSchema,
  stripFragment,
  textResult,
} from "@/tools/shared";

// Yıllık karşılaştırmada haftanın günü aynı kalsın diye 52 hafta.
const YEAR_DAYS = 364;

type Metrics = ReturnType<typeof metrics>;

// Yarışan iki sayfanın ne kadar sorun olduğunu kabaca derecelendirir.
function severity(pages: (Metrics & { impressionShare: number; clickShare: number })[]) {
  const [a, b] = pages;
  // Bir sayfa tıklamaların neredeyse hepsini alıyorsa ya da ikisi de ilk 3'teyse
  // (çift listeleme) genelde sorun değildir.
  if (a.clickShare >= 90 || b.clickShare >= 90 || (a.position <= 3 && b.position <= 3)) return "low";
  if (b.impressionShare >= 30 && a.position <= 20 && b.position <= 20 && Math.abs(a.position - b.position) <= 5) {
    return "high";
  }
  return "medium";
}

export function registerInsightTools(server: McpServer) {
  server.registerTool(
    "content_decay",
    {
      title: "İçerik düşüşü",
      description:
        "Tıklama kaybeden sayfaları bulur: son N günü ondan önceki N günle (compareTo=previous) veya geçen yılın aynı " +
        "dönemiyle (compareTo=yoy, mevsimselliği eler) karşılaştırır; önceki dönemde yeterli tıklaması olup belirgin düşen " +
        "sayfaları kaybedilen tıklamaya göre sıralar. missingInCurrent=true olan sayfa taşınmış, kaldırılmış veya noindex " +
        "olmuş olabilir; inspect_url ile kontrol et. Bir sayfanın hangi sorgularda düştüğünü görmek için ardından " +
        "compare_periods'u page filtresiyle, dimension=query ile çağır.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        days: z.number().int().min(7).max(240).optional().describe("Dönem uzunluğu, varsayılan 90"),
        compareTo: z
          .enum(["previous", "yoy"])
          .optional()
          .describe("previous: hemen önceki dönem (varsayılan); yoy: geçen yılın aynı dönemi"),
        minPreviousClicks: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Önceki dönemde en az bu kadar tıklama, varsayılan 10"),
        minDropPercent: z.number().min(1).max(100).optional().describe("En az düşüş yüzdesi, varsayılan 20"),
        filters: filtersSchema,
        excludeBrand: excludeBrandSchema,
        limit: z.number().int().min(1).max(500).optional().describe("Varsayılan 50"),
      }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const days = args.days ?? 90;
      const compareTo = args.compareTo ?? "previous";
      const currentEnd = isoDaysAgo(DEFAULT_LAG_DAYS);
      const currentStart = isoDaysAgo(DEFAULT_LAG_DAYS + days - 1);
      const shift = compareTo === "yoy" ? YEAR_DAYS : days;
      const previousStart = shiftDate(currentStart, -shift);
      const previousEnd = shiftDate(currentEnd, -shift);
      assertRange(previousStart, previousEnd);
      const dimensionFilterGroups = filterGroups(args.filters, args.excludeBrand);

      const [cur, prev] = await Promise.all(
        [
          [currentStart, currentEnd],
          [previousStart, previousEnd],
        ].map(([startDate, endDate]) =>
          querySearchAnalyticsAll(token, args.siteUrl, {
            startDate,
            endDate,
            dimensions: ["page"],
            dimensionFilterGroups,
            dataState: "final",
          }),
        ),
      );

      const pageKey = (r: { keys?: string[] }) => stripFragment(r.keys?.[0] ?? "");
      const current = mergeRows(cur.rows, pageKey);
      const previous = mergeRows(prev.rows, pageKey);
      const minPrev = args.minPreviousClicks ?? 10;
      const minDrop = args.minDropPercent ?? 20;

      const decaying = [...previous.entries()]
        .map(([page, row]) => {
          const prevM = metrics(row);
          const curRow = current.get(page);
          const curM = curRow ? metrics(curRow) : null;
          const lostClicks = prevM.clicks - (curM?.clicks ?? 0);
          return {
            page,
            previous: prevM,
            current: curM,
            lostClicks,
            dropPercent: round((lostClicks / prevM.clicks) * 100, 1),
            positionChange: curM ? round(curM.position - prevM.position, 1) : null,
            missingInCurrent: !curM,
            // Mevcut dönem satır sınırında kesildiyse sayfa sınırın altında kalmış olabilir.
            uncertain: !curM && cur.truncated,
          };
        })
        .filter((r) => r.previous.clicks >= minPrev && r.dropPercent >= minDrop)
        .sort((a, b) => b.lostClicks - a.lostClicks);

      return textResult({
        siteUrl: args.siteUrl,
        compareTo,
        currentPeriod: { start: currentStart, end: currentEnd },
        previousPeriod: { start: previousStart, end: previousEnd },
        criteria: { minPreviousClicks: minPrev, minDropPercent: minDrop },
        rowLimitReached: cur.truncated || prev.truncated,
        decayingPages: decaying.length,
        totalLostClicks: decaying.reduce((sum, r) => sum + r.lostClicks, 0),
        pages: decaying.slice(0, args.limit ?? 50),
      });
    },
  );

  server.registerTool(
    "cannibalization",
    {
      title: "Anahtar kelime yamyamlığı",
      description:
        "Aynı sorguda birden fazla sayfanın gösterim aldığı durumları bulur. Her sorgu için yarışan sayfaları, " +
        "gösterim/tıklama paylarını, pozisyonlarını ve önem derecesini (severity: high/medium/low) verir. " +
        "low: bir sayfa tıklamaların çoğunu alıyor veya ikisi de ilk 3'te (çift listeleme, genelde iyi). " +
        "high: iki sayfa benzer pozisyonda gösterimi bölüşüyor. '#' atlama bağlantıları sayfayla birleştirilir. " +
        "Marka sorgularını excludeBrand ile dışla.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        days: z.number().int().min(7).max(480).optional().describe("Bakılacak dönem, varsayılan 90"),
        minImpressions: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Bir sayfanın yarışıyor sayılması için sorguda en az gösterim, varsayılan 10"),
        minSecondaryShare: z
          .number()
          .min(0)
          .max(50)
          .optional()
          .describe("İkinci sayfanın gösterim payı en az bu yüzde olmalı, varsayılan 10"),
        minSeverity: z.enum(["low", "medium", "high"]).optional().describe("Varsayılan medium"),
        filters: filtersSchema,
        excludeBrand: excludeBrandSchema,
        limit: z.number().int().min(1).max(500).optional().describe("Varsayılan 50"),
      }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const days = args.days ?? 90;
      const startDate = isoDaysAgo(DEFAULT_LAG_DAYS + days - 1);
      const endDate = isoDaysAgo(DEFAULT_LAG_DAYS);
      const { rows, truncated } = await querySearchAnalyticsAll(googleAccessToken(ctx), args.siteUrl, {
        startDate,
        endDate,
        dimensions: ["query", "page"],
        dimensionFilterGroups: filterGroups(args.filters, args.excludeBrand),
        dataState: "final",
      });

      const minImpressions = args.minImpressions ?? 10;
      const minShare = args.minSecondaryShare ?? 10;
      const levels = ["low", "medium", "high"];
      const minLevel = levels.indexOf(args.minSeverity ?? "medium");

      // Sorgu + parçasız sayfa bazında birleştir, sonra sorguya göre grupla.
      const merged = mergeRows(rows, (r) => `${r.keys?.[0] ?? ""}\u0000${stripFragment(r.keys?.[1] ?? "")}`);
      const byQuery = new Map<string, { page: string; m: Metrics }[]>();
      for (const [key, r] of merged) {
        if (r.impressions < minImpressions) continue;
        const [query, page] = key.split("\u0000");
        const list = byQuery.get(query) ?? [];
        list.push({ page, m: metrics(r) });
        byQuery.set(query, list);
      }

      const results = [...byQuery.entries()]
        .filter(([, pages]) => pages.length >= 2)
        .map(([query, pages]) => {
          const impressions = pages.reduce((s, p) => s + p.m.impressions, 0);
          const clicks = pages.reduce((s, p) => s + p.m.clicks, 0);
          const sorted = pages
            .map((p) => ({
              page: p.page,
              ...p.m,
              impressionShare: round((p.m.impressions / impressions) * 100, 1),
              clickShare: clicks ? round((p.m.clicks / clicks) * 100, 1) : 0,
            }))
            .sort((a, b) => b.impressions - a.impressions);
          return { query, severity: severity(sorted), impressions, clicks, pageCount: sorted.length, pages: sorted };
        })
        .filter((q) => q.pages[1].impressionShare >= minShare && levels.indexOf(q.severity) >= minLevel)
        .sort((a, b) => b.impressions - a.impressions);

      return textResult({
        siteUrl: args.siteUrl,
        period: { start: startDate, end: endDate },
        criteria: { minImpressions, minSecondaryShare: minShare, minSeverity: levels[minLevel] },
        cannibalizedQueries: results.length,
        rowLimitReached: truncated,
        queries: results.slice(0, args.limit ?? 50),
      });
    },
  );
}
