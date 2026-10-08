import { getPublicOrigin } from "mcp-handler";
import { open, seal } from "@/lib/auth/crypto";
import { buildGoogleAuthUrl } from "@/lib/auth/google";
import type { PendingAuthorization, RegisteredClient } from "@/lib/auth/types";

const PENDING_TTL_SECONDS = 10 * 60;

function badRequest(description: string) {
  return Response.json(
    { error: "invalid_request", error_description: description },
    { status: 400 },
  );
}

// ChatGPT'nin giriş isteğini doğrular ve kullanıcıyı Google girişine gönderir.
export function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const codeChallenge = params.get("code_challenge");

  if (params.get("response_type") !== "code") return badRequest("response_type code olmalı");
  if (!clientId) return badRequest("client_id eksik");

  const client = open<RegisteredClient>(clientId);
  if (!client) return badRequest("Geçersiz client_id");
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return badRequest("Kayıtsız redirect_uri");
  }
  if (!codeChallenge || params.get("code_challenge_method") !== "S256") {
    return badRequest("PKCE (S256) zorunlu");
  }

  const pending: PendingAuthorization = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    state: params.get("state"),
  };
  const googleUrl = buildGoogleAuthUrl(
    getPublicOrigin(req),
    seal(pending, PENDING_TTL_SECONDS),
  );
  return Response.redirect(googleUrl, 302);
}
