const wireTokenMaximumLength = 120;

function asciiExtension(fileName: string) {
  const match = /\.([a-z0-9]{1,12})$/i.exec(fileName);
  return match ? `.${match[1].toLowerCase()}` : '.bin';
}

function asciiIdentityToken(identity: string) {
  const normalized = identity
    .normalize('NFKC')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) return 'asset';
  if (normalized.length <= wireTokenMaximumLength) return normalized;
  return `${normalized.slice(0, 48)}-${normalized.slice(-64)}`;
}

export function retopologyWireFileNames(input: {
  externalAssetId: string;
  highModelName: string;
  referenceImageNames: string[];
}) {
  const identity = asciiIdentityToken(input.externalAssetId);
  return {
    highModel: `li3d-model-${identity}${asciiExtension(input.highModelName)}`,
    referenceImages: input.referenceImageNames.map(
      (fileName, index) =>
        `li3d-reference-${String(index + 1).padStart(3, '0')}-${identity}${asciiExtension(fileName)}`,
    ),
  };
}
