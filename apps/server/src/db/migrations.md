# Database Migrations

The local development database is `workspace/liclick.db` through Prisma SQLite.
Production can switch `DATABASE_URL` to PostgreSQL after the datasource provider is adjusted for deployment.

Initial setup:

```bash
corepack pnpm db:generate
corepack pnpm db:push
```

The current runtime auth/session foundation uses `workspace/auth.json` while the Prisma schema is introduced as the durable database contract for the next service-layer migration.
