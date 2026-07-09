import { downloadBlob, slugifyExportName } from '@/engine/export/exportUtils';

const imageExtensionByMimeType: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

function extensionFromUrl(url: string) {
  try {
    const pathname = new URL(url, window.location.href).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match?.[1]?.toLowerCase();
  } catch {
    const match = url.split('?')[0]?.match(/\.([a-z0-9]{2,5})$/i);
    return match?.[1]?.toLowerCase();
  }
}

function filenameWithExtension(filenameBase: string, extension?: string) {
  const safeBase = slugifyExportName(filenameBase);
  const safeExtension = extension?.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
  return `${safeBase}.${safeExtension}`;
}

function clickDownload(url: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export async function downloadImageAsset(url: string, filenameBase: string) {
  const fallbackExtension = extensionFromUrl(url) ?? 'png';
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download image (${response.status}).`);
    const blob = await response.blob();
    const extension = imageExtensionByMimeType[blob.type] ?? fallbackExtension;
    downloadBlob(blob, filenameWithExtension(filenameBase, extension));
  } catch (error) {
    console.warn('[Liclick 3D Texture] Falling back to direct image download:', error);
    clickDownload(url, filenameWithExtension(filenameBase, fallbackExtension));
  }
}
