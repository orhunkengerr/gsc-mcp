import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { runGa4Report } from "@/services/ga4/client";
import { querySearchAnalytics } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";
import { dateSchema, DEFAULT_LAG_DAYS, isoDaysAgo, metrics, round, siteUrlSchema, textResult } from "@/tools/shared";

// GSC tam URL verir, GA4 yol verir; ikisini aynı anahtara indirger.
function normalizePath(urlOrPath: string): string {
  let path = urlOrPath;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    path = urlOrPath.split("?")[0].split("#")[0];
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // Bozuk kodlamada yolu olduğu gibi kullan.
  }
  path = path.toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function registerBlendTools(server: McpServer) {
  server.registerTool(
    "landing_pages_blend",
    {
      title: "GSC + GA4 giriş sayfaları",
      description:
        "Aynı sayfanın Google arama verisini (GSC: tıklama, gösterim, CTR, pozisyon) ve GA4'teki organik arama " +
        "davranışını (oturum, etkileşim oranı, anahtar etkinlik, gelir) yan yana verir. Sayfalar yol bazında eşleştirilir. " +
        "Çok tıklanıp dönüşmeyen veya etkileşimi düşük sayfaları bulmak için kullanılır.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        property: z.string().describe("GA4 mülkü, örn. 'properties/123456789'"),
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        limit: z.number().int().min(1).max(500).optional().describe("GSC tıklamasına göre ilk N sayfa, varsayılan 50"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const endDate = args.endDate ?? isoDaysAgo(DEFAULT_LAG_DAYS);
      const startDate = args.startDate ?? isoDaysAgo(DEFAULT_LAG_DAYS + 27);

      const [gscRows, ga4] = await Promise.all([
        querySearchAnalytics(token, args.siteUrl, {
          startDate,
          endDate,
          dimensions: ["page"],
          rowLimit: 25000,
          dataState: "final",
        }),
        runGa4Report(token, args.property, {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "landingPage" }],
          metrics: [
            { name: "sessions" },
            { name: "engagementRate" },
            { name: "keyEvents" },
            { name: "totalRevenue" },
          ],
          dimensionFilter: {
            filter: {
              fieldName: "sessionDefaultChannelGroup",
              stringFilter: { matchType: "EXACT", value: "Organic Search" },
            },
          },
          limit: 10000,
        }),
      ]);

      // GA4 aynı yolu farklı yazımlarla verebilir; topla.
      const gaByPath = new Map<string, { sessions: number; engaged: number; keyEvents: number; revenue: number }>();
      for (const row of ga4.rows) {
        const key = normalizePath(String(row.landingPage));
        const acc = gaByPath.get(key) ?? { sessions: 0, engaged: 0, keyEvents: 0, revenue: 0 };
        const sessions = Number(row.sessions);
        acc.sessions += sessions;
        acc.engaged += sessions * Number(row.engagementRate);
        acc.keyEvents += Number(row.keyEvents);
        acc.revenue += Number(row.totalRevenue);
        gaByPath.set(key, acc);
      }

      const pages = gscRows
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, args.limit ?? 50)
        .map((r) => {
          const page = r.keys?.[0] ?? "";
          const ga = gaByPath.get(normalizePath(page));
          return {
            page,
            gsc: metrics(r),
            ga4Organic: ga
              ? {
                  sessions: ga.sessions,
                  engagementRate: ga.sessions ? round((ga.engaged / ga.sessions) * 100, 1) : 0,
                  keyEvents: ga.keyEvents,
                  revenue: round(ga.revenue, 2),
                  keyEventRate: ga.sessions ? round((ga.keyEvents / ga.sessions) * 100, 2) : 0,
                }
              : null,
          };
        });

      return textResult({
        siteUrl: args.siteUrl,
        property: args.property,
        period: { start: startDate, end: endDate },
        matched: pages.filter((p) => p.ga4Organic).length,
        pages,
      });
    },
  );
}
