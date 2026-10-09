import { googleJson, type ErrorHints } from "@/lib/google-api";

// Search Console API çağrıları. Her çağrı kullanıcının Google erişim anahtarıyla yapılır.

const GSC_API = "https://www.googleapis.com/webmasters/v3";
const INSPECTION_API = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

// Google'ın tek istekte verdiği en fazla satır; daha fazlası startRow ile sayfalanır.
export const GSC_PAGE_SIZE = 25_000;
// Analiz araçlarının bir sorguda çektiği üst sınır (4 sayfa).
export const GSC_MAX_ROWS = 100_000;

const GSC_HINTS: ErrorHints = {
  400: "İstek geçersiz; tarih biçimini (YYYY-MM-DD), boyut ve filtre adlarını kontrol et.",
  403:
    "Bu mülke erişim yok. siteUrl'yi list_sites çıktısındaki değerle birebir aynı yaz " +
    "(alan mülkü 'sc-domain:ornek.com', URL öneki 'https://ornek.com/'). " +
    "Yetkisi siteUnverifiedUser olan mülkten veri alınamaz; denetlenen URL de mülke ait olmalı.",
  404: "Mülk veya kaynak bulunamadı; list_sites ile doğru siteUrl'yi al.",
  429: "Search Console kotası doldu. URL denetimi mülk başına günde 2000, dakikada 600 istekle sınırlı; sonra tekrar dene.",
};

function gscFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith("https://") ? path : `${GSC_API}${path}`;
  return googleJson<T>("Search Console", accessToken, url, init, GSC_HINTS);
}

export type GscSite = {
  siteUrl: string;
  permissionLevel: string;
};

export async function listSites(accessToken: string): Promise<GscSite[]> {
  const data = await gscFetch<{ siteEntry?: GscSite[] }>(accessToken, "/sites");
  return data.siteEntry ?? [];
}

export type Dimension = "query" | "page" | "country" | "device" | "date" | "searchAppearance";
export type FilterDimension = Exclude<Dimension, "date">;
export type SearchType = "web" | "image" | "video" | "news" | "discover" | "googleNews";
export type FilterOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "notContains"
  | "includingRegex"
  | "excludingRegex";

export type DimensionFilter = { dimension: FilterDimension; operator: FilterOperator; expression: string };

export type SearchAnalyticsRequest = {
  startDate: string;
  endDate: string;
  dimensions?: Dimension[];
  type?: SearchType;
  dimensionFilterGroups?: { groupType: "and"; filters: DimensionFilter[] }[];
  aggregationType?: "auto" | "byPage" | "byProperty";
  rowLimit?: number;
  startRow?: number;
  dataState?: "final" | "all";
};

export type SearchAnalyticsRow = {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export async function querySearchAnalytics(
  accessToken: string,
  siteUrl: string,
  request: SearchAnalyticsRequest,
): Promise<SearchAnalyticsRow[]> {
  const data = await gscFetch<{ rows?: SearchAnalyticsRow[] }>(
    accessToken,
    `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    { method: "POST", body: JSON.stringify(request) },
  );
  return data.rows ?? [];
}

// 25.000 satır sınırını aşan sorgularda sayfaları sırayla çeker. Google satırları
// tıklamaya göre verdiği için kesilen kısım az tıklanan uzun kuyruk olur;
// truncated=true ise maxRows'a ulaşıldı ve sonuç eksik olabilir.
export async function querySearchAnalyticsAll(
  accessToken: string,
  siteUrl: string,
  request: Omit<SearchAnalyticsRequest, "rowLimit" | "startRow">,
  maxRows = GSC_MAX_ROWS,
): Promise<{ rows: SearchAnalyticsRow[]; truncated: boolean }> {
  const rows: SearchAnalyticsRow[] = [];
  for (let startRow = 0; startRow < maxRows; startRow += GSC_PAGE_SIZE) {
    const page = await querySearchAnalytics(accessToken, siteUrl, {
      ...request,
      rowLimit: GSC_PAGE_SIZE,
      startRow,
    });
    for (const row of page) rows.push(row);
    if (page.length < GSC_PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export type Sitemap = {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  warnings?: string;
  errors?: string;
  contents?: { type: string; submitted?: string; indexed?: string }[];
};

export async function listSitemaps(accessToken: string, siteUrl: string): Promise<Sitemap[]> {
  const data = await gscFetch<{ sitemap?: Sitemap[] }>(
    accessToken,
    `/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
  );
  return data.sitemap ?? [];
}

export type IndexStatusResult = {
  verdict?: string;
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  pageFetchState?: string;
  lastCrawlTime?: string;
  crawledAs?: string;
  googleCanonical?: string;
  userCanonical?: string;
  sitemap?: string[];
  referringUrls?: string[];
};

// URL Inspection API yanıtı (kullandığımız alanlar).
export type InspectionResult = {
  inspectionResultLink?: string;
  indexStatusResult?: IndexStatusResult;
  richResultsResult?: { verdict?: string; detectedItems?: { richResultType?: string }[] };
};

export async function inspectUrl(
  accessToken: string,
  siteUrl: string,
  inspectionUrl: string,
  languageCode = "tr-TR",
): Promise<InspectionResult> {
  const data = await gscFetch<{ inspectionResult?: InspectionResult }>(accessToken, INSPECTION_API, {
    method: "POST",
    body: JSON.stringify({ siteUrl, inspectionUrl, languageCode }),
  });
  return data.inspectionResult ?? {};
}

function sitemapPath(siteUrl: string, feedpath: string): string {
  return `/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`;
}

export async function submitSitemap(accessToken: string, siteUrl: string, feedpath: string): Promise<void> {
  await gscFetch(accessToken, sitemapPath(siteUrl, feedpath), { method: "PUT" });
}

export async function deleteSitemap(accessToken: string, siteUrl: string, feedpath: string): Promise<void> {
  await gscFetch(accessToken, sitemapPath(siteUrl, feedpath), { method: "DELETE" });
}

export async function addSite(accessToken: string, siteUrl: string): Promise<void> {
  await gscFetch(accessToken, `/sites/${encodeURIComponent(siteUrl)}`, { method: "PUT" });
}

export async function removeSite(accessToken: string, siteUrl: string): Promise<void> {
  await gscFetch(accessToken, `/sites/${encodeURIComponent(siteUrl)}`, { method: "DELETE" });
}
