export const ASSET_TRANSFER_PROTOCOL_VERSION = 1 as const;
export const MAX_DIRECT_ASSET_BYTES = 160 * 1024 * 1024;

export const ASSET_CATEGORIES = [
  'models',
  'references',
  'captures',
  'generations',
  'layers',
  'baked',
] as const;

export type AssetTransferCategory = (typeof ASSET_CATEGORIES)[number];

export type CreateAssetUploadIntent = {
  protocolVersion: typeof ASSET_TRANSFER_PROTOCOL_VERSION;
  category: AssetTransferCategory;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

export type CompleteAssetUploadIntent = {
  protocolVersion: typeof ASSET_TRANSFER_PROTOCOL_VERSION;
  assetId: string;
  sha256: string;
};

export type AssetUploadIntent = {
  protocolVersion: typeof ASSET_TRANSFER_PROTOCOL_VERSION;
  intentId: string;
  assetId: string;
  projectId: string;
  category: AssetTransferCategory;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  upload: {
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
    expiresAt: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readProtocolVersion(record: Record<string, unknown>) {
  if (record.protocolVersion !== ASSET_TRANSFER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported asset transfer protocol: ${String(record.protocolVersion)}.`);
  }
}

function readSha256(record: Record<string, unknown>) {
  const value = record.sha256;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Asset sha256 must be 64 lowercase hexadecimal characters.');
  }
  return value;
}

export function parseCreateAssetUploadIntent(value: unknown): CreateAssetUploadIntent {
  if (!isRecord(value)) throw new Error('Asset upload intent must be an object.');
  readProtocolVersion(value);
  if (!ASSET_CATEGORIES.includes(value.category as AssetTransferCategory)) {
    throw new Error('Asset category is invalid.');
  }
  const filename = typeof value.filename === 'string' ? value.filename.trim() : '';
  if (!filename || filename.length > 240 || /[\\/\0]/.test(filename)) {
    throw new Error('Asset filename is invalid.');
  }
  const mimeType = typeof value.mimeType === 'string' ? value.mimeType.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)) {
    throw new Error('Asset mimeType is invalid.');
  }
  if (
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    value.sizeBytes > MAX_DIRECT_ASSET_BYTES
  ) {
    throw new Error(`Asset sizeBytes must be between 1 and ${MAX_DIRECT_ASSET_BYTES}.`);
  }
  return {
    protocolVersion: ASSET_TRANSFER_PROTOCOL_VERSION,
    category: value.category as AssetTransferCategory,
    filename,
    mimeType,
    sizeBytes: value.sizeBytes,
    sha256: readSha256(value),
  };
}

export function parseCompleteAssetUploadIntent(value: unknown): CompleteAssetUploadIntent {
  if (!isRecord(value)) throw new Error('Asset upload completion must be an object.');
  readProtocolVersion(value);
  const assetId = typeof value.assetId === 'string' ? value.assetId.trim() : '';
  if (!/^asset-[a-zA-Z0-9_-]{8,128}$/.test(assetId)) {
    throw new Error('Asset assetId is invalid.');
  }
  return {
    protocolVersion: ASSET_TRANSFER_PROTOCOL_VERSION,
    assetId,
    sha256: readSha256(value),
  };
}
