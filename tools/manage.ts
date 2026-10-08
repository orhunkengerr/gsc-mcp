import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { addSite, deleteSitemap, removeSite, submitSitemap } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";
import { siteUrlSchema, textResult } from "@/tools/shared";

// GSC'de değişiklik yapan araçlar. Silenler destructiveHint ile işaretli;
// ChatGPT bunları çalıştırmadan önce kullanıcıdan onay ister.

const feedpathSchema = z.string().url().describe("Site haritasının tam URL'si, örn. https://ornek.com/sitemap.xml");

export function registerManageTools(server: McpServer) {
  server.registerTool(
    "submit_sitemap",
    {
      title: "Site haritası gönder",
      description:
        "Site haritasını Search Console'a gönderir veya yeniden gönderir; Google'a haritayı tekrar okumasını söyler. " +
        "Yeni veya güncellenen sayfaların daha erken taranmasına yardım eder.",
      inputSchema: z.object({ siteUrl: siteUrlSchema, feedpath: feedpathSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args, ctx) => {
      await submitSitemap(googleAccessToken(ctx), args.siteUrl, args.feedpath);
      return textResult({ ok: true, submitted: args.feedpath, siteUrl: args.siteUrl });
    },
  );

  server.registerTool(
    "delete_sitemap",
    {
      title: "Site haritasını kaldır",
      description:
        "Site haritasını Search Console'dan kaldırır. Geri alınamaz; gerekirse submit_sitemap ile yeniden gönderilir. " +
        "Çalıştırmadan önce kullanıcıdan açık onay al.",
      inputSchema: z.object({ siteUrl: siteUrlSchema, feedpath: feedpathSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args, ctx) => {
      await deleteSitemap(googleAccessToken(ctx), args.siteUrl, args.feedpath);
      return textResult({ ok: true, deleted: args.feedpath, siteUrl: args.siteUrl });
    },
  );

  server.registerTool(
    "add_site",
    {
      title: "Mülk ekle",
      description:
        "Search Console hesabına yeni bir mülk ekler. Mülk doğrulanmamış olarak eklenir; veriye erişmek için " +
        "sahipliğin Search Console arayüzünden doğrulanması gerekir. Örn. 'https://ornek.com/' veya 'sc-domain:ornek.com'.",
      inputSchema: z.object({ siteUrl: siteUrlSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args, ctx) => {
      await addSite(googleAccessToken(ctx), args.siteUrl);
      return textResult({ ok: true, added: args.siteUrl });
    },
  );

  server.registerTool(
    "remove_site",
    {
      title: "Mülkü kaldır",
      description:
        "Mülkü kullanıcının Search Console hesabından kaldırır. Geri alınamaz; yeniden eklemek doğrulama gerektirebilir " +
        "ve diğer kullanıcıların erişimini etkileyebilir. Çalıştırmadan önce kullanıcıdan açık onay al.",
      inputSchema: z.object({ siteUrl: siteUrlSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args, ctx) => {
      await removeSite(googleAccessToken(ctx), args.siteUrl);
      return textResult({ ok: true, removed: args.siteUrl });
    },
  );
}
