# Liclick Atlas Login

Liclick uses the Atlas gateway login path by default. The UI route is still named `/api/auth/feishu/start` for compatibility, but the real login is `atlas-skillhub gateway login`.

## Local Flow

On a local machine, Atlas starts a listener at:

```text
http://localhost:20265/callback
```

The browser, Atlas CLI, and Liclick server are all on the same machine, so IDaaS can redirect back to that listener and Atlas writes `.atlas-ai-gateway-oauth.json`. Liclick then reads the Atlas cache and creates the local `liclick_3d_session` cookie.

## Server Flow

On a shared A100/Linux server, the user's browser is not on the server. If IDaaS redirects to `localhost:20265`, that means the user's computer, not A100.

Pure Atlas can still work on the server in two practical ways:

1. Use an SSH tunnel while logging in:

```bash
ssh -L 20265:127.0.0.1:20265 <user>@10.3.2.59
```

Then click `飞书登录` from the browser. When IDaaS redirects to `http://localhost:20265/callback`, the user's local port is forwarded to the Atlas listener on the server.

2. Use a server-side service account:

Run `atlas-skillhub gateway login` on the server once under the service user, then run Liclick with:

```env
ATLAS_LOGIN_MODE=service-token
LICLICK_ENABLE_ATLAS_LOCAL_LOGIN=true
IDAAS_JWT_SSO_ENABLED=false
```

This makes all users share the server's Atlas credential, so it is only appropriate when that billing and permission model is acceptable.

## Limits

The current Atlas CLI hardcodes callback port `20265` and does not expose a CLI option for changing it. That means pure Atlas interactive login on one shared server is effectively one login-at-a-time unless the Atlas package changes or IDaaS registers a different server callback flow.
