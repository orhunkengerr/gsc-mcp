import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listSites } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";
import { READ_ONLY, textResult } from "@/tools/shared";

export function registerSiteTools(server: McpServer) {
  server.registerTool(
    "list_sites",
    {
      title: "Siteleri listele",
      description:
        "Kullanıcının Google Search Console'da erişebildiği tüm siteleri ve yetki seviyelerini listeler. " +
        "Diğer GSC araçlarından önce çağır: siteUrl bu çıktıdaki değerle birebir aynı yazılmalı. " +
        "usable=false olan mülkler (doğrulanmamış) veri vermez.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async (_args, ctx) => {
      const sites = await listSites(googleAccessToken(ctx));
      return textResult({
        sites: sites.map((s) => ({ ...s, usable: s.permissionLevel !== "siteUnverifiedUser" })),
      });
    },
  );
}
