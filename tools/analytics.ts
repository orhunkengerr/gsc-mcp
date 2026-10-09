import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { querySearchAnalytics, type SearchAnalyticsRow } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";
import {
  DEFAULT_LAG_DAYS,
  DEFAULT_RANGE_DAYS,
  DIMENSIONS,
  READ_ONLY,
  assertRange,
  dateSchema,
  filterGroups,
  filtersSchema,
  isoDaysAgo,
  metrics,
  siteUrlSchema,
  textResult,
} from "@/tools/shared";

// Tek çağrıda modele dönen en fazla satır; devamı startRow ile alınır.
const MAX_ROW_LIMIT = 1000;

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
        "Bir sayfanın sorguları için dimensions=['query'] + page equals filtresi; bir sorgunun sayfaları için tersi. " +
        "Veri son 16 ay için vardır ve 2-3 gün geriden gelir. Tarih verilmezse son 28 gün kullanılır. " +
        "totals, anonim sorgular dahil gerçek toplamdır; satırların toplamı bundan az olabilir. " +
        `Tek çağrıda en fazla ${MAX_ROW_LIMIT} satır; mayHaveMore true ise startRow ile devamını çek.`,
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        dimensions: z.array(z.enum(DIMENSIONS)).optional().describe("Kırılımlar; boşsa yalnızca toplam döner"),
        type: z
          .enum(["web", "image", "video", "news", "discover", "googleNews"])
          .optional()
          .describe("Arama türü, varsayılan web"),
        filters: filtersSchema,
        aggregationType: z
          .enum(["auto", "byPage", "byProperty"])
          .optional()
          .describe("byProperty, page kırılımı/filtresiyle ve discover/googleNews ile kullanılamaz"),
        rowLimit: z
          .number()
          .int()
          .min(1)
          .max(MAX_ROW_LIMIT)
          .optional()
          .describe(`Varsayılan 100, en fazla ${MAX_ROW_LIMIT}`),
        startRow: z.number().int().min(0).optional().describe("Sayfalama için"),
        includeFreshData: z
          .boolean()
          .optional()
          .describe("Kesinleşmemiş son günleri de dahil et; endDate verilmezse aralık bugüne kadar uzar"),
      }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const dimensions = args.dimensions ?? [];
      const endDate = args.endDate ?? isoDaysAgo(args.includeFreshData ? 0 : DEFAULT_LAG_DAYS);
      const startDate =
        args.startDate ?? isoDaysAgo(DEFAULT_LAG_DAYS + DEFAULT_RANGE_DAYS - 1);
      assertRange(startDate, endDate);
      const usesPage = dimensions.includes("page") || args.filters?.some((f) => f.dimension === "page");
      if (args.aggregationType === "byProperty" && usesPage) {
        throw new Error("byProperty, page kırılımı veya page filtresiyle birlikte kullanılamaz; auto veya byPage seç.");
      }
      const rowLimit = args.rowLimit ?? 100;
      const base = {
        startDate,
        endDate,
        type: args.type,
        dimensionFilterGroups: filterGroups(args.filters),
        aggregationType: args.aggregationType,
        dataState: args.includeFreshData ? ("all" as const) : ("final" as const),
      };

      const [rows, totalRows] = await Promise.all([
        querySearchAnalytics(token, args.siteUrl, { ...base, dimensions, rowLimit, startRow: args.startRow }),
        // Kırılım varsa toplam ayrıca çekilir: anonim sorgular satırlarda görünmez.
        dimensions.length ? querySearchAnalytics(token, args.siteUrl, base) : Promise.resolve(null),
      ]);
      const totalsRow = totalRows ? totalRows[0] : rows[0];

      return textResult({
        siteUrl: args.siteUrl,
        startDate,
        endDate,
        units: { ctr: "%", position: "ortalama sıra" },
        totals: totalsRow ? metrics(totalsRow) : null,
        rowCount: rows.length,
        // Satır sayısı limite eşitse devamı olabilir; startRow ile çekilir.
        mayHaveMore: rows.length === rowLimit,
        nextStartRow: rows.length === rowLimit ? (args.startRow ?? 0) + rowLimit : null,
        rows: dimensions.length ? formatRows(rows, dimensions) : [],
      });
    },
  );
}
