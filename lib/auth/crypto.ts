import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Sunucuda hiçbir şey saklamıyoruz: token'lar ve kodlar AES-256-GCM ile
// şifrelenip istemciye veriliyor, geri geldiğinde açılıp doğrulanıyor.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// Her şifreli belge bir amaca bağlı (GCM ek doğrulama verisi). Böylece bir
// giriş kodu yenileme anahtarı ya da erişim anahtarı olarak kullanılamaz.
export type Purpose = "client" | "pending" | "code" | "access" | "refresh";

let cachedKey: Buffer | undefined;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.TOKEN_SECRET;
  if (!secret) throw new Error("TOKEN_SECRET tanımlı değil");
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32) throw new Error("TOKEN_SECRET 32 bayt olmalı");
  cachedKey = key;
  return key;
}

type Sealed<T> = { data: T; exp: number };

// data'yı ttlSeconds süre geçerli olacak şekilde, verilen amaca bağlayarak şifreler.
export function seal<T>(purpose: Purpose, data: T, ttlSeconds: number): string {
  const payload: Sealed<T> = {
    data,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(purpose));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

function decrypt<T>(raw: Buffer, aad: string | null): Sealed<T> | null {
  try {
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = raw.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_LENGTH });
    if (aad !== null) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return JSON.parse(json) as Sealed<T>;
  } catch {
    return null;
  }
}

// Bozuk, değiştirilmiş, başka amaçla şifrelenmiş veya süresi dolmuş token için null döner.
export function open<T>(purpose: Purpose, token: string): T | null {
  const raw = Buffer.from(token, "base64url");
  if (raw.length <= IV_LENGTH + TAG_LENGTH) return null;
  let payload = decrypt<T>(raw, purpose);
  // Amaç etiketinden önce verilmiş client_id'ler ChatGPT'de kayıtlı duruyor;
  // onları geçersiz kılmamak için etiketsiz halini de kabul ediyoruz. Biçim
  // kontrolü (redirect_uris) çağıran tarafta yapılıyor.
  if (!payload && purpose === "client") payload = decrypt<T>(raw, null);
  if (!payload || typeof payload.exp !== "number") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload.data;
}
