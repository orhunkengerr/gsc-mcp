import { googleRequest } from "@/lib/google-api";

// Google OAuth çağrıları: giriş adresi, kod takası ve token yenileme.

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// webmasters: GSC okuma + site haritası ve mülk yönetimi; analytics.readonly: GA4 raporları.
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/analytics.readonly",
];

export type GoogleTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

function credentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google istemci bilgileri tanımlı değil");
  return { clientId, clientSecret };
}

export function googleCallbackUrl(origin: string): string {
  return `${origin}/oauth/callback`;
}

export function buildGoogleAuthUrl(origin: string, state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", credentials().clientId);
  url.searchParams.set("redirect_uri", googleCallbackUrl(origin));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  // offline + consent: Google'ın her girişte refresh_token vermesi için.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

async function requestTokens(params: Record<string, string>): Promise<GoogleTokens> {
  const { clientId, clientSecret } = credentials();
  const res = await googleRequest("Google token", GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  return (await res.json()) as GoogleTokens;
}

export function exchangeGoogleCode(origin: string, code: string): Promise<GoogleTokens> {
  return requestTokens({
    grant_type: "authorization_code",
    code,
    redirect_uri: googleCallbackUrl(origin),
  });
}

export function refreshGoogleToken(refreshToken: string): Promise<GoogleTokens> {
  return requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken });
}
