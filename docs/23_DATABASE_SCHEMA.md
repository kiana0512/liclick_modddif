# Database Schema

`apps/server/prisma/schema.prisma` defines the durable data model for local SQLite and future server deployment.

Primary entities:

- `User`: local Liclick user record, fed by dev-mock or Feishu OAuth.
- `FeishuAccount`: Feishu identifiers and profile fields linked to a local user.
- `UserSession`: hashed session tokens only. Plain session tokens are never stored.
- `ProjectFolder`, `Project`, `ProjectAsset`, `GenerationJob`: all include `userId` for isolation.
- `ApiAuditLog`: future API request audit trail.

Local setup:

```bash
corepack pnpm db:generate
corepack pnpm db:push
```

Current runtime still uses JSON stores for auth/session and file-backed projects while the Prisma schema establishes the database contract for the next migration step.
