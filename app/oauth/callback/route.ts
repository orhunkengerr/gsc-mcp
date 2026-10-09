import { timingSafeEqual } from "node:crypto";
import { getPublicOrigin } from "mcp-handler";
import { open, seal } from "@/lib/auth/crypto";
import { exchangeGoogleCode } from "@/lib/auth/google";
import { AUTH_NONCE_COOKIE, type AuthorizationCode, type PendingAuthorization } from "@/lib/auth/types";

const CODE_TTL_SECONDS = 5 * 60;
const CLEAR_COOKIE = `${AUTH_NONCE_COOKIE}=; Path=/oauth/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function sameValue(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Set-Cookie": CLEAR_COOKIE } });
}

// Google girişinden döner; Google kodunu token'a çevirip ChatGPT'ye kendi
// kodumuzu verir.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const state = params.get("state");
  const pending = state ? open<PendingAuthorization>("pending", state) : null;
  if (!pending) {
    return new Response("Giriş oturumu geçersiz veya süresi dolmuş, tekrar deneyin.", {
      status: 400,
    });
  }
  const nonce = cookieValue(req, AUTH_NONCE_COOKIE);
  if (!nonce || typeof pending.nonce !== "string" || !sameValue(nonce, pending.nonce)) {
    return new Response("Giriş bu tarayıcıda başlatılmamış; ChatGPT'den bağlanmayı yeniden başlatın.", {
      status: 400,
    });
  }

  const back = new URL(pending.redirect_uri);
  if (pending.state) back.searchParams.set("state", pending.state);

  const googleCode = params.get("code");
  if (!googleCode) {
    back.searchParams.set("error", params.get("error") ?? "access_denied");
    return redirect(back.toString());
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
    back.searchParams.set("code", seal("code", code, CODE_TTL_SECONDS));
  } catch (err) {
    console.error(err);
    back.searchParams.set("error", "server_error");
  }
  return redirect(back.toString());
}
