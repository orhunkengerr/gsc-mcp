import { z } from "zod";
import type { SearchAnalyticsRow } from "@/services/gsc/client";

// Performans araçlarının ortak parçaları.

export const DIMENSIONS = ["query", "page", "country", "device", "date", "searchAppearance"] as const;
export const OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "includingRegex",
  "excludingRegex",
] as const;

export const siteUrlSchema = z
  .string()
  .describe("GSC mülkü, list_sites çıktısındaki gibi (örn. 'sc-domain:ornek.com')");
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
export const filtersSchema = z
  .array(
    z.object({
      dimension: z.enum(DIMENSIONS),
      operator: z.enum(OPERATORS),
      expression: z.string(),
    }),
  )
  .optional()
  .describe("Hepsi VE ile birleşir");

// GSC verisi 2-3 gün geriden geliyor; varsayılan aralıklar bunu hesaba katar.
export const DEFAULT_LAG_DAYS = 3;
export const DEFAULT_RANGE_DAYS = 28;

export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
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

export function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
