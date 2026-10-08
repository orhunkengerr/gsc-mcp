import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { querySearchAnalytics } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";
import {
  DEFAULT_LAG_DAYS,
  filtersSchema,
  isoDaysAgo,
  metrics,
  round,
  siteUrlSchema,
  textResult,
} from "@/tools/shared";

const MAX_ROWS = 25000;

export function registerInsightTools(server: McpServer) {
  server.registerTool(
    "content_decay",
    {
      title: "İçerik düşüşü",
      description:
        "Tıklama kaybeden sayfaları bulur: son N günü ondan önceki N günle karşılaştırır, " +
        "önceki dönemde yeterli tıklaması olup belirgin düşen sayfaları kaybedilen tıklamaya göre sıralar. " +
        "Bir sayfanın hangi sorgularda düştüğünü görmek için ardından compare_periods'u page filtresiyle, dimension=query ile çağır.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        days: z.number().int().min(7).max(240).optional().describe("Dönem uzunluğu, varsayılan 90"),
        minPreviousClicks: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Önceki dönemde en az bu kadar tıklama, varsayılan 10"),
        minDropPercent: z.number().min(1).max(100).optional().describe("En az düşüş yüzdesi, varsayılan 20"),
        filters: filtersSchema,
        limit: z.number().int().min(1).max(500).optional().describe("Varsayılan 50"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const days = args.days ?? 90;
      const currentEnd = isoDaysAgo(DEFAULT_LAG_DAYS);
      const currentStart = isoDaysAgo(DEFAULT_LAG_DAYS + days - 1);
      const previousEnd = isoDaysAgo(DEFAULT_LAG_DAYS + days);
      const previousStart = isoDaysAgo(DEFAULT_LAG_DAYS + 2 * days - 1);
      const filterGroups = args.filters?.length
        ? [{ groupType: "and" as const, filters: args.filters }]
        : undefined;

      const [curRows, prevRows] = await Promise.all(
        [
          [currentStart, currentEnd],
          [previousStart, previousEnd],
        ].map(([startDate, endDate]) =>
          querySearchAnalytics(token, args.siteUrl, {
            startDate,
            endDate,
            dimensions: ["page"],
            dimensionFilterGroups: filterGroups,
            rowLimit: MAX_ROWS,
            dataState: "final",
          }),
        ),
      );

      const current = new Map(curRows.map((r) => [r.keys?.[0] ?? "", metrics(r)]));
      const minPrev = args.minPreviousClicks ?? 10;
      const minDrop = args.minDropPercent ?? 20;

      const decaying = prevRows
        .map((r) => {
          const page = r.keys?.[0] ?? "";
          const prev = metrics(r);
          const cur = current.get(page) ?? null;
          const lostClicks = prev.clicks - (cur?.clicks ?? 0);
          return {
            page,
            previous: prev,
            current: cur,
            lostClicks,
            dropPercent: round((lostClicks / prev.clicks) * 100, 1),
            positionChange: cur ? round(cur.position - prev.position, 1) : null,
          };
        })
        .filter((r) => r.previous.clicks >= minPrev && r.dropPercent >= minDrop)
        .sort((a, b) => b.lostClicks - a.lostClicks);

      return textResult({
        siteUrl: args.siteUrl,
        currentPeriod: { start: currentStart, end: currentEnd },
        previousPeriod: { start: previousStart, end: previousEnd },
        criteria: { minPreviousClicks: minPrev, minDropPercent: minDrop },
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
        "gösterim/tıklama paylarını ve pozisyonlarını verir; toplam gösterime göre sıralar. " +
        "Marka sorgularını dışlamak için filters ile query notContains kullan.",
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
        filters: filtersSchema,
        limit: z.number().int().min(1).max(500).optional().describe("Varsayılan 50"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const days = args.days ?? 90;
      const startDate = isoDaysAgo(DEFAULT_LAG_DAYS + days - 1);
      const endDate = isoDaysAgo(DEFAULT_LAG_DAYS);
      const rows = await querySearchAnalytics(googleAccessToken(ctx), args.siteUrl, {
        startDate,
        endDate,
        dimensions: ["query", "page"],
        dimensionFilterGroups: args.filters?.length
          ? [{ groupType: "and", filters: args.filters }]
          : undefined,
        rowLimit: MAX_ROWS,
        dataState: "final",
      });

      const minImpressions = args.minImpressions ?? 10;
      const minShare = args.minSecondaryShare ?? 10;

      const byQuery = new Map<string, { page: string; m: ReturnType<typeof metrics> }[]>();
      for (const r of rows) {
        const [query = "", page = ""] = r.keys ?? [];
        if (r.impressions < minImpressions) continue;
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
          return { query, impressions, clicks, pageCount: sorted.length, pages: sorted };
        })
        .filter((q) => q.pages[1].impressionShare >= minShare)
        .sort((a, b) => b.impressions - a.impressions);

      return textResult({
        siteUrl: args.siteUrl,
        period: { start: startDate, end: endDate },
        criteria: { minImpressions, minSecondaryShare: minShare },
        cannibalizedQueries: results.length,
        rowLimitReached: rows.length === MAX_ROWS,
        queries: results.slice(0, args.limit ?? 50),
      });
    },
  );
}
