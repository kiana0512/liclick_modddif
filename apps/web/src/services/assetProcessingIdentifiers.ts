export async function stableAsciiAssetIdentity(value: string) {
  if (/^[\x21-\x7E]+$/.test(value)) {
    return value;
  }

  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `li3d-sha256-${hex}`;
}
