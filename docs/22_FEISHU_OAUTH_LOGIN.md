# Feishu OAuth Login

Liclick 3D Texture does not block the projects homepage or the local 3D editor behind login. Login is required when a workflow needs Liclick AI API authorization, such as Generate Image.

Flow:

1. User clicks the homepage account login button or an AI feature that requires login.
2. Frontend calls `GET /api/auth/feishu/start`.
3. Server creates an OAuth `state` and returns a Feishu authorization URL.
4. Browser redirects to Feishu `/authen/v1/authorize` with `app_id`, `redirect_uri`, and `state`.
5. Feishu redirects back to `GET /api/auth/feishu/callback?code=...&state=...`.
6. Server validates `state`, obtains a Feishu `app_access_token` from `/auth/v3/app_access_token/internal`, exchanges `code` at `/authen/v1/access_token`, fetches Feishu user info, and maps name/avatar/email/open IDs into the local user store.
7. Server sets the Liclick session cookie as `httpOnly`, `SameSite=Lax`.
8. Frontend uses `GET /api/auth/me` to show the Feishu avatar and display name.

The frontend never receives Feishu access tokens or refresh tokens. Feishu secrets must only come from server-side runtime configuration.
