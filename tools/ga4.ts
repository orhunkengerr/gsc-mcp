import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listGa4Properties, runGa4Report } from "@/services/ga4/client";
import { googleAccessToken } from "@/tools/auth";
import { textResult } from "@/tools/shared";

const propertySchema = z
  .string()
  .describe("GA4 mülkü, ga4_list_properties çıktısındaki gibi (örn. 'properties/123456789')");
const gaDateSchema = z
  .string()
  .describe("YYYY-MM-DD veya GA4 göreli tarihleri: 'today', 'yesterday', 'NdaysAgo'");

// Yapay zekâ asistanlarından gelen trafiğin kaynak adları.
const AI_SOURCES_REGEX =
  ".*(chatgpt|openai|perplexity|claude\\.ai|anthropic|gemini|bard|copilot|you\\.com|phind|deepseek|grok|meta\\.ai|mistral).*";

const MATCH_TYPES = ["EXACT", "BEGINS_WITH", "ENDS_WITH", "CONTAINS", "FULL_REGEXP", "PARTIAL_REGEXP"] as const;

export function registerGa4Tools(server: McpServer) {
  server.registerTool(
    "ga4_list_properties",
    {
      title: "GA4 mülkleri",
      description: "Kullanıcının erişebildiği Google Analytics 4 hesaplarını ve mülklerini listeler.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) => {
      return textResult({ properties: await listGa4Properties(googleAccessToken(ctx)) });
    },
  );

  server.registerTool(
    "ga4_run_report",
    {
      title: "GA4 raporu",
      description:
        "GA4 Data API ile rapor çalıştırır. Boyut ve metrik adları GA4 API adlarıdır; sık kullanılanlar: " +
        "boyutlar: date, sessionSource, sessionMedium, sessionDefaultChannelGroup, landingPage, " +
        "landingPagePlusQueryString, pagePath, country, deviceCategory, eventName; " +
        "metrikler: sessions, totalUsers, newUsers, engagedSessions, engagementRate, averageSessionDuration, " +
        "screenPageViews, keyEvents, conversions, totalRevenue, purchaseRevenue, ecommercePurchases. " +
        "Organik arama trafiği için sessionDefaultChannelGroup = 'Organic Search' filtresi kullan.",
      inputSchema: z.object({
        property: propertySchema,
        startDate: gaDateSchema.optional().describe("Varsayılan 28daysAgo"),
        endDate: gaDateSchema.optional().describe("Varsayılan yesterday"),
        dimensions: z.array(z.string()).max(9).optional(),
        metrics: z.array(z.string()).min(1).max(10),
        filters: z
          .array(
            z.object({
              dimension: z.string(),
              matchType: z.enum(MATCH_TYPES),
              value: z.string(),
              not: z.boolean().optional().describe("true ise eşleşenleri dışlar"),
            }),
          )
          .optional()
          .describe("Hepsi VE ile birleşir"),
        orderByMetric: z.string().optional().describe("Bu metriğe göre azalan sıralama"),
        limit: z.number().int().min(1).max(10000).optional().describe("Varsayılan 100"),
        offset: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const expressions = (args.filters ?? []).map((f) => {
        const expr = {
          filter: { fieldName: f.dimension, stringFilter: { matchType: f.matchType, value: f.value } },
        };
        return f.not ? { notExpression: expr } : expr;
      });
      const report = await runGa4Report(googleAccessToken(ctx), args.property, {
        dateRanges: [{ startDate: args.startDate ?? "28daysAgo", endDate: args.endDate ?? "yesterday" }],
        dimensions: args.dimensions?.map((name) => ({ name })),
        metrics: args.metrics.map((name) => ({ name })),
        dimensionFilter: expressions.length ? { andGroup: { expressions } } : undefined,
        orderBys: [
          { metric: { metricName: args.orderByMetric ?? args.metrics[0] }, desc: true },
        ],
        limit: args.limit ?? 100,
        offset: args.offset,
      });
      return textResult({ property: args.property, ...report });
    },
  );

  server.registerTool(
    "ga4_ai_traffic",
    {
      title: "Yapay zekâ trafiği",
      description:
        "ChatGPT, Perplexity, Claude, Gemini, Copilot gibi yapay zekâ asistanlarından gelen ziyaretleri " +
        "kaynak ve giriş sayfası bazında verir (oturum, kullanıcı, etkileşimli oturum, anahtar etkinlik).",
      inputSchema: z.object({
        property: propertySchema,
        startDate: gaDateSchema.optional().describe("Varsayılan 28daysAgo"),
        endDate: gaDateSchema.optional().describe("Varsayılan yesterday"),
        byLandingPage: z.boolean().optional().describe("Giriş sayfası kırılımı, varsayılan true"),
        limit: z.number().int().min(1).max(10000).optional().describe("Varsayılan 100"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const dimensions = [{ name: "sessionSource" }];
      if (args.byLandingPage ?? true) dimensions.push({ name: "landingPage" });
      const report = await runGa4Report(googleAccessToken(ctx), args.property, {
        dateRanges: [{ startDate: args.startDate ?? "28daysAgo", endDate: args.endDate ?? "yesterday" }],
        dimensions,
        metrics: [
          { name: "sessions" },
          { name: "totalUsers" },
          { name: "engagedSessions" },
          { name: "keyEvents" },
        ],
        dimensionFilter: {
          filter: {
            fieldName: "sessionSource",
            stringFilter: { matchType: "FULL_REGEXP", value: AI_SOURCES_REGEX, caseSensitive: false },
          },
        },
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: args.limit ?? 100,
      });
      return textResult({ property: args.property, ...report });
    },
  );
}
