# li3d Postgres (zprod)

Self-hosted PostgreSQL for `LICLICK_CLOUD_DATABASE_URL` — no shared
self-service DB platform exists in this cluster (checked: no Postgres
operator CRDs; the only other Postgres found was `liyops-vm`'s own
instance, not for other teams). Single instance, `li3d` namespace,
`zstack-csi-rbd` PVC.

## First-time setup (already done 2026-09-03 — reference for next time)

```bash
kubectl --context zprod -n li3d create secret generic postgres-credentials \
  --from-literal=POSTGRES_USER=li3d \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')" \
  --from-literal=POSTGRES_DB=li3d

kubectl --context zprod apply -f deploy/k8s/infra/postgres/statefulset.yaml
kubectl --context zprod -n li3d rollout status statefulset/postgres

# Schema: the app's own db-push initContainer runs
# apps/server/scripts/migrate-cloud-projects.mjs (the 3 files in
# apps/server/sql/) automatically on every server pod start — nothing to
# do here beyond setting LICLICK_CLOUD_DATABASE_URL (below). To hand-verify:
for f in apps/server/sql/001_project_documents_postgres.sql \
         apps/server/sql/002_shared_control_plane.sql \
         apps/server/sql/003_performance_lab_sessions.sql; do
  kubectl --context zprod -n li3d exec -i postgres-0 -- \
    psql -h 127.0.0.1 -U li3d -d li3d -v ON_ERROR_STOP=1 < "$f"
done
```

## Set the CI/CD variable

`LICLICK_CLOUD_DATABASE_URL` (masked + protected, li3d project Settings →
CI/CD → Variables):

```
postgresql://li3d:<the POSTGRES_PASSWORD you set above>@postgres:5432/li3d
```

`postgres` resolves via in-cluster DNS because the server pods run in the
same `li3d` namespace — no FQDN needed.

## Gotcha that cost real debugging time — read before touching securityContext

This image's postgres user is **uid/gid 70**, not the 999 many other
images use (999 exists in this image too, but belongs to an unrelated
`ping` group from iputils — pure coincidence, not postgres). Getting this
wrong doesn't fail loudly: postgres itself starts and is genuinely
reachable (`psql` works), but `pg_isready` reports `PQPING_NO_ATTEMPT`
("no attempt" — a client-side failure, not connection-refused) because
libpq can't access files/dirs actually owned by `postgres:postgres` (70:70)
while running as a mismatched uid. The result is a crash loop where the
liveness probe kills an otherwise-healthy container. Confirm with
`kubectl exec ... -- id` if this ever needs touching again — don't assume
uid 999 from having seen it elsewhere.

## Backup

Nothing here backs this up. Before this holds real user data, put a
`pg_dump` cronjob or volume-snapshot policy in front of it — see the same
caveat already in `deploy/README.md` for the workspace PVC.
