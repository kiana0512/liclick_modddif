# Auth Security Notes

- Feishu uses the same OAuth shape as the reference downloader: `app_id` authorization, server-side `app_access_token`, then code exchange.
- Feishu app secrets are never hard-coded.
- `.env.example` lists keys only and contains no real secrets.
- Feishu access tokens are used server-side only for userinfo lookup.
- The frontend never receives Feishu access tokens, refresh tokens, API keys, or session token values.
- Liclick session cookies are `httpOnly`, `SameSite=Lax`, configurable `Secure`, and scoped to `/`.
- The server stores only a hashed session token.
- OAuth `state` is generated server-side, expires in memory, and is consumed once on callback.
- Missing Feishu config returns a clear error from `/api/auth/feishu/start`; the server does not crash.
- AI generation actions require login because they depend on the Liclick API user context.
- Homepage and local project browsing remain visible without login.
