import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { seal } from "@/lib/auth/crypto";
import type { RegisteredClient } from "@/lib/auth/types";

// Dinamik istemci kaydı (RFC 7591). Kayıt saklanmıyor: izinli yönlendirme
// adresleri client_id'nin içine şifreleniyor.

const CLIENT_TTL_SECONDS = 60 * 60 * 24 * 365 * 10;

// Sadece ChatGPT'ye ve yerel teste yönlendirmeye izin veriyoruz; aksi halde
// başkası kendi adresini kaydedip Google girişinden dönen kodu alabilir.
const ALLOWED_REDIRECT_HOSTS = ["chatgpt.com", "chat.openai.com"];
// Yerel test adresi canlıda kabul edilmez.
const ALLOW_LOCALHOST = process.env.NODE_ENV !== "production";
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;

const cors = { "Access-Control-Allow-Origin": "*" };

function isAllowedRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > MAX_URI_LENGTH) return false;
  try {
    const url = new URL(uri);
    if (ALLOW_LOCALHOST && url.hostname === "localhost") return true;
    return ALLOWED_REDIRECT_HOSTS.includes(url.hostname) && url.protocol === "https:";
  } catch {
    return false;
  }
}

function error(description: string) {
  return Response.json(
    { error: "invalid_client_metadata", error_description: description },
    { status: 400, headers: cors },
  );
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const redirectUris: unknown = body?.redirect_uris;

  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return error("redirect_uris zorunlu");
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return error(`En fazla ${MAX_REDIRECT_URIS} yönlendirme adresi`);
  }
  if (!redirectUris.every(isAllowedRedirect)) {
    return error("İzin verilmeyen yönlendirme adresi");
  }

  const client: RegisteredClient = { redirect_uris: redirectUris };
  return Response.json(
    {
      client_id: seal("client", client, CLIENT_TTL_SECONDS),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201, headers: cors },
  );
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
