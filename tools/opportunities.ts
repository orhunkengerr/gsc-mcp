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

function period(days: number) {
  return {
    startDate: isoDaysAgo(DEFAULT_LAG_DAYS + days - 1),
    endDate: isoDaysAgo(DEFAULT_LAG_DAYS),
  };
}

export function registerOpportunityTools(server: McpServer) {
  server.registerTool(
    "striking_distance",
    {
      title: "Fırsat kelimeler",
      description:
        "İlk sayfaya yakın sorguları bulur: ortalama pozisyonu belirli aralıkta (varsayılan 4-20) ve gösterimi yüksek " +
        "sorgular, hangi sayfanın sıralandığıyla birlikte. Küçük iyileştirmeyle en çok tıklama kazanılabilecek yerleri gösterir.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        days: z.number().int().min(7).max(480).optional().describe("Varsayılan 28"),
        minPosition: z.number().min(1).optional().describe("Varsayılan 4"),
        maxPosition: z.number().min(1).optional().describe("Varsayılan 20"),
        minImpressions: z.number().int().min(1).optional().describe("Varsayılan 50"),
        filters: filtersSchema,
        limit: z.number().int().min(1).max(500).optional().describe("Varsayılan 50"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const { startDate, endDate } = period(args.days ?? 28);
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

      const minPos = args.minPosition ?? 4;
      const maxPos = args.maxPosition ?? 20;
      const minImp = args.minImpressions ?? 50;
      const results = rows
        .filter((r) => r.position >= minPos && r.position <= maxPos && r.impressions >= minImp)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, args.limit ?? 50)
        .map((r) => ({ query: r.keys?.[0] ?? "", page: r.keys?.[1] ?? "", ...metrics(r) }));

      return textResult({
        siteUrl: args.siteUrl,
        period: { start: startDate, end: endDate },
        criteria: { minPosition: minPos, maxPosition: maxPos, minImpressions: minImp },
        count: results.length,
        rows: results,
      });
    },
  );

  server.registerTool(
    "low_ctr",
    {
      title: "Düşük CTR",
      description:
        "Sıralaması iyi ama tıklanma oranı, sitenin aynı pozisyondaki ortalamasının belirgin altında kalan sayfa veya sorguları bulur. " +
        "Ölçüt sitenin kendi verisinden hesaplanır (pozisyon başına ortalama CTR). Kaçırılan tahmini tıklamaya göre sıralar; " +
        "genelde başlık/meta açıklama sorununa işaret eder.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        dimension: z.enum(["page", "query"]).optional().describe("Varsayılan page"),
        days: z.number().int().min(7).max(480).optional().describe("Varsayılan 28"),
        maxPosition: z.number().min(1).max(20).optional().describe("Bu pozisyona kadar bak, varsayılan 10"),
        minImpressions: z.number().int().min(1).optional().describe("Varsayılan 100"),
        maxRatio: z
          .number()
          .min(0.05)
          .max(1)
          .optional()
          .describe("CTR, ortalamanın bu oranının altındaysa listelenir; varsayılan 0.6"),
        filters: filtersSchema,
        limit: z.number().int().min(1).max(500).optional().describe("Varsayılan 50"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const dimension = args.dimension ?? "page";
      const { startDate, endDate } = period(args.days ?? 28);
      const rows = await querySearchAnalytics(googleAccessToken(ctx), args.siteUrl, {
        startDate,
        endDate,
        dimensions: [dimension],
        dimensionFilterGroups: args.filters?.length
          ? [{ groupType: "and", filters: args.filters }]
          : undefined,
        rowLimit: MAX_ROWS,
        dataState: "final",
      });

      // Pozisyon kovası başına gösterim ağırlıklı ortalama CTR.
      const buckets = new Map<number, { clicks: number; impressions: number }>();
      for (const r of rows) {
        const b = Math.round(r.position);
        const acc = buckets.get(b) ?? { clicks: 0, impressions: 0 };
        acc.clicks += r.clicks;
        acc.impressions += r.impressions;
        buckets.set(b, acc);
      }
      const benchmark = (position: number) => {
        const acc = buckets.get(Math.round(position));
        return acc && acc.impressions ? acc.clicks / acc.impressions : 0;
      };

      const maxPos = args.maxPosition ?? 10;
      const minImp = args.minImpressions ?? 100;
      const maxRatio = args.maxRatio ?? 0.6;
      const results = rows
        .filter((r) => r.position <= maxPos && r.impressions >= minImp)
        .map((r) => {
          const expected = benchmark(r.position);
          return {
            [dimension]: r.keys?.[0] ?? "",
            ...metrics(r),
            expectedCtr: round(expected * 100, 2),
            missedClicks: Math.round(r.impressions * expected - r.clicks),
            ratio: expected ? r.ctr / expected : 1,
          };
        })
        .filter((r) => r.ratio < maxRatio && r.missedClicks > 0)
        .sort((a, b) => b.missedClicks - a.missedClicks)
        .slice(0, args.limit ?? 50)
        .map(({ ratio, ...rest }) => ({ ...rest, ctrVsExpected: round(ratio * 100, 0) }));

      return textResult({
        siteUrl: args.siteUrl,
        period: { start: startDate, end: endDate },
        criteria: { dimension, maxPosition: maxPos, minImpressions: minImp, maxRatio },
        count: results.length,
        rows: results,
      });
    },
  );
}
