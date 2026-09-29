import crypto from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serverConfig } from '../config.js';
import { projectRepository } from '../repositories/projectRepository.js';
import type { AssetCategory, SavedAsset } from '../types/asset.js';
import { writeFileAtomically } from './atomicFileService.js';
import {
  runWithWorkspaceAssetMutationLock,
  workspaceAssetMutationKey,
} from './workspaceAssetMutationCoordinator.js';
import {
  ensureDir,
  getUserDir,
  getUserProjectDir,
  slugify,
  toWorkspaceUrl,
} from './workspaceService.js';

const allowedCategories: AssetCategory[] = ['models', 'references', 'captures', 'generations', 'layers', 'baked'];
// GPT 2K/4K PNG results can exceed 25 MiB even though they are valid images.
// The host is HTTPS allowlisted below, so keep the same bounded ceiling used
// for local binary assets instead of silently leaving a short-lived URL.
const maxRemoteAssetBytes = 160 * 1024 * 1024;
export const maxLocalAssetBytes = 160 * 1024 * 1024;
const allowedRemoteAssetHosts = new Set([
  'ai-assets.lilithgames.com',
  'tsh-aiteam-prod-all.oss-accelerate.aliyuncs.com',
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

function uniqueAssetName(filename: string, fallbackExtension: string) {
  const safeName = safeAssetName(filename, fallbackExtension);
  const parsed = path.parse(safeName);
  return `${parsed.name}-${crypto.randomUUID()}${parsed.ext}`;
}

function assertAllowedRemoteUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS remote assets can be imported.');
  if (parsed.port || parsed.username || parsed.password) {
    throw new Error('Remote asset URL must use standard HTTPS without embedded credentials.');
  }
  if (!allowedRemoteAssetHosts.has(parsed.hostname)) {
    throw new Error(`Remote asset host is not allowed: ${parsed.hostname}`);
  }
  return parsed;
}

export async function fetchAllowedRemoteImage(url: string, maxBytes = maxRemoteAssetBytes) {
  const limit = Math.min(maxRemoteAssetBytes, maxBytes);
  if (url.startsWith('data:')) {
    if (!/^data:image\//i.test(url) || Buffer.byteLength(url, 'utf8') > Math.ceil(limit * 4 / 3) + 1024) {
      throw new Error('Remote asset is not an allowed image.');
    }
  } else {
    assertAllowedRemoteUrl(url);
  }
  const controller = new AbortController();
  const timeout = delay(30_000, undefined, { signal: controller.signal })
    .then(() => {
      controller.abort();
    })
    .catch(() => undefined);
  try {
    let currentUrl = url;
    let response: Response | undefined;
    for (let hop = 0; hop <= 3; hop++) {
      response = await fetch(currentUrl, { signal: controller.signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location || hop === 3) throw new Error('Remote asset redirect limit reached.');
      const nextUrl = new URL(location, currentUrl).href;
      assertAllowedRemoteUrl(nextUrl);
      await response.body?.cancel();
      currentUrl = nextUrl;
    }
    if (!response) throw new Error('Remote asset request failed.');
    if (!response.ok) throw new Error(`Remote asset request failed: ${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!contentType.startsWith('image/')) throw new Error('Remote asset is not an image.');
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > limit) throw new Error('Remote asset is too large.');
    if (!response.body) throw new Error('Remote asset has no image body.');
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        totalBytes += buffer.byteLength;
        if (totalBytes > limit) throw new Error('Remote asset is too large.');
        chunks.push(buffer);
      }
    } finally {
      reader.releaseLock();
    }
    return { mime: contentType, buffer: Buffer.concat(chunks, totalBytes) };
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
  const slug = await projectRepository.findSlug(input.userId, input.projectId);
  if (!slug) return undefined;
  // Project assets are immutable records. Keeping every upload on a unique
  // path prevents concurrent model/reference restoration from attempting to
  // replace the same Windows file, which otherwise surfaces as EPERM during
  // the temporary-file rename.
  const name = uniqueAssetName(input.filename, extensionFromMime(input.mime));
  const relativePath = path.posix.join('assets', input.category, name);
  const absolutePath = path.join(getUserProjectDir(input.userId, slug), 'assets', input.category, name);
  await runWithWorkspaceAssetMutationLock(
    workspaceAssetMutationKey({
      userId: input.userId,
      projectSlug: slug,
      category: input.category,
    }),
    async () => {
      await ensureDir(path.dirname(absolutePath));
      await writeFileAtomically(absolutePath, input.buffer);
    },
  );
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

export async function saveUserRecoveryAsset(input: {
  userId: string;
  mime: string;
  buffer: Buffer;
  filename: string;
}): Promise<SavedAsset> {
  if (input.buffer.byteLength > maxLocalAssetBytes) throw new Error('Asset is too large.');
  const name = safeAssetName(input.filename, extensionFromMime(input.mime));
  const relativePath = path.posix.join('recoveries', 'modelview-inpaint', name);
  const absolutePath = path.join(getUserDir(input.userId), relativePath);
  await ensureDir(path.dirname(absolutePath));
  await writeFileAtomically(absolutePath, input.buffer);
  return {
    category: 'generations',
    relativePath,
    url: toWorkspaceUrl(path.join('users', input.userId, relativePath)),
  };
}

export async function saveRemoteImageAsset(input: {
  userId: string;
  projectId: string;
  category: AssetCategory;
  url: string;
  filename: string;
}): Promise<SavedAsset | undefined> {
  assertAllowedRemoteUrl(input.url);
  const { mime, buffer } = await fetchAllowedRemoteImage(input.url);
  return writeAsset({ ...input, mime, buffer });
}
