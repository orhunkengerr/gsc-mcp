import { createHash } from "node:crypto";
import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { open, seal } from "@/lib/auth/crypto";
import { refreshGoogleToken } from "@/lib/auth/google";
import type { AccessToken, AuthorizationCode, RefreshToken } from "@/lib/auth/types";

const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 365;
// Google erişim anahtarı dolmadan bizimki dolsun.
const EXPIRY_MARGIN_SECONDS = 60;

const cors = { "Access-Control-Allow-Origin": "*" };

function oauthError(error: string, description: string, status = 400) {
  return Response.json(
    { error, error_description: description },
    { status, headers: cors },
  );
}

function tokenResponse(
  clientId: string,
  googleAccessToken: string,
  googleExpiresIn: number,
  googleRefreshToken: string,
) {
  const expiresIn = Math.max(googleExpiresIn - EXPIRY_MARGIN_SECONDS, 60);
  const access: AccessToken = { client_id: clientId, google_access_token: googleAccessToken };
  const refresh: RefreshToken = { client_id: clientId, google_refresh_token: googleRefreshToken };
  return Response.json(
    {
      access_token: seal(access, expiresIn),
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: seal(refresh, REFRESH_TTL_SECONDS),
      scope: "gsc",
    },
    { headers: { ...cors, "Cache-Control": "no-store" } },
  );
}

function pkceMatches(verifier: string, challenge: string): boolean {
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

async function readParams(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    return new URLSearchParams(body as Record<string, string>);
  }
  return new URLSearchParams(await req.text());
}

export async function POST(req: Request) {
  const params = await readParams(req);
  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    const code = open<AuthorizationCode>(params.get("code") ?? "");
    if (!code) return oauthError("invalid_grant", "Kod geçersiz veya süresi dolmuş");
    if (params.get("client_id") !== code.client_id) {
      return oauthError("invalid_grant", "client_id uyuşmuyor");
    }
    if (params.get("redirect_uri") !== code.redirect_uri) {
      return oauthError("invalid_grant", "redirect_uri uyuşmuyor");
    }
    const verifier = params.get("code_verifier");
    if (!verifier || !pkceMatches(verifier, code.code_challenge)) {
      return oauthError("invalid_grant", "PKCE doğrulanamadı");
    }
    return tokenResponse(
      code.client_id,
      code.google_access_token,
      code.google_expires_in,
      code.google_refresh_token,
    );
  }

  if (grantType === "refresh_token") {
    const refresh = open<RefreshToken>(params.get("refresh_token") ?? "");
    if (!refresh) return oauthError("invalid_grant", "Yenileme anahtarı geçersiz");
    const clientId = params.get("client_id");
    if (clientId && clientId !== refresh.client_id) {
      return oauthError("invalid_grant", "client_id uyuşmuyor");
    }
    try {
      const tokens = await refreshGoogleToken(refresh.google_refresh_token);
      return tokenResponse(
        refresh.client_id,
        tokens.access_token,
        tokens.expires_in,
        tokens.refresh_token ?? refresh.google_refresh_token,
      );
    } catch (err) {
      console.error(err);
      // Google yenilemeyi reddettiyse (erişim kaldırıldı vb.) yeniden giriş gerekir.
      return oauthError("invalid_grant", "Google erişimi yenilenemedi, yeniden bağlanın");
    }
  }

  return oauthError("unsupported_grant_type", "Desteklenmeyen grant_type");
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
