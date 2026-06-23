# Liclick Atlas Login

Liclick 3D Texture does not block the Projects homepage or the local 3D editor behind login. Login is required when a workflow needs authenticated server APIs, such as creating, importing, saving, viewing user-scoped workspace data, or calling Liclick AI services.

The default real login path is the local Atlas gateway runtime, not Liclick-managed IDaaS SP login. This means Liclick does not need to register `http://127.0.0.1:4517/...` as an IDaaS Service URL. Atlas starts the company IDaaS / Feishu authorization flow and writes its own local token cache. Liclick reads sanitized identity claims from that cache and creates a local `liclick_3d_session` cookie.

Use `ATLAS_LOGIN_MODE=interactive` for both local development and A100. On local development, the browser can hit the Atlas listener directly. On A100, the browser's `localhost:20265` is not the server, so Liclick asks the user to copy the full callback URL back into the app and the backend forwards it to the server-side Atlas listener.

Flow:

1. User clicks `飞书登录` or an authenticated workflow needs a session.
2. Frontend calls `GET /api/auth/feishu/start`. The route name is kept for UI compatibility.
3. Server runs `atlas-skillhub gateway login` in an isolated Atlas home directory.
4. Atlas opens or prints the company login URL. The user completes the IDaaS / Feishu flow owned by Atlas.
5. Server polls `atlas-skillhub gateway status` until the Atlas token cache is valid.
6. Server creates or updates the local Liclick user from Atlas claims, usually name and email.
7. Server sets the Liclick session cookie as `HttpOnly`, `SameSite=Lax`.
8. Frontend polls `GET /api/auth/feishu/poll/:loginId`, then uses `GET /api/auth/me` to show the authenticated user.

Configuration:

```env
AUTH_MODE=feishu-oauth
LICLICK_ENABLE_ATLAS_LOCAL_LOGIN=true
IDAAS_JWT_SSO_ENABLED=false
ATLAS_LOGIN_MODE=interactive
```

If the Atlas browser flow ends on `localhost:20265/callback` with a connection error, paste the full callback URL into the Liclick login prompt. The server proxies that callback to the Atlas listener running on the server and finishes the login. The IDaaS cookie stays in the user's browser; the callback URL contains the token Atlas needs.

IDaaS SP mode is still available only when the IDaaS application has registered a stable Liclick Service URL:

```env
IDAAS_JWT_SSO_ENABLED=true
IDAAS_SP_SERVICE_URL=<IDaaS registered Liclick callback URL>
```

Security notes:

- The frontend never receives Atlas tokens, IDaaS tokens, Feishu tokens, API keys, or raw session token values.
- The server stores only a hashed local session token.
- Atlas token contents are read only to derive a local display identity and Liclick API access.
- Homepage and local project browsing remain available when the server is offline or the user is logged out.
