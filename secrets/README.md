# Local Secrets

Put the real Atlas token cache here when deploying to A100:

```text
secrets/.atlas-ai-gateway-oauth.json
```

This file is intentionally ignored by git. The deployment script installs it into the Linux `liclick` service user's home directory.
