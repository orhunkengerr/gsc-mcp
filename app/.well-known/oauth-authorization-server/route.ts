import { getPublicOrigin, metadataCorsOptionsRequestHandler } from "mcp-handler";

// ChatGPT'ye kayıt, giriş ve token adreslerini söyler (RFC 8414).
export function GET(req: Request) {
  const origin = getPublicOrigin(req);
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["gsc"],
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
