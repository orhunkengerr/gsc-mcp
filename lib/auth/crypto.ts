import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Sunucuda hiçbir şey saklamıyoruz: token'lar ve kodlar AES-256-GCM ile
// şifrelenip istemciye veriliyor, geri geldiğinde açılıp doğrulanıyor.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const secret = process.env.TOKEN_SECRET;
  if (!secret) throw new Error("TOKEN_SECRET tanımlı değil");
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32) throw new Error("TOKEN_SECRET 32 bayt olmalı");
  return key;
}

type Sealed<T> = { data: T; exp: number };

// data'yı ttlSeconds süre geçerli olacak şekilde şifreler.
export function seal<T>(data: T, ttlSeconds: number): string {
  const payload: Sealed<T> = {
    data,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

// Bozuk, değiştirilmiş veya süresi dolmuş token için null döner.
export function open<T>(token: string): T | null {
  try {
    const raw = Buffer.from(token, "base64url");
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = raw.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const payload = JSON.parse(json) as Sealed<T>;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.data;
  } catch {
    return null;
  }
}
