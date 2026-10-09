// Google API çağrılarının ortak katmanı: zaman aşımı, geçici hatalarda tekrar
// deneme ve modelin kendini düzeltebileceği hata mesajları.

const TIMEOUT_MS = 25_000;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5_000;

// Durum koduna göre modele ne yapması gerektiğini söyleyen ek açıklamalar.
export type ErrorHints = Partial<Record<number, string>>;

const COMMON_HINTS: ErrorHints = {
  401: "Google erişimi geçersiz veya süresi dolmuş; kullanıcı ChatGPT'de bağlantıyı yeniden kurmalı.",
  429: "Google kotası doldu; bir süre bekleyip tekrar dene veya isteği küçült.",
};

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Google hata gövdesinden ({"error":{"message":...}}) okunur mesajı çıkarır.
function googleMessage(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: string } }).error?.message;
    if (message) return message;
  } catch {
    // JSON değilse ham metni kısaltarak kullan.
  }
  return body.slice(0, 300);
}

function retryDelay(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (retryAfter > 0) return Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS);
  return 500 * 2 ** attempt + Math.random() * 200;
}

// Zaman aşımı ve 429/5xx tekrarlarıyla istek atar; başarısızsa açıklamalı hata fırlatır.
export async function googleRequest(
  service: string,
  url: string,
  init: RequestInit,
  hints: ErrorHints = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new GoogleApiError(
          504,
          `${service} ${TIMEOUT_MS / 1000} sn içinde yanıt vermedi; tarih aralığını veya satır sayısını küçültüp tekrar dene.`,
        );
      }
      throw err;
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(retryDelay(res, attempt));
      continue;
    }
    const body = await res.text();
    console.error(`${service} ${res.status}: ${body.slice(0, 500)}`);
    const hint =
      hints[res.status] ??
      COMMON_HINTS[res.status] ??
      (res.status >= 500 ? "Google geçici bir hata verdi; tekrar dene." : "");
    throw new GoogleApiError(
      res.status,
      `${service} hatası (${res.status}): ${googleMessage(body)}${hint ? ` — ${hint}` : ""}`,
    );
  }
}

// Bearer anahtarıyla JSON isteği atar; boş gövdeli yanıtlar {} döner.
export async function googleJson<T>(
  service: string,
  accessToken: string,
  url: string,
  init: RequestInit = {},
  hints: ErrorHints = {},
): Promise<T> {
  const res = await googleRequest(
    service,
    url,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    hints,
  );
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}
