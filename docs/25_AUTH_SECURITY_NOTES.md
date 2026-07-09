# Auth Security Notes

- Real AI access uses the local Liclick / Atlas gateway flow, not Feishu Open Platform OAuth.
- The app does not require Feishu app ID, app secret, Open Platform callback URLs, or robot permissions.
- The frontend never receives Atlas access tokens, Feishu tokens, API keys, or raw session token values.
- Server-side login reads the local Atlas token cache only to derive display identity and Liclick API access status.
- Liclick session cookies are `httpOnly`, `SameSite=Lax`, configurable `Secure`, and scoped to `/`.
- The server stores only a hashed local session token.
- Runtime state is ignored by Git: `workspace/auth.json`, `workspace/*.db`, `workspace/users/`, `workspace/projects/`, `workspace/trash/`, logs, and TypeScript build info.
- AI generation actions require login because they depend on the Liclick API user context.
- Homepage and local project browsing remain visible without login.
- Production or Linux/A100 deployment must set a non-dev `SESSION_SECRET`, enable HTTPS, and set `SESSION_COOKIE_SECURE=true` behind TLS.
- The current Atlas identity claims provide name and email. Avatar currently falls back to a deterministic local avatar unless a trusted avatar/profile endpoint is added.
- Before each Liclick generation request, the server compares the browser session email with the current Atlas identity email. A mismatch returns `403` instead of silently using the wrong user's Liclick account.
- A shared production host must not depend on one machine-global Atlas token for unrelated real users unless that is an intentional service-account design. True per-user billing and permission isolation requires a per-user Atlas credential/session boundary or a server-side token exchange that can select the correct Liclick identity per request.
