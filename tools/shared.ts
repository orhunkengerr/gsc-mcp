import { z } from "zod";
import type { DimensionFilter, SearchAnalyticsRequest, SearchAnalyticsRow } from "@/services/gsc/client";

// Performans araçlarının ortak parçaları.

export const DIMENSIONS = ["query", "page", "country", "device", "date", "searchAppearance"] as const;
// Google tarih boyutuyla filtrelemeye izin vermiyor.
export const FILTER_DIMENSIONS = ["query", "page", "country", "device", "searchAppearance"] as const;
export const OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "includingRegex",
  "excludingRegex",
] as const;

// Okuma araçları: onaysız çalışır, yalnızca kullanıcının kendi hesabına bakar.
export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export const siteUrlSchema = z
  .string()
  .describe("GSC mülkü, list_sites çıktısındaki değerle birebir aynı (örn. 'sc-domain:ornek.com' veya 'https://ornek.com/')");
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => !Number.isNaN(Date.parse(d)), "Geçersiz tarih")
  .describe("YYYY-MM-DD");
export const filtersSchema = z
  .array(
    z.object({
      dimension: z.enum(FILTER_DIMENSIONS),
      operator: z.enum(OPERATORS),
      expression: z.string(),
    }),
  )
  .optional()
  .describe("Hepsi VE ile birleşir; VEYA için includingRegex kullan (örn. 'ayakkabı|bot')");
export const excludeBrandSchema = z
  .string()
  .optional()
  .describe(
    "Marka sorgularını dışlamak için RE2 regex (örn. 'nike|naik'). Marka sorguları CTR ve pozisyon ortalamalarını şişirir. " +
      "Not: sorgu filtresi anonim sorguları da dışarıda bırakır.",
  );

// Filtreleri ve marka dışlamasını GSC'nin filtre grubuna çevirir.
export function filterGroups(
  filters: DimensionFilter[] | undefined,
  excludeBrand?: string,
): SearchAnalyticsRequest["dimensionFilterGroups"] {
  const all = [...(filters ?? [])];
  if (excludeBrand) all.push({ dimension: "query", operator: "excludingRegex", expression: excludeBrand });
  return all.length ? [{ groupType: "and", filters: all }] : undefined;
}

// GSC verisi 2-3 gün geriden geliyor; varsayılan aralıklar bunu hesaba katar.
export const DEFAULT_LAG_DAYS = 3;
export const DEFAULT_RANGE_DAYS = 28;
// GSC 16 aylık veri tutuyor.
const MAX_HISTORY_DAYS = 16 * 31;

export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

// Tarih aralığını modele anlaşılır bir hatayla doğrular.
export function assertRange(start: string, end: string): void {
  if (start > end) throw new Error(`Başlangıç (${start}) bitişten (${end}) sonra olamaz.`);
  if (daysBetween(start, isoDaysAgo(0)) > MAX_HISTORY_DAYS) {
    throw new Error(`Search Console yalnızca son 16 ayın verisini tutar; ${start} çok eski.`);
  }
}

export function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// Yüzde değişim; önceki değer 0 ise tanımsız.
export function pctChange(current: number, previous: number): number | null {
  return previous ? round(((current - previous) / previous) * 100, 1) : null;
}

// CTR'yi yüzdeye, pozisyonu tek ondalığa çevirir.
export function metrics(row: SearchAnalyticsRow) {
  return {
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: round(row.ctr * 100, 2),
    position: round(row.position, 1),
  };
}

// Pozisyon başına yaklaşık sektör CTR'si (%), 1-20. sıra; yayımlanmış CTR
// çalışmalarının yuvarlanmış ortalaması. Site verisi yetersizken ölçüt olarak kullanılır.
const CTR_CURVE = [28, 15, 10, 7, 5, 4, 3, 2.5, 2, 1.6, 1, 0.9, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.5];

// Pozisyona göre beklenen CTR (oran, 0-1); tam sayılar arası doğrusal.
export function curveCtr(position: number): number {
  const p = Math.min(Math.max(position, 1), CTR_CURVE.length);
  const lo = Math.floor(p);
  const hi = Math.min(lo + 1, CTR_CURVE.length);
  const value = CTR_CURVE[lo - 1] + (CTR_CURVE[hi - 1] - CTR_CURVE[lo - 1]) * (p - lo);
  return value / 100;
}

// '#bolum' atlama bağlantıları GSC'de ayrı sayfa gibi görünür; aynı sayfaya indirger.
export function stripFragment(url: string): string {
  const i = url.indexOf("#");
  return i === -1 ? url : url.slice(0, i);
}

// GSC ile site haritası URL'lerini eşleştirmek için: parça ve sondaki '/' atılır.
export function urlKey(url: string): string {
  const u = stripFragment(url);
  return u.length > 1 ? u.replace(/\/+$/, "") : u;
}

// Aynı anahtara düşen satırları birleştirir: tıklama/gösterim toplanır,
// pozisyon gösterim ağırlıklı ortalanır.
export function mergeRows(
  rows: SearchAnalyticsRow[],
  keyOf: (row: SearchAnalyticsRow) => string,
): Map<string, SearchAnalyticsRow> {
  const merged = new Map<string, SearchAnalyticsRow>();
  for (const r of rows) {
    const key = keyOf(r);
    const acc = merged.get(key);
    if (!acc) {
      merged.set(key, { ...r });
      continue;
    }
    const impressions = acc.impressions + r.impressions;
    acc.position = impressions
      ? (acc.position * acc.impressions + r.position * r.impressions) / impressions
      : acc.position;
    acc.clicks += r.clicks;
    acc.impressions = impressions;
    acc.ctr = impressions ? acc.clicks / impressions : 0;
  }
  return merged;
}

export function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
