// Araçların, istekteki doğrulanmış kimlikten Google erişim anahtarını alması.

type ToolContext = { http?: { authInfo?: { extra?: Record<string, unknown> } } };

export function googleAccessToken(ctx: ToolContext): string {
  const token = ctx.http?.authInfo?.extra?.googleAccessToken;
  if (typeof token !== "string") throw new Error("Google bağlantısı bulunamadı");
  return token;
}
