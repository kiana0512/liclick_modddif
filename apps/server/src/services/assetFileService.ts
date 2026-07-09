import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serverConfig } from '../config.js';
import type { AssetCategory, SavedAsset } from '../types/asset.js';
import { findProjectSlug } from './projectFileService.js';
import { ensureDir, getUserProjectDir, slugify, toWorkspaceUrl } from './workspaceService.js';

const allowedCategories: AssetCategory[] = ['models', 'references', 'captures', 'generations', 'layers', 'baked'];
const maxRemoteAssetBytes = 25 * 1024 * 1024;
export const maxLocalAssetBytes = 160 * 1024 * 1024;
const allowedRemoteAssetHosts = new Set([
  'ai-assets.lilithgames.com',
  ...serverConfig.allowedRemoteAssetHosts,
]);

function extensionFromMime(mime: string) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'model/gltf-binary') return 'glb';
  if (mime === 'application/octet-stream') return 'bin';
  return 'bin';
}

function parseDataUrl(dataUrl: string) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Invalid data URL.');
  const mime = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';
  return {
    mime,
    buffer: isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8'),
  };
}

function safeAssetName(filename: string, fallbackExtension: string) {
  const parsed = path.parse(filename);
  const base = slugify(parsed.name || 'asset');
  const extension = (parsed.ext || `.${fallbackExtension}`).replace(/[^a-z0-9.]/gi, '').toLowerCase();
  return `${base}${extension || `.${fallbackExtension}`}`;
}

function assertAllowedRemoteUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS remote assets can be imported.');
  if (!allowedRemoteAssetHosts.has(parsed.hostname)) {
    throw new Error(`Remote asset host is not allowed: ${parsed.hostname}`);
  }
  return parsed;
}

async function fetchRemoteImage(url: string) {
  const controller = new AbortController();
  const timeout = delay(30_000, undefined, { signal: controller.signal })
    .then(() => {
      controller.abort();
    })
    .catch(() => undefined);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Remote asset request failed: ${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!contentType.startsWith('image/')) throw new Error('Remote asset is not an image.');
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > maxRemoteAssetBytes) throw new Error('Remote asset is too large.');
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxRemoteAssetBytes) throw new Error('Remote asset is too large.');
    return { mime: contentType, buffer: Buffer.from(arrayBuffer) };
  } finally {
    controller.abort();
    void timeout;
  }
}

async function writeAsset(input: {
  userId: string;
  projectId: string;
  category: AssetCategory;
  filename: string;
  mime: string;
  buffer: Buffer;
}) {
  if (!allowedCategories.includes(input.category)) throw new Error('Invalid asset category.');
  const slug = await findProjectSlug(input.userId, input.projectId);
  if (!slug) return undefined;
  const name = safeAssetName(input.filename, extensionFromMime(input.mime));
  const relativePath = path.posix.join('assets', input.category, name);
  const absolutePath = path.join(getUserProjectDir(input.userId, slug), 'assets', input.category, name);
  await ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, input.buffer);
  return {
    category: input.category,
    relativePath,
    url: toWorkspaceUrl(path.join('users', input.userId, 'projects', slug, relativePath)),
  };
}

export async function saveDataUrlAsset(input: {
  userId: string;
  projectId: string;
  category: AssetCategory;
  dataUrl: string;
  filename: string;
}): Promise<SavedAsset | undefined> {
  const { mime, buffer } = parseDataUrl(input.dataUrl);
  return writeAsset({ ...input, mime, buffer });
}

export async function saveBinaryAsset(input: {
  userId: string;
  projectId: string;
  category: AssetCategory;
  mime: string;
  buffer: Buffer;
  filename: string;
}): Promise<SavedAsset | undefined> {
  if (input.buffer.byteLength > maxLocalAssetBytes) throw new Error('Asset is too large.');
  return writeAsset(input);
}

export async function saveRemoteImageAsset(input: {
  userId: string;
  projectId: string;
  category: AssetCategory;
  url: string;
  filename: string;
}): Promise<SavedAsset | undefined> {
  assertAllowedRemoteUrl(input.url);
  const { mime, buffer } = await fetchRemoteImage(input.url);
  return writeAsset({ ...input, mime, buffer });
}
