import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { querySearchAnalytics, type SearchAnalyticsRequest } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";
import {
  DEFAULT_LAG_DAYS,
  DEFAULT_RANGE_DAYS,
  dateSchema,
  filtersSchema,
  isoDaysAgo,
  metrics,
  round,
  siteUrlSchema,
  textResult,
} from "@/tools/shared";

const MAX_ROWS = 25000;
const SORT_FIELDS = ["clicks", "impressions", "position"] as const;

type Metrics = ReturnType<typeof metrics>;

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diff(current?: Metrics, previous?: Metrics) {
  const zero: Metrics = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const c = current ?? zero;
  const p = previous ?? zero;
  return {
    clicks: c.clicks - p.clicks,
    impressions: c.impressions - p.impressions,
    ctr: round(c.ctr - p.ctr, 2),
    // İki tarafta da sıralama varsa anlamlı; negatif = yükseldi.
    position: current && previous ? round(c.position - p.position, 1) : null,
  };
}

export function registerCompareTools(server: McpServer) {
  server.registerTool(
    "compare_periods",
    {
      title: "Dönem karşılaştırma",
      description:
        "İki tarih aralığını sorgu, sayfa, ülke veya cihaz bazında karşılaştırır; tıklama, gösterim, CTR ve " +
        "pozisyon farklarını, yeni çıkan ve kaybolan kayıtları verir. Pozisyon farkında negatif değer yükseliş demektir. " +
        "Tarih verilmezse son 28 gün ile ondan önceki 28 gün karşılaştırılır; önceki dönem verilmezse " +
        "mevcut dönemle aynı uzunlukta hemen önceki aralık kullanılır.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        dimension: z.enum(["query", "page", "country", "device"]).describe("Karşılaştırma kırılımı"),
        currentStart: dateSchema.optional(),
        currentEnd: dateSchema.optional(),
        previousStart: dateSchema.optional(),
        previousEnd: dateSchema.optional(),
        filters: filtersSchema,
        sortBy: z.enum(SORT_FIELDS).optional().describe("Farka göre sıralama, varsayılan clicks"),
        direction: z
          .enum(["losers", "gainers", "both"])
          .optional()
          .describe("Kaybedenler, kazananlar veya en büyük mutlak değişim; varsayılan both"),
        limit: z.number().int().min(1).max(500).optional().describe("Varsayılan 50"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const currentEnd = args.currentEnd ?? isoDaysAgo(DEFAULT_LAG_DAYS);
      const currentStart =
        args.currentStart ?? shiftDate(currentEnd, -(DEFAULT_RANGE_DAYS - 1));
      const length = daysBetween(currentStart, currentEnd);
      const previousEnd = args.previousEnd ?? shiftDate(currentStart, -1);
      const previousStart = args.previousStart ?? shiftDate(previousEnd, -(length - 1));

      const filterGroups = args.filters?.length
        ? [{ groupType: "and" as const, filters: args.filters }]
        : undefined;
      const base: Omit<SearchAnalyticsRequest, "startDate" | "endDate"> = {
        dimensionFilterGroups: filterGroups,
        dataState: "final",
      };

      const [curRows, prevRows, curTotal, prevTotal] = await Promise.all([
        querySearchAnalytics(token, args.siteUrl, {
          ...base, startDate: currentStart, endDate: currentEnd,
          dimensions: [args.dimension], rowLimit: MAX_ROWS,
        }),
        querySearchAnalytics(token, args.siteUrl, {
          ...base, startDate: previousStart, endDate: previousEnd,
          dimensions: [args.dimension], rowLimit: MAX_ROWS,
        }),
        // Toplamlar ayrı çekiliyor: anonim sorgular satırlarda görünmez.
        querySearchAnalytics(token, args.siteUrl, { ...base, startDate: currentStart, endDate: currentEnd }),
        querySearchAnalytics(token, args.siteUrl, { ...base, startDate: previousStart, endDate: previousEnd }),
      ]);

      const current = new Map(curRows.map((r) => [r.keys?.[0] ?? "", metrics(r)]));
      const previous = new Map(prevRows.map((r) => [r.keys?.[0] ?? "", metrics(r)]));
      const keys = new Set([...current.keys(), ...previous.keys()]);

      const sortBy = args.sortBy ?? "clicks";
      const direction = args.direction ?? "both";
      const rows = [...keys].map((key) => {
        const c = current.get(key);
        const p = previous.get(key);
        return {
          [args.dimension]: key,
          status: !p ? "new" : !c ? "lost" : "both",
          current: c ?? null,
          previous: p ?? null,
          change: diff(c, p),
        };
      });

      // Pozisyonda küçük sayı iyi olduğu için işaret ters çevrilir.
      const score = (r: (typeof rows)[number]) => {
        const v = r.change[sortBy];
        if (v === null) return 0;
        return sortBy === "position" ? -v : v;
      };
      const ranked = rows
        .filter((r) =>
          direction === "losers" ? score(r) < 0 : direction === "gainers" ? score(r) > 0 : score(r) !== 0,
        )
        .sort((a, b) =>
          direction === "losers"
            ? score(a) - score(b)
            : direction === "gainers"
              ? score(b) - score(a)
              : Math.abs(score(b)) - Math.abs(score(a)),
        )
        .slice(0, args.limit ?? 50);

      const curT = curTotal[0] ? metrics(curTotal[0]) : undefined;
      const prevT = prevTotal[0] ? metrics(prevTotal[0]) : undefined;
      return textResult({
        siteUrl: args.siteUrl,
        currentPeriod: { start: currentStart, end: currentEnd },
        previousPeriod: { start: previousStart, end: previousEnd },
        totals: { current: curT ?? null, previous: prevT ?? null, change: diff(curT, prevT) },
        summary: {
          compared: keys.size,
          new: rows.filter((r) => r.status === "new").length,
          lost: rows.filter((r) => r.status === "lost").length,
          rowLimitReached: curRows.length === MAX_ROWS || prevRows.length === MAX_ROWS,
        },
        rows: ranked,
      });
    },
  );
}
