import { createHash } from 'node:crypto';
import { pinyin } from 'pinyin-pro';

const maximumDisplayCodePoints = 240;
const maximumSafeBytes = 120;
const defaultDisplayFallback = 'asset';

const englishTerms = new Map<string, string>([
  ['高模', 'high-poly'],
  ['低模', 'low-poly'],
  ['模型', 'model'],
  ['测试', 'test'],
  ['合集', 'collection'],
  ['烘焙', 'baked'],
  ['拓扑', 'retopology'],
  ['贴图', 'texture'],
  ['正面', 'front'],
  ['侧面', 'side'],
  ['顶面', 'top'],
]);

const englishTermPattern = /高模|低模|模型|测试|合集|烘焙|拓扑|贴图|正面|侧面|顶面/g;
const windowsReservedStem = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[._-]|$)/i;

function textValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function cleanDisplayCandidate(value: unknown) {
  const normalized = textValue(value)
    .normalize('NFC')
    // Cc removes C0/C1 controls; Cf removes bidi overrides, isolates and other
    // invisible format characters that should never participate in a name.
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll('\\', '/');
  const basename = normalized.split('/').at(-1)?.trim() ?? '';
  if (!basename || basename === '.' || basename === '..') return '';
  return Array.from(basename).slice(0, maximumDisplayCodePoints).join('');
}

/**
 * Return the user-facing basename. This value may contain Chinese characters
 * and is intended for UI/history only; it must never be used as a disk path.
 */
export function displayFilename(value: unknown, fallback: string) {
  return (
    cleanDisplayCandidate(value) ||
    cleanDisplayCandidate(fallback) ||
    defaultDisplayFallback
  );
}

type FilenameParts = {
  displayName: string;
  stem: string;
  extension: string;
};

function splitFilename(value: unknown, fallback: string): FilenameParts {
  const displayName = displayFilename(value, fallback);
  const fallbackDisplay = displayFilename(fallback, defaultDisplayFallback);
  const fallbackExtension = safeExtension(fallbackDisplay);
  const extension = safeExtension(displayName) || fallbackExtension;
  const stem = removeSafeExtension(displayName);
  return { displayName, stem, extension };
}

function safeExtension(value: string) {
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return '';
  const extension = value.slice(dot + 1);
  return /^[a-z0-9]{1,12}$/i.test(extension) ? `.${extension.toLowerCase()}` : '';
}

function removeSafeExtension(value: string) {
  const extension = safeExtension(value);
  return extension ? value.slice(0, -extension.length) : value;
}

function translatedAsciiStem(value: string) {
  const containsNonAscii = Array.from(value).some(
    (character) => (character.codePointAt(0) ?? 0) > 0x7f,
  );
  const withEnglishTerms = value
    .normalize('NFKC')
    .replace(englishTermPattern, (term) => ` ${englishTerms.get(term) ?? term} `);
  const transliterated = pinyin(withEnglishTerms, {
    toneType: 'none',
    type: 'string',
    separator: '-',
    nonZh: 'consecutive',
    v: true,
  })
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  return (containsNonAscii
    ? transliterated.replace(/[^a-z0-9]+/g, '-')
    : transliterated.replace(/[^a-z0-9._-]+/g, '-'))
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
}

function nonAsciiHash(displayName: string) {
  return Array.from(displayName).some(
    (character) => (character.codePointAt(0) ?? 0) > 0x7f,
  )
    ? createHash('sha256').update(displayName, 'utf8').digest('hex').slice(0, 8)
    : '';
}

function safeFallbackStem(fallback: string) {
  const fallbackDisplay = displayFilename(fallback, defaultDisplayFallback);
  return translatedAsciiStem(removeSafeExtension(fallbackDisplay)) || defaultDisplayFallback;
}

function trimAsciiStem(stem: string, maximumBytes: number) {
  const limit = Math.max(1, maximumBytes);
  const trimmed = Buffer.from(stem, 'ascii').subarray(0, limit).toString('ascii');
  return trimmed.replace(/[._-]+$/g, '');
}

function buildSafeStem(value: unknown, fallback: string, extensionBytes: number) {
  const { displayName, stem } = splitFilename(value, fallback);
  let base = translatedAsciiStem(stem) || safeFallbackStem(fallback);
  if (windowsReservedStem.test(base)) base = `asset-${base}`;

  const hash = nonAsciiHash(displayName);
  const suffix = hash ? `-${hash}` : '';
  const budget = maximumSafeBytes - extensionBytes - Buffer.byteLength(suffix, 'ascii');
  base = trimAsciiStem(base, budget) || defaultDisplayFallback;
  if (windowsReservedStem.test(base)) {
    base = trimAsciiStem(`asset-${base}`, budget) || defaultDisplayFallback;
  }
  return `${base}${suffix}`;
}

/** Return an ASCII-only, lowercase, path-safe stem without an extension. */
export function englishSafeStem(value: unknown, fallback: string) {
  return buildSafeStem(value, fallback, 0);
}

/**
 * Return an ASCII-only filename suitable for multipart, disk and output names.
 * A safe lowercase extension is kept separately from the transliterated stem.
 */
export function englishSafeFilename(value: unknown, fallback: string) {
  const { extension } = splitFilename(value, fallback);
  const stem = buildSafeStem(value, fallback, Buffer.byteLength(extension, 'ascii'));
  return `${stem}${extension}`;
}
