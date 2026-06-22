import fs from 'node:fs/promises';
import path from 'node:path';
import type { AssetCategory, SavedAsset } from '../types/asset.js';
import { findProjectSlug } from './projectFileService.js';
import { ensureDir, getUserProjectDir, slugify, toWorkspaceUrl } from './workspaceService.js';

const allowedCategories: AssetCategory[] = ['models', 'references', 'captures', 'generations', 'layers', 'baked'];

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

export async function saveDataUrlAsset(input: {
  userId: string;
  projectId: string;
  category: AssetCategory;
  dataUrl: string;
  filename: string;
}): Promise<SavedAsset | undefined> {
  if (!allowedCategories.includes(input.category)) throw new Error('Invalid asset category.');
  const slug = await findProjectSlug(input.userId, input.projectId);
  if (!slug) return undefined;
  const { mime, buffer } = parseDataUrl(input.dataUrl);
  const name = safeAssetName(input.filename, extensionFromMime(mime));
  const relativePath = path.posix.join('assets', input.category, name);
  const absolutePath = path.join(getUserProjectDir(input.userId, slug), 'assets', input.category, name);
  await ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, buffer);
  return {
    category: input.category,
    relativePath,
    url: toWorkspaceUrl(path.join('users', input.userId, 'projects', slug, relativePath)),
  };
}
