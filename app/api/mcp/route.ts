import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { open } from "@/lib/auth/crypto";
import type { AccessToken } from "@/lib/auth/types";
import { registerAnalyticsTools } from "@/tools/analytics";
import { registerBlendTools } from "@/tools/blend";
import { registerCompareTools } from "@/tools/compare";
import { registerGa4Tools } from "@/tools/ga4";
import { registerIndexingTools } from "@/tools/indexing";
import { registerInsightTools } from "@/tools/insights";
import { registerManageTools } from "@/tools/manage";
import { registerOpportunityTools } from "@/tools/opportunities";
import { registerSiteTools } from "@/tools/sites";

// Toplu URL denetimi ve büyük raporlar uzun sürebiliyor.
export const maxDuration = 300;

const handler = createMcpHandler(
  (server) => {
    registerSiteTools(server);
    registerAnalyticsTools(server);
    registerCompareTools(server);
    registerInsightTools(server);
    registerIndexingTools(server);
    registerManageTools(server);
    registerGa4Tools(server);
    registerOpportunityTools(server);
    registerBlendTools(server);
  },
  { serverInfo: { name: "gsc-mcp", version: "0.1.0" } },
);

// ChatGPT'nin gönderdiği erişim anahtarını açar; geçersizse 401 döner ve
// ChatGPT girişi yeniden başlatır.
function verifyToken(_req: Request, bearerToken?: string): AuthInfo | undefined {
  if (!bearerToken) return undefined;
  const access = open<AccessToken>(bearerToken);
  if (!access) return undefined;
  return {
    token: bearerToken,
    clientId: access.client_id,
    scopes: ["gsc"],
    extra: { googleAccessToken: access.google_access_token },
  };
}

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
