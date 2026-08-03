import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';

// Public trust anchor for the internal GPU Control HTTPS gateway.
// External CA configuration still takes priority so operations can rotate it.
export const gpuControlLanCa = `-----BEGIN CERTIFICATE-----
MIIBjjCCATWgAwIBAgIUbcNtJ+q41V8JP+32UBHja0qyht4wCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSR1BVIENvbnRyb2wgTEFOIENBMB4XDTI2MDcyMjEwMjcxMloX
DTM2MDcxOTEwMjcxMlowHTEbMBkGA1UEAwwSR1BVIENvbnRyb2wgTEFOIENBMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWDo363RqKMbGVHiT3PlVj38qIYRljR9H
d0ACo8GQldIcOkgr/RZJ9g66H0S8g+2D1pkhBL+q5/b3/dgWsriHnqNTMFEwHQYD
VR0OBBYEFBrWe2qbs9IVqs4mHNPgvFIVxY4sMB8GA1UdIwQYMBaAFBrWe2qbs9IV
qs4mHNPgvFIVxY4sMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIg
bxvaSKEhA3wvBP7lvTGywZsBtOBbr3WF7ZVhplcUJxgCIGbYhCTXXgqQDnYJAwPQ
3FmyznnIDkhQFrhP+ucVXO1k
-----END CERTIFICATE-----`;

export const gpuControlLanCaFilename = 'GPU_CONTROL_LAN_CA.crt';
export const gpuControlLanCaExpectedSha256 =
  'ad4a4dbd95bb789be03451ff0c25b2bc65dfe170428bd675789c2ebba1e6dc2b';

export type ValidatedGpuControlLanCa = {
  bytes: Buffer;
  certificate: X509Certificate;
  sha256: string;
};

export function embeddedGpuControlLanCaBytes() {
  return Buffer.from(`${gpuControlLanCa}\n`, 'utf8');
}

export function validateGpuControlLanCaBytes(bytes: Buffer): ValidatedGpuControlLanCa {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== gpuControlLanCaExpectedSha256) {
    throw new Error(
      `GPU Control LAN CA SHA-256 mismatch: expected ${gpuControlLanCaExpectedSha256}, received ${sha256}.`,
    );
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(bytes);
  } catch (error) {
    throw new Error(
      `GPU Control LAN CA is not a valid X.509 certificate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!certificate.ca) {
    throw new Error('GPU Control LAN CA certificate is not marked as a certificate authority.');
  }
  return { bytes, certificate, sha256 };
}

/**
 * Materialize the bundled trust anchor at the managed workspace path before
 * the HTTP server starts listening. Explicit operator-provided paths are not
 * managed and must never be overwritten by this helper.
 */
export async function materializeGpuControlLanCa(
  certificatePath: string,
  managed: boolean,
) {
  if (!managed) return;

  const embedded = validateGpuControlLanCaBytes(embeddedGpuControlLanCaBytes()).bytes;
  try {
    const current = await fs.promises.readFile(certificatePath);
    validateGpuControlLanCaBytes(current);
    return;
  } catch {
    // Missing or stale managed certificates are repaired from the pinned copy.
  }

  await fs.promises.mkdir(path.dirname(certificatePath), { recursive: true });
  const temporaryPath = `${certificatePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, embedded, { flag: 'wx' });
    validateGpuControlLanCaBytes(await fs.promises.readFile(temporaryPath));
    await fs.promises.rename(temporaryPath, certificatePath);
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
