import {
  generateProtectedResourceMetadata,
  getPublicOrigin,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";

// ChatGPT'ye "MCP adresi bu, girişi şu sunucu yapıyor" der.
// Giriş sunucusu da bizim kendi adresimiz.
export function GET(req: Request) {
  const origin = getPublicOrigin(req);
  const metadata = generateProtectedResourceMetadata({
    authServerUrls: [origin],
    resourceUrl: `${origin}/api/mcp`,
  });
  return Response.json(metadata, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
