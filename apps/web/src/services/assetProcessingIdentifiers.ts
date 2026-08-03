/**
 * Asset V4 requires request and idempotency identifiers to contain printable
 * ASCII only. Model filenames may contain Chinese characters, so derive a
 * stable opaque identifier before sending the request while keeping the
 * original filename in the file upload and history metadata.
 */
export async function stableAsciiAssetIdentity(value: string) {
  if (/^[\x21-\x7e]+$/.test(value)) {
    return value;
  }

  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    try {
      const digest = new Uint8Array(
        await globalThis.crypto.subtle.digest('SHA-256', bytes),
      );
      const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return `li3d-sha256-${hex}`;
    } catch {
      // Company LAN HTTP is not a secure context in every Chromium version.
      // Fall through to a deterministic ASCII-only digest in that case.
    }
  }

  const mask64 = 0xffffffffffffffffn;
  const prime = 0x100000001b3n;
  let first = 0xcbf29ce484222325n;
  let second = 0x84222325cbf29ce4n;
  for (const byte of bytes) {
    first = ((first ^ BigInt(byte)) * prime) & mask64;
    second = ((second ^ BigInt(byte)) * prime) & mask64;
  }
  return `li3d-hash128-${first.toString(16).padStart(16, '0')}${second
    .toString(16)
    .padStart(16, '0')}`;
}
