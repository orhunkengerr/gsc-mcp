import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { querySearchAnalytics, querySearchAnalyticsAll, type SearchAnalyticsRow } from "@/services/gsc/client";
import { fetchSitemapUrls } from "@/services/sitemap/fetch";
import { googleAccessToken } from "@/tools/auth";
import {
  DEFAULT_LAG_DAYS,
  READ_ONLY,
  excludeBrandSchema,
  filterGroups,
  filtersSchema,
  isoDaysAgo,
  pctChange,
  round,
  shiftDate,
  siteUrlSchema,
  stripFragment,
  textResult,
  urlKey,
} from "@/tools/shared";

// Anomali tespitinde her günün karşılaştırıldığı önceki gün sayısı.
const BASELINE_DAYS = 28;

type Totals = { clicks: number; impressions: number };

function totalsOf(rows: SearchAnalyticsRow[]): Totals {
  return { clicks: rows[0]?.clicks ?? 0, impressions: rows[0]?.impressions ?? 0 };
}

function segment(t: Totals, all: Totals) {
  return {
    ...t,
    clickShare: all.clicks ? round((t.clicks / all.clicks) * 100, 1) : 0,
    ctr: t.impressions ? round((t.clicks / t.impressions) * 100, 2) : 0,
  };
}

export function registerReportTools(server: McpServer) {
  server.registerTool(
    "brand_vs_nonbrand",
    {
      title: "Marka / marka dışı",
      description:
        "Arama trafiğini marka ve marka dışı sorgulara ayırır; her biri için tıklama, gösterim, CTR ve tıklama payını, " +
        "önceki eşit uzunluktaki dönemle % değişimi verir. anonymous, Google'ın gizlediği sorgulardır (ikisine de sayılmaz). " +
        "SEO büyümesinin gerçekten marka dışından gelip gelmediğini görmek için kullanılır.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        brandRegex: z.string().min(1).describe("Marka sorgularını yakalayan RE2 regex, örn. 'nike|naik|nayk'"),
        days: z.number().int().min(7).max(240).optional().describe("Dönem uzunluğu, varsayılan 28"),
      }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const days = args.days ?? 28;
      const currentEnd = isoDaysAgo(DEFAULT_LAG_DAYS);
      const currentStart = shiftDate(currentEnd, -(days - 1));
      const previousEnd = shiftDate(currentStart, -1);
      const previousStart = shiftDate(previousEnd, -(days - 1));
      const brand = filterGroups([{ dimension: "query", operator: "includingRegex", expression: args.brandRegex }]);
      const nonBrand = filterGroups(undefined, args.brandRegex);

      const periods = [
        [currentStart, currentEnd],
        [previousStart, previousEnd],
      ];
      const results = await Promise.all(
        periods.flatMap(([startDate, endDate]) =>
          [undefined, brand, nonBrand].map((dimensionFilterGroups) =>
            querySearchAnalytics(token, args.siteUrl, { startDate, endDate, dimensionFilterGroups, dataState: "final" }),
          ),
        ),
      );
      const [curAll, curBrand, curNon, prevAll, prevBrand, prevNon] = results.map(totalsOf);

      const describe = (all: Totals, b: Totals, n: Totals) => ({
        total: segment(all, all),
        brand: segment(b, all),
        nonBrand: segment(n, all),
        anonymous: segment(
          { clicks: Math.max(all.clicks - b.clicks - n.clicks, 0), impressions: Math.max(all.impressions - b.impressions - n.impressions, 0) },
          all,
        ),
      });

      return textResult({
        siteUrl: args.siteUrl,
        brandRegex: args.brandRegex,
        currentPeriod: { start: currentStart, end: currentEnd },
        previousPeriod: { start: previousStart, end: previousEnd },
        units: { ctr: "%", clickShare: "%", pct: "%" },
        current: describe(curAll, curBrand, curNon),
        previous: describe(prevAll, prevBrand, prevNon),
        changePct: {
          brandClicks: pctChange(curBrand.clicks, prevBrand.clicks),
          nonBrandClicks: pctChange(curNon.clicks, prevNon.clicks),
          brandImpressions: pctChange(curBrand.impressions, prevBrand.impressions),
          nonBrandImpressions: pctChange(curNon.impressions, prevNon.impressions),
        },
      });
    },
  );

  server.registerTool(
    "traffic_anomalies",
    {
      title: "Trafik anomalileri",
      description:
        `Günlük tıklama/gösterim serisini çıkarır ve her günü önceki ${BASELINE_DAYS} günün ortalamasıyla karşılaştırarak ` +
        "olağandışı düşüş ve sıçramaları işaretler (sensitivity standart sapma katı). Ani düşüşlerin tarihini bulup " +
        "algoritma güncellemesi, teknik sorun veya izleme kopmasıyla ilişkilendirmek için kullanılır. " +
        "daily dizisi [tarih, tıklama, gösterim] biçimindedir.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        days: z.number().int().min(14).max(450).optional().describe("İncelenecek gün sayısı, varsayılan 90"),
        metric: z.enum(["clicks", "impressions"]).optional().describe("Varsayılan clicks"),
        sensitivity: z.number().min(1).max(5).optional().describe("Standart sapma eşiği, varsayılan 2.5"),
        filters: filtersSchema,
        excludeBrand: excludeBrandSchema,
      }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const days = args.days ?? 90;
      const metric = args.metric ?? "clicks";
      const sensitivity = args.sensitivity ?? 2.5;
      const endDate = isoDaysAgo(DEFAULT_LAG_DAYS);
      const startDate = shiftDate(endDate, -(days - 1));
      const fetchStart = shiftDate(startDate, -BASELINE_DAYS);

      const rows = await querySearchAnalytics(googleAccessToken(ctx), args.siteUrl, {
        startDate: fetchStart,
        endDate,
        dimensions: ["date"],
        dimensionFilterGroups: filterGroups(args.filters, args.excludeBrand),
        dataState: "final",
        rowLimit: 1000,
      });

      // Verisi olmayan günler 0 sayılır.
      const byDate = new Map(rows.map((r) => [r.keys?.[0] ?? "", r]));
      const series: { date: string; clicks: number; impressions: number }[] = [];
      for (let d = fetchStart; d <= endDate; d = shiftDate(d, 1)) {
        const r = byDate.get(d);
        series.push({ date: d, clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0 });
      }

      const anomalies = [];
      for (let i = BASELINE_DAYS; i < series.length; i++) {
        const window = series.slice(i - BASELINE_DAYS, i).map((p) => p[metric]);
        const mean = window.reduce((s, v) => s + v, 0) / window.length;
        const std = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length);
        const value = series[i][metric];
        if (std === 0 || Math.abs(value - mean) < sensitivity * std) continue;
        anomalies.push({
          date: series[i].date,
          [metric]: value,
          expected: round(mean, 1),
          deviationPct: mean ? round(((value - mean) / mean) * 100, 1) : null,
          zScore: round((value - mean) / std, 1),
          direction: value < mean ? "drop" : "spike",
        });
      }

      const visible = series.slice(BASELINE_DAYS);
      return textResult({
        siteUrl: args.siteUrl,
        period: { start: startDate, end: endDate },
        metric,
        sensitivity,
        totals: {
          clicks: visible.reduce((s, p) => s + p.clicks, 0),
          impressions: visible.reduce((s, p) => s + p.impressions, 0),
        },
        anomalies,
        daily: visible.map((p) => [p.date, p.clicks, p.impressions]),
      });
    },
  );

  server.registerTool(
    "sitemap_gap",
    {
      title: "Site haritası boşlukları",
      description:
        "Site haritası ile Google arama verisini karşılaştırır (URL denetim kotası harcamaz): " +
        "gösterim alıp site haritasında olmayan sayfalar (notInSitemap, tıklamaya göre) ve site haritasında olup hiç " +
        "gösterim almayan URL'ler (noImpressions; dizinde olmayabilir, sitemap_index_check ile doğrula). " +
        "Site haritası mülkün alan adında olmalı.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        sitemapUrl: z.string().url().describe("Örn. https://ornek.com/sitemap.xml"),
        days: z.number().int().min(7).max(480).optional().describe("Gösterime bakılacak dönem, varsayılan 90"),
        contains: z.string().optional().describe("Sadece bunu içeren URL'ler"),
        limit: z.number().int().min(1).max(500).optional().describe("Her listede en fazla, varsayılan 100"),
      }),
      annotations: READ_ONLY,
    },
    async (args, ctx) => {
      const days = args.days ?? 90;
      const endDate = isoDaysAgo(DEFAULT_LAG_DAYS);
      const startDate = shiftDate(endDate, -(days - 1));
      const [sitemap, gsc] = await Promise.all([
        fetchSitemapUrls(args.sitemapUrl, args.siteUrl),
        querySearchAnalyticsAll(googleAccessToken(ctx), args.siteUrl, {
          startDate,
          endDate,
          dimensions: ["page"],
          dataState: "final",
        }),
      ]);
      const limit = args.limit ?? 100;
      const matches = (u: string) => !args.contains || u.includes(args.contains);

      const sitemapKeys = new Set(sitemap.urls.map(urlKey));
      const gscPages = new Map<string, { page: string; clicks: number; impressions: number }>();
      for (const r of gsc.rows) {
        const page = stripFragment(r.keys?.[0] ?? "");
        const key = urlKey(page);
        const acc = gscPages.get(key) ?? { page, clicks: 0, impressions: 0 };
        acc.clicks += r.clicks;
        acc.impressions += r.impressions;
        gscPages.set(key, acc);
      }

      const notInSitemap = [...gscPages.entries()]
        .filter(([key, p]) => !sitemapKeys.has(key) && matches(p.page))
        .map(([, p]) => p)
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      const noImpressions = sitemap.urls.filter((u) => matches(u) && !gscPages.has(urlKey(u)));

      return textResult({
        siteUrl: args.siteUrl,
        period: { start: startDate, end: endDate },
        sitemapsRead: sitemap.sitemaps.length,
        sitemapsFailed: sitemap.failed,
        sitemapsSkipped: sitemap.skippedSitemaps,
        sitemapUrls: sitemap.urls.length,
        gscPagesWithImpressions: gscPages.size,
        gscRowLimitReached: gsc.truncated,
        notInSitemap: { count: notInSitemap.length, pages: notInSitemap.slice(0, limit) },
        noImpressions: { count: noImpressions.length, urls: noImpressions.slice(0, limit) },
      });
    },
  );
}
