import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listSites } from "@/services/gsc/client";
import { googleAccessToken } from "@/tools/auth";

export function registerSiteTools(server: McpServer) {
  server.registerTool(
    "list_sites",
    {
      title: "Siteleri listele",
      description: "Kullanıcının Google Search Console'da erişebildiği tüm siteleri ve yetki seviyelerini listeler.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) => {
      const sites = await listSites(googleAccessToken(ctx));
      return {
        content: [{ type: "text", text: JSON.stringify(sites, null, 2) }],
      };
    },
  );
}
