# Local Secrets

Put the real Atlas token cache here when deploying to A100:

```text
secrets/.atlas-ai-gateway-oauth.json
```

This file is intentionally ignored by git. The deployment script installs it into the Linux `liclick` service user's home directory.

For Windows local development, configure Feishu directory avatar enrichment with:

```powershell
corepack pnpm configure:dev:feishu
```

The command securely prompts for the Feishu Platform App Secret and writes
`secrets/li3d-dev.env`. The root one-click development command automatically
loads this gitignored file. Dedicated `FEISHU_PLATFORM_APP_ID/SECRET` values
do not enable a second local Web OAuth callback; local login continues through
Atlas while user profiles and avatars come from the same Feishu directory API
as the production service.
