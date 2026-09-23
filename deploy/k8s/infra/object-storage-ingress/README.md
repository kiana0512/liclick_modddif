# Object storage (Ceph RGW) — HTTPS front door + credentials

The internal Ceph RGW is `http://10.104.151.13:7480`: plain HTTP only (no
TLS on 7480 or 7481) at an RFC1918 address. The app hands presigned URLs
straight to the browser (`putDirectAsset` in
`apps/web/src/services/workspaceApiClient.ts`), so that endpoint can't be
used directly — an https page can't upload to an http URL (mixed content),
and not every client can route to a private IP.

`object-storage.yaml` fronts it with an ingress on
`li3d-s3.lilithgames.com`, which is what `LICLICK_OBJECT_STORAGE_ENDPOINT`
in `deploy/k8s/base/server-config.env` points at.

## Credentials (not in git, not in CI)

Endpoint and bucket are plain config in `server-config.env`. The AK/SK are
in a Secret created once, directly in the cluster — deliberately not in
`server-config.env` (that file is git-tracked, so the key would be in
history forever) and not in CI/CD variables either:

```bash
kubectl --context zprod -n li3d create secret generic li3d-object-storage \
  --from-literal=LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID=<ak> \
  --from-literal=LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY=<sk>
```

`deploy/k8s/base/server-deployment.yaml` pulls it in with a second
`envFrom.secretRef`, alongside the CI-generated `li3d-server-secrets`.
Rotating the keys means re-running the command above (with
`--dry-run=client -o yaml | kubectl apply -f -` to overwrite) and
restarting the deployment — no pipeline run needed.

## Verified 2026-09-03

- Signed LIST / PUT / GET / DELETE round trip through the ingress, using
  the same SigV4 code path as `s3PresignedUrlService.ts` — signatures
  survive the proxy because ingress-nginx passes the original `Host`
  through unchanged. Do not add a Host-rewriting annotation.
- CORS preflight (`OPTIONS` with `Origin: https://li3d.lilithgames.com`,
  `Access-Control-Request-Method: PUT`) returns 204 with all three signed
  upload headers allowed.

## TLS caveat

Uses the `*.lilithgames.com` wildcard cert copied from
`zstack-middleware/lilithgames.com` into this namespace as
`li3d-s3-tls-wildcard` — a manual copy that will go stale. cert-manager
can't issue anything in this cluster right now: its Aliyun DNS-01
credential is disabled (`InvalidAccessKeyId.Inactive`). That wildcard
expires 2026-10-12 and tries to renew ~2026-09-12, which will also fail
until the credential is fixed.
