import { getPublicOrigin } from "mcp-handler";
import { open, seal } from "@/lib/auth/crypto";
import { exchangeGoogleCode } from "@/lib/auth/google";
import type { AuthorizationCode, PendingAuthorization } from "@/lib/auth/types";

const CODE_TTL_SECONDS = 5 * 60;

// Google girişinden döner; Google kodunu token'a çevirip ChatGPT'ye kendi
// kodumuzu verir.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const state = params.get("state");
  const pending = state ? open<PendingAuthorization>(state) : null;
  if (!pending) {
    return new Response("Giriş oturumu geçersiz veya süresi dolmuş, tekrar deneyin.", {
      status: 400,
    });
  }

  const back = new URL(pending.redirect_uri);
  if (pending.state) back.searchParams.set("state", pending.state);

  const googleCode = params.get("code");
  if (!googleCode) {
    back.searchParams.set("error", params.get("error") ?? "access_denied");
    return Response.redirect(back.toString(), 302);
  }

  try {
    const tokens = await exchangeGoogleCode(getPublicOrigin(req), googleCode);
    if (!tokens.refresh_token) throw new Error("Google refresh_token vermedi");

    const code: AuthorizationCode = {
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      google_access_token: tokens.access_token,
      google_refresh_token: tokens.refresh_token,
      google_expires_in: tokens.expires_in,
    };
    back.searchParams.set("code", seal(code, CODE_TTL_SECONDS));
  } catch (err) {
    console.error(err);
    back.searchParams.set("error", "server_error");
  }
  return Response.redirect(back.toString(), 302);
}
