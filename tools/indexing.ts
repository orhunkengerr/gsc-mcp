import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { inspectUrl, listSitemaps } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";
import { siteUrlSchema, textResult } from "@/tools/shared";

const MAX_INSPECT_URLS = 20;
// Google dakikada 600 denetim izni veriyor; aynı anda az istek atıyoruz.
const INSPECT_CONCURRENCY = 5;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function registerIndexingTools(server: McpServer) {
  server.registerTool(
    "inspect_url",
    {
      title: "URL denetimi",
      description:
        "Bir veya birkaç URL'nin Google dizin durumunu denetler: dizinde mi, kapsam durumu, son tarama zamanı, " +
        "robots.txt, Google'ın ve kullanıcının seçtiği canonical, bulunduğu site haritaları, zengin sonuçlar. " +
        `Tek çağrıda en fazla ${MAX_INSPECT_URLS} URL. Google sınırı mülk başına günde 2000 denetim. ` +
        "URL'ler siteUrl mülküne ait olmalı.",
      inputSchema: z.object({
        siteUrl: siteUrlSchema,
        urls: z.array(z.string().url()).min(1).max(MAX_INSPECT_URLS).describe("Denetlenecek tam URL'ler"),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const token = googleAccessToken(ctx);
      const results = await mapLimited(args.urls, INSPECT_CONCURRENCY, async (url) => {
        try {
          return { url, ...(await inspectUrl(token, args.siteUrl, url)) };
        } catch (err) {
          // Bir URL'nin hatası diğerlerini düşürmesin.
          return { url, error: err instanceof Error ? err.message : String(err) };
        }
      });
      return textResult({ siteUrl: args.siteUrl, results });
    },
  );

  server.registerTool(
    "list_sitemaps",
    {
      title: "Site haritaları",
      description:
        "Mülke gönderilmiş site haritalarını listeler: son gönderim ve indirme zamanı, bekliyor mu, " +
        "hata ve uyarı sayısı, içerik türüne göre gönderilen URL sayısı.",
      inputSchema: z.object({ siteUrl: siteUrlSchema }),
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const sitemaps = await listSitemaps(googleAccessToken(ctx), args.siteUrl);
      return textResult({ siteUrl: args.siteUrl, sitemaps });
    },
  );
}
