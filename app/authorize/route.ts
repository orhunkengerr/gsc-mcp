import { randomBytes } from "node:crypto";
import { getPublicOrigin } from "mcp-handler";
import { open, seal } from "@/lib/auth/crypto";
import { buildGoogleAuthUrl } from "@/lib/auth/google";
import { AUTH_NONCE_COOKIE, isRegisteredClient, type PendingAuthorization } from "@/lib/auth/types";

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

  const client = open("client", clientId);
  if (!isRegisteredClient(client)) return badRequest("Geçersiz client_id");
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return badRequest("Kayıtsız redirect_uri");
  }
  if (!codeChallenge || params.get("code_challenge_method") !== "S256") {
    return badRequest("PKCE (S256) zorunlu");
  }

  // Google dönüşü aynı tarayıcıdan gelmeli; başkasının başlattığı giriş
  // bağlantısı kurbanın tarayıcısında tamamlanamasın.
  const nonce = randomBytes(16).toString("base64url");
  const pending: PendingAuthorization = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    state: params.get("state"),
    nonce,
  };
  const googleUrl = buildGoogleAuthUrl(
    getPublicOrigin(req),
    seal("pending", pending, PENDING_TTL_SECONDS),
  );
  return new Response(null, {
    status: 302,
    headers: {
      Location: googleUrl,
      "Set-Cookie": `${AUTH_NONCE_COOKIE}=${nonce}; Path=/oauth/callback; Max-Age=${PENDING_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
