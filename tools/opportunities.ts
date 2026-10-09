import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { querySearchAnalyticsAll } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";
import {
  DEFAULT_LAG_DAYS,
  READ_ONLY,
  curveCtr,
  excludeBrandSchema,
  filterGroups,
  filtersSchema,
  isoDaysAgo,
  metrics,
  round,
  siteUrlSchema,
  textResult,
} from "@/tools/shared";

// Sitenin kendi pozisyon kovası ölçüt sayılması için gereken en az veri.
const MIN_BUCKET_IMPRESSIONS = 1000;
const MIN_BUCKET_ROWS = 5;

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
        "İlk sayfaya yakın sorguları bulur: ortalama pozisyonu belirli aralıkta (varsayılan 4-20) ve gösterimi yeterli " +
        "sorgular, hangi sayfanın sıralandığıyla birlikte. Hedef pozisyona (varsayılan 3) çıkılırsa kazanılacak tahmini ek " +
        "tıklamaya (estimatedExtraClicks, sektör CTR eğrisiyle) göre sıralar. Marka sorgularını excludeBrand ile dışla.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        days: z.number().int().min(7).max(480).optional().describe("Varsayılan 28"),
        minPosition: z.number().min(1).optional().describe("Varsayılan 4"),
        maxPosition: z.number().min(1).optional().describe("Varsayılan 20"),
        targetPosition: z.number().min(1).max(10).optional().describe("Tahmin için hedef pozisyon, varsayılan 3"),
        minImpressions: z.number().int().min(1).optional().describe("Varsayılan 50"),
        filters: filtersSchema,
        excludeBrand: excludeBrandSchema,
        limit: z.number().int().min(1).max(500).optional().describe("Varsayılan 50"),
      }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const minPos = args.minPosition ?? 4;
      const maxPos = args.maxPosition ?? 20;
      if (minPos > maxPos) throw new Error("minPosition, maxPosition'dan büyük olamaz.");
      const target = args.targetPosition ?? 3;
      const minImp = args.minImpressions ?? 50;
      const { startDate, endDate } = period(args.days ?? 28);
      const { rows, truncated } = await querySearchAnalyticsAll(googleAccessToken(ctx), args.siteUrl, {
        startDate,
        endDate,
        dimensions: ["query", "page"],
        dimensionFilterGroups: filterGroups(args.filters, args.excludeBrand),
        dataState: "final",
      });

      const candidates = rows
        .filter((r) => r.position >= minPos && r.position <= maxPos && r.impressions >= minImp)
        .map((r) => ({
          query: r.keys?.[0] ?? "",
          page: r.keys?.[1] ?? "",
          ...metrics(r),
          estimatedExtraClicks: Math.max(Math.round(r.impressions * (curveCtr(target) - r.ctr)), 0),
        }))
        .sort((a, b) => b.estimatedExtraClicks - a.estimatedExtraClicks);

      return textResult({
        siteUrl: args.siteUrl,
        period: { start: startDate, end: endDate },
        criteria: { minPosition: minPos, maxPosition: maxPos, minImpressions: minImp, targetPosition: target },
        rowLimitReached: truncated,
        count: candidates.length,
        rows: candidates.slice(0, args.limit ?? 50),
      });
    },
  );

  server.registerTool(
    "low_ctr",
    {
      title: "Düşük CTR",
      description:
        "Sıralaması iyi ama tıklanma oranı, aynı pozisyonda beklenenin belirgin altında kalan sayfa, sorgu veya " +
        "sorgu+sayfa çiftlerini bulur. Ölçüt, yeterli veri varsa sitenin kendi pozisyon başına ortalama CTR'si, yoksa " +
        "sektör CTR eğrisidir (benchmarkSource). Kaçırılan tahmini tıklamaya göre sıralar; genelde başlık/meta açıklama " +
        "sorununa işaret eder. Marka sorguları 1-2. sıradaki ölçütü şişirir; excludeBrand ile dışla. " +
        "Başlığı değişecek URL'yi görmek için dimension=queryPage kullan.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        dimension: z.enum(["page", "query", "queryPage"]).optional().describe("Varsayılan page"),
        days: z.number().int().min(7).max(480).optional().describe("Varsayılan 28"),
        maxPosition: z.number().min(1).max(20).optional().describe("Bu pozisyona kadar bak, varsayılan 10"),
        minImpressions: z.number().int().min(1).optional().describe("Varsayılan 100"),
        maxRatio: z
          .number()
          .min(0.05)
          .max(1)
          .optional()
          .describe("CTR, beklenenin bu oranının altındaysa listelenir; varsayılan 0.6"),
        filters: filtersSchema,
        excludeBrand: excludeBrandSchema,
        limit: z.number().int().min(1).max(500).optional().describe("Varsayılan 50"),
      }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const dimension = args.dimension ?? "page";
      const dimensions = dimension === "queryPage" ? (["query", "page"] as const) : ([dimension] as const);
      const { startDate, endDate } = period(args.days ?? 28);
      const { rows, truncated } = await querySearchAnalyticsAll(googleAccessToken(ctx), args.siteUrl, {
        startDate,
        endDate,
        dimensions: [...dimensions],
        dimensionFilterGroups: filterGroups(args.filters, args.excludeBrand),
        dataState: "final",
      });

      // Pozisyon kovası başına gösterim ağırlıklı ortalama CTR.
      const buckets = new Map<number, { clicks: number; impressions: number; rows: number }>();
      for (const r of rows) {
        const b = Math.round(r.position);
        const acc = buckets.get(b) ?? { clicks: 0, impressions: 0, rows: 0 };
        acc.clicks += r.clicks;
        acc.impressions += r.impressions;
        acc.rows += 1;
        buckets.set(b, acc);
      }
      // Kova yetersizse (az satır/gösterim) sektör eğrisine düşer.
      const benchmark = (position: number) => {
        const acc = buckets.get(Math.round(position));
        if (acc && acc.impressions >= MIN_BUCKET_IMPRESSIONS && acc.rows >= MIN_BUCKET_ROWS) {
          return { ctr: acc.clicks / acc.impressions, source: "site" as const };
        }
        return { ctr: curveCtr(position), source: "industryCurve" as const };
      };

      const maxPos = args.maxPosition ?? 10;
      const minImp = args.minImpressions ?? 100;
      const maxRatio = args.maxRatio ?? 0.6;
      const results = rows
        .filter((r) => r.position <= maxPos && r.impressions >= minImp)
        .map((r) => {
          const expected = benchmark(r.position);
          const keys =
            dimension === "queryPage"
              ? { query: r.keys?.[0] ?? "", page: r.keys?.[1] ?? "" }
              : { [dimension]: r.keys?.[0] ?? "" };
          return {
            ...keys,
            ...metrics(r),
            expectedCtr: round(expected.ctr * 100, 2),
            benchmarkSource: expected.source,
            missedClicks: Math.round(r.impressions * expected.ctr - r.clicks),
            ratio: expected.ctr ? r.ctr / expected.ctr : 1,
          };
        })
        .filter((r) => r.ratio < maxRatio && r.missedClicks > 0)
        .sort((a, b) => b.missedClicks - a.missedClicks);

      return textResult({
        siteUrl: args.siteUrl,
        period: { start: startDate, end: endDate },
        criteria: { dimension, maxPosition: maxPos, minImpressions: minImp, maxRatio },
        units: { ctr: "%", expectedCtr: "%", ctrVsExpected: "beklenenin %'si" },
        rowLimitReached: truncated,
        count: results.length,
        rows: results
          .slice(0, args.limit ?? 50)
          .map(({ ratio, ...rest }) => ({ ...rest, ctrVsExpected: round(ratio * 100, 0) })),
      });
    },
  );
}
