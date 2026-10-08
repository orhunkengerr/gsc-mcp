// Search Console API çağrıları. Her çağrı kullanıcının Google erişim anahtarıyla yapılır.

const GSC_API = "https://www.googleapis.com/webmasters/v3";
const INSPECTION_API = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export type GscSite = {
  siteUrl: string;
  permissionLevel: string;
};

async function gscFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith("https://") ? path : `${GSC_API}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`Search Console hatası: ${res.status} ${await res.text()}`);
  // Yazma çağrıları boş gövde dönüyor.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export async function listSites(accessToken: string): Promise<GscSite[]> {
  const data = await gscFetch<{ siteEntry?: GscSite[] }>(accessToken, "/sites");
  return data.siteEntry ?? [];
}

export type Dimension = "query" | "page" | "country" | "device" | "date" | "searchAppearance";
export type SearchType = "web" | "image" | "video" | "news" | "discover" | "googleNews";
export type FilterOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "notContains"
  | "includingRegex"
  | "excludingRegex";

export type SearchAnalyticsRequest = {
  startDate: string;
  endDate: string;
  dimensions?: Dimension[];
  type?: SearchType;
  dimensionFilterGroups?: {
    groupType: "and";
    filters: { dimension: Dimension; operator: FilterOperator; expression: string }[];
  }[];
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

// URL Inspection API yanıtı; alanlar Google'ın döndürdüğü haliyle bırakılıyor.
export type InspectionResult = {
  inspectionResultLink?: string;
  indexStatusResult?: Record<string, unknown>;
  mobileUsabilityResult?: Record<string, unknown>;
  richResultsResult?: Record<string, unknown>;
  ampResult?: Record<string, unknown>;
};

export async function inspectUrl(
  accessToken: string,
  siteUrl: string,
  inspectionUrl: string,
): Promise<InspectionResult> {
  const data = await gscFetch<{ inspectionResult?: InspectionResult }>(accessToken, INSPECTION_API, {
    method: "POST",
    body: JSON.stringify({ siteUrl, inspectionUrl, languageCode: "tr-TR" }),
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
