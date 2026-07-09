# Liclick Atlas Login

Liclick uses the Atlas gateway login path by default. The UI route is still named `/api/auth/feishu/start` for compatibility, but the real login is `atlas-skillhub gateway login`.

## Current Atlas Boundary

Atlas starts a callback listener at:

```text
http://localhost:20265/callback
```

This works locally because the browser, Atlas CLI, and Liclick server are on the same machine.

On a shared A100/Linux server, a user's browser is not on the server. If IDaaS redirects to `localhost:20265`, that means the user's computer, not A100. A web page cannot open a local TCP listener on the user's computer, so Liclick cannot silently capture that callback from a remote browser.

## Standard Enterprise Solutions

Large internal tools usually avoid this problem with one of these patterns:

1. **Server-side OAuth callback**
   The identity provider registers a stable HTTPS callback owned by the web app, such as `/api/auth/callback`. The backend exchanges the code/token and stores a server session. This is the normal web application model.

2. **Device authorization flow**
   The server creates a short-lived device code. The user scans or opens an IDaaS page on any device, while the server polls the identity provider until authorization completes. No localhost callback is required.

3. **Remote browser session**
   The server launches its own browser or browser automation session. The user sees/interacts with that server browser through the web app. Because the browser runs on the server, `localhost:20265` points to the server and Atlas receives the callback.

4. **Installed desktop helper**
   Native desktop apps can own localhost callbacks or custom URL schemes. This is normal for CLIs and desktop tools, but it is not a pure web solution.

## Current A100 Test Mode

For A100 testing, Liclick temporarily uses **service-token mode**. The server runs with:

```env
ATLAS_LOGIN_MODE=service-token
LICLICK_ENABLE_ATLAS_LOCAL_LOGIN=true
IDAAS_JWT_SSO_ENABLED=false
```

Install a real Atlas token cache for the Linux service user:

```bash
sudo bash scripts/linux-install-atlas-token.sh /path/to/.atlas-ai-gateway-oauth.json
sudo systemctl restart liclick-3d-texture.service
```

In this mode, all browser testers use the same Atlas / Liclick API credential. This is intentional for the temporary A100 test phase so AI image generation uses the real account permissions.

Local development remains interactive Atlas login and is not affected by the A100 deployment scripts.

## Future Product Path

For Liclick on A100, the better product path without IDaaS changes is **remote browser session**: start Atlas on the server, open the Atlas/IDaaS URL in a server-side browser, stream that browser view to the user, and let Atlas receive the server-local callback.
