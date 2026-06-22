# Liclick Atlas Login

Liclick 3D Texture does not block the Projects homepage or the local 3D editor behind login. Login is required only when a workflow needs Liclick AI API authorization, such as Generate Image.

The current login path is not Feishu Open Platform OAuth. It does not require `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, a callback URL, or robot permissions. The app uses the installed `@lilith/atlas-skillhub` gateway runtime, which already knows how to start the company IDaaS / Feishu authorization flow for Liclick services.

Flow:

1. User clicks `飞书登录` or an AI feature calls `requireAiLogin`.
2. Frontend calls `GET /api/auth/feishu/start`. The route name is kept for UI compatibility.
3. Server runs `atlas-skillhub gateway status`.
4. If Atlas is already valid, the server immediately reads sanitized identity claims from the local Atlas token cache.
5. If Atlas is not valid, the server runs `atlas-skillhub gateway login`, which opens the company login / authorization flow.
6. Server creates or updates the local Liclick user from Atlas claims, usually name and email.
7. Server sets the Liclick session cookie as `httpOnly`, `SameSite=Lax`.
8. Frontend uses `GET /api/auth/me` to show the account menu and `GET /api/liclick/status` to verify Liclick API access.

Security notes:

- The frontend never receives Atlas access tokens, Feishu tokens, API keys, or raw session token values.
- The server stores only a hashed local session token.
- Atlas token contents are read only to derive a local display identity.
- The current Atlas token claims provide name and email. Avatar falls back to a deterministic local avatar until a trusted profile/avatar source is wired in.
- Homepage and local project browsing remain available when the server is offline or the user is logged out.
