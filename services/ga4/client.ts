import { googleJson, type ErrorHints } from "@/lib/google-api";

// Google Analytics 4 çağrıları (Admin API: mülk listesi, Data API: raporlar).

const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";

const GA_HINTS: ErrorHints = {
  400:
    "İstek geçersiz; boyut/metrik adlarının GA4 API adı olduğunu (örn. sessions, keyEvents, landingPage) " +
    "ve sıralama alanının istekte bulunduğunu kontrol et.",
  403: "Bu GA4 mülküne erişim yok; ga4_list_properties ile erişilebilen mülkü seç.",
  404: "GA4 mülkü bulunamadı; ga4_list_properties çıktısındaki 'properties/123' biçimini kullan.",
  429: "GA4 kotası doldu; bir süre bekleyip tekrar dene.",
};

// GA4 mülk kimliği: 'properties/123' veya '123'.
export const GA4_PROPERTY_PATTERN = /^(properties\/)?\d+$/;

function gaFetch<T>(accessToken: string, url: string, init?: RequestInit): Promise<T> {
  return googleJson<T>("Google Analytics", accessToken, url, init, GA_HINTS);
}

export type Ga4Property = {
  account: string;
  accountName: string;
  property: string;
  propertyName: string;
};

type AccountSummary = {
  account: string;
  displayName: string;
  propertySummaries?: { property: string; displayName: string }[];
};

export async function listGa4Properties(accessToken: string): Promise<Ga4Property[]> {
  const properties: Ga4Property[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${ADMIN_API}/accountSummaries`);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await gaFetch<{ accountSummaries?: AccountSummary[]; nextPageToken?: string }>(
      accessToken,
      url.toString(),
    );
    for (const acc of data.accountSummaries ?? []) {
      for (const prop of acc.propertySummaries ?? []) {
        properties.push({
          account: acc.account,
          accountName: acc.displayName,
          property: prop.property,
          propertyName: prop.displayName,
        });
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return properties;
}

export type Ga4ReportRequest = {
  dateRanges: { startDate: string; endDate: string }[];
  dimensions?: { name: string }[];
  metrics: { name: string }[];
  dimensionFilter?: unknown;
  orderBys?: unknown[];
  metricAggregations?: "TOTAL"[];
  limit?: number;
  offset?: number;
};

type Ga4ReportResponse = {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type: string }[];
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
  rowCount?: number;
  totals?: { metricValues?: { value: string }[] }[];
};

// Satırları {boyut: değer, metrik: sayı} nesnelerine çevirir.
export async function runGa4Report(
  accessToken: string,
  property: string,
  request: Ga4ReportRequest,
): Promise<{
  rowCount: number;
  rows: Record<string, string | number>[];
  totals?: Record<string, number>;
}> {
  if (!GA4_PROPERTY_PATTERN.test(property)) {
    throw new Error("GA4 mülkü 'properties/123456789' biçiminde olmalı; ga4_list_properties ile al.");
  }
  const id = property.replace(/^properties\//, "");
  const data = await gaFetch<Ga4ReportResponse>(accessToken, `${DATA_API}/properties/${id}:runReport`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  const dims = data.dimensionHeaders?.map((h) => h.name) ?? [];
  const mets = data.metricHeaders?.map((h) => h.name) ?? [];
  const rows = (data.rows ?? []).map((row) => {
    const out: Record<string, string | number> = {};
    dims.forEach((d, i) => (out[d] = row.dimensionValues?.[i]?.value ?? ""));
    mets.forEach((m, i) => (out[m] = Number(row.metricValues?.[i]?.value ?? 0)));
    return out;
  });
  const total = data.totals?.[0];
  const totals = total
    ? Object.fromEntries(mets.map((m, i) => [m, Number(total.metricValues?.[i]?.value ?? 0)]))
    : undefined;
  return { rowCount: data.rowCount ?? rows.length, rows, totals };
}
