import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { querySearchAnalytics, type SearchAnalyticsRow } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";
import {
  DEFAULT_LAG_DAYS,
  DEFAULT_RANGE_DAYS,
  DIMENSIONS,
  dateSchema,
  filtersSchema,
  isoDaysAgo,
  metrics,
  siteUrlSchema,
  textResult,
} from "@/tools/shared";

// Satırları boyut adlarıyla eşleştirip sayıları okunur hale getirir.
function formatRows(rows: SearchAnalyticsRow[], dimensions: string[]) {
  return rows.map((row) => {
    const out: Record<string, string | number> = {};
    dimensions.forEach((dim, i) => (out[dim] = row.keys?.[i] ?? ""));
    return { ...out, ...metrics(row) };
  });
}

export function registerAnalyticsTools(server: McpServer) {
  server.registerTool(
    "search_analytics",
    {
      title: "Performans verisi",
      description:
        "Google Search Console performans verisini (tıklama, gösterim, CTR %, ortalama pozisyon) getirir. " +
        "Sorgu, sayfa, ülke, cihaz, gün ve arama görünümü kırılımları ile filtre desteklenir. " +
        "Veri son 16 ay için vardır ve 2-3 gün geriden gelir. Tarih verilmezse son 28 gün kullanılır. " +
        "siteUrl, list_sites'ın döndürdüğü biçimde olmalı (örn. 'sc-domain:ornek.com' veya 'https://ornek.com/').",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        dimensions: z.array(z.enum(DIMENSIONS)).optional().describe("Kırılımlar; boşsa toplam döner"),
        type: z
          .enum(["web", "image", "video", "news", "discover", "googleNews"])
          .optional()
          .describe("Arama türü, varsayılan web"),
        filters: filtersSchema,
        aggregationType: z.enum(["auto", "byPage", "byProperty"]).optional(),
        rowLimit: z.number().int().min(1).max(25000).optional().describe("Varsayılan 100, en fazla 25000"),
        startRow: z.number().int().min(0).optional().describe("Sayfalama için"),
        includeFreshData: z.boolean().optional().describe("Kesinleşmemiş son günleri de dahil et"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const dimensions = args.dimensions ?? [];
      const startDate = args.startDate ?? isoDaysAgo(DEFAULT_LAG_DAYS + DEFAULT_RANGE_DAYS - 1);
      const endDate = args.endDate ?? isoDaysAgo(DEFAULT_LAG_DAYS);
      const rowLimit = args.rowLimit ?? 100;

      const rows = await querySearchAnalytics(googleAccessToken(ctx), args.siteUrl, {
        startDate,
        endDate,
        dimensions,
        type: args.type,
        dimensionFilterGroups: args.filters?.length
          ? [{ groupType: "and", filters: args.filters }]
          : undefined,
        aggregationType: args.aggregationType,
        rowLimit,
        startRow: args.startRow,
        dataState: args.includeFreshData ? "all" : "final",
      });

      return textResult({
        siteUrl: args.siteUrl,
        startDate,
        endDate,
        rowCount: rows.length,
        // Satır sayısı limite eşitse devamı olabilir; startRow ile çekilir.
        mayHaveMore: rows.length === rowLimit,
        rows: formatRows(rows, dimensions),
      });
    },
  );
}
