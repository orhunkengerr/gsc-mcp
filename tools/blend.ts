import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { runGa4Report } from "@/services/ga4/client";
import { querySearchAnalyticsAll } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";
import { propertySchema } from "@/tools/ga4";
import {
  DEFAULT_LAG_DAYS,
  DEFAULT_RANGE_DAYS,
  READ_ONLY,
  assertRange,
  dateSchema,
  isoDaysAgo,
  metrics,
  round,
  siteUrlSchema,
  textResult,
} from "@/tools/shared";

const GA4_PAGE_SIZE = 10_000;
const GA4_MAX_PAGES = 5;

// Yolu karşılaştırılabilir hale getirir: sorgu/parça atılır, kodlama çözülür,
// küçük harfe çevrilir, sondaki '/' kaldırılır.
function normalizePath(path: string): string {
  let p = path.split("?")[0].split("#")[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    // Bozuk kodlamada yolu olduğu gibi kullan.
  }
  p = p.toLowerCase();
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

// GSC tam URL verir, GA4 host + yol verir; ikisini aynı anahtara indirger.
// sc-domain mülkleri birden çok host kapsadığı için host da anahtara girer.
function gscKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${normalizePath(u.pathname)}`;
  } catch {
    return normalizePath(url);
  }
}

function ga4Key(host: string, landingPage: string): string {
  return `${host.toLowerCase()}${normalizePath(landingPage)}`;
}

type GaAgg = { sessions: number; engaged: number; keyEvents: number; revenue: number };

export function registerBlendTools(server: McpServer) {
  server.registerTool(
    "landing_pages_blend",
    {
      title: "GSC + GA4 giriş sayfaları",
      description:
        "Aynı sayfanın Google arama verisini (GSC: tıklama, gösterim, CTR, pozisyon) ve GA4'teki Google organik " +
        "davranışını (oturum, etkileşim oranı, anahtar etkinlik, gelir) yan yana verir. Sayfalar host + yol bazında " +
        "eşleştirilir (sorgu parametreleri ve '#' atılır). GA4 tarafı yalnızca sessionSource=google / medium=organic'tir; " +
        "Bing vb. dahil değildir. GA4 mülk saat dilimini, GSC Pasifik saatini kullanır; küçük farklar normaldir. " +
        "Çok tıklanıp dönüşmeyen veya etkileşimi düşük sayfaları bulmak için kullanılır.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        property: propertySchema,
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        limit: z.number().int().min(1).max(500).optional().describe("GSC tıklamasına göre ilk N sayfa, varsayılan 50"),
      }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const endDate = args.endDate ?? isoDaysAgo(DEFAULT_LAG_DAYS);
      const startDate = args.startDate ?? isoDaysAgo(DEFAULT_LAG_DAYS + DEFAULT_RANGE_DAYS - 1);
      assertRange(startDate, endDate);

      const ga4Request = (offset: number) =>
        runGa4Report(token, args.property, {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "hostName" }, { name: "landingPage" }],
          metrics: [
            { name: "sessions" },
            { name: "engagementRate" },
            { name: "keyEvents" },
            { name: "totalRevenue" },
          ],
          dimensionFilter: {
            andGroup: {
              expressions: [
                { filter: { fieldName: "sessionSource", stringFilter: { matchType: "EXACT", value: "google" } } },
                { filter: { fieldName: "sessionMedium", stringFilter: { matchType: "EXACT", value: "organic" } } },
              ],
            },
          },
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          metricAggregations: offset === 0 ? ["TOTAL"] : undefined,
          limit: GA4_PAGE_SIZE,
          offset,
        });

      const [gsc, firstGa4] = await Promise.all([
        querySearchAnalyticsAll(token, args.siteUrl, {
          startDate,
          endDate,
          dimensions: ["page"],
          dataState: "final",
        }),
        ga4Request(0),
      ]);
      const ga4Rows = [...firstGa4.rows];
      for (let page = 1; page < GA4_MAX_PAGES && ga4Rows.length < firstGa4.rowCount; page++) {
        ga4Rows.push(...(await ga4Request(page * GA4_PAGE_SIZE)).rows);
      }

      // GA4 aynı yolu farklı yazımlarla verebilir; topla.
      const gaByKey = new Map<string, GaAgg>();
      for (const row of ga4Rows) {
        const key = ga4Key(String(row.hostName), String(row.landingPage));
        const acc = gaByKey.get(key) ?? { sessions: 0, engaged: 0, keyEvents: 0, revenue: 0 };
        const sessions = Number(row.sessions);
        acc.sessions += sessions;
        acc.engaged += sessions * Number(row.engagementRate);
        acc.keyEvents += Number(row.keyEvents);
        acc.revenue += Number(row.totalRevenue);
        gaByKey.set(key, acc);
      }

      // Eşleşen GA4 oturumları tüm GSC sayfaları üzerinden sayılır (yalnızca ilk N değil).
      const gscKeys = new Set(gsc.rows.map((r) => gscKey(r.keys?.[0] ?? "")));
      let matchedSessions = 0;
      for (const [key, ga] of gaByKey) if (gscKeys.has(key)) matchedSessions += ga.sessions;
      const ga4TotalSessions = firstGa4.totals?.sessions ?? ga4Rows.reduce((s, r) => s + Number(r.sessions), 0);

      const pages = [...gsc.rows]
        .sort((a, b) => b.clicks - a.clicks)
        .slice(0, args.limit ?? 50)
        .map((r) => {
          const page = r.keys?.[0] ?? "";
          const ga = gaByKey.get(gscKey(page));
          return {
            page,
            gsc: metrics(r),
            ga4GoogleOrganic: ga
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
        units: { ctr: "%", engagementRate: "%", keyEventRate: "%" },
        matched: pages.filter((p) => p.ga4GoogleOrganic).length,
        coverage: {
          ga4TotalSessions,
          ga4MatchedSessions: matchedSessions,
          // GSC'de karşılığı bulunmayan Google organik oturumlar ((not set) giriş sayfası dahil).
          ga4UnmatchedSessions: ga4TotalSessions - matchedSessions,
          gscRowLimitReached: gsc.truncated,
          ga4RowsRead: ga4Rows.length,
          ga4RowCount: firstGa4.rowCount,
        },
        pages,
      });
    },
  );
}
