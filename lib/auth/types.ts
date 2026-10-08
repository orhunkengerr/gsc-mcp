// Şifrelenip istemciye giden ara durumlar.

// /register'ın client_id içine şifrelediği kayıt.
export type RegisteredClient = { redirect_uris: string[] };

// /authorize → Google → /oauth/callback arasında taşınan ChatGPT isteği.
export type PendingAuthorization = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
};

// /oauth/callback'in ChatGPT'ye verdiği kod; /token bunu açar.
export type AuthorizationCode = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  google_access_token: string;
  google_refresh_token: string;
  google_expires_in: number;
};

// ChatGPT'nin MCP isteklerinde taşıdığı erişim anahtarı.
export type AccessToken = {
  client_id: string;
  google_access_token: string;
};

// Erişim anahtarı dolunca yenilemek için.
export type RefreshToken = {
  client_id: string;
  google_refresh_token: string;
};
