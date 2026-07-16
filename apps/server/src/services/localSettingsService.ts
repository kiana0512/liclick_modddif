import fs from 'node:fs/promises';
import path from 'node:path';
import { serverConfig } from '../config.js';

export type LocalProfile = {
  customId: string;
  avatarDataUrl?: string;
};

export type ShortcutBinding = {
  code: string;
  primary?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ShortcutOverrides = Record<string, ShortcutBinding[]>;

type LocalSettingsDocument = {
  version: 1;
  activeUserId: string;
  performanceTestModeEnabled: boolean;
  performanceTestModeConfigured: boolean;
  profiles: Record<string, LocalProfile>;
  shortcutsByUser: Record<string, ShortcutOverrides>;
  shortcutsConfiguredByUser: Record<string, boolean>;
};

export type LocalSettingsView = {
  version: 1;
  activeUserId: string;
  performanceTestModeEnabled: boolean;
  performanceTestModeConfigured: boolean;
  profile: LocalProfile;
  shortcutOverrides: ShortcutOverrides;
  shortcutOverridesConfigured: boolean;
};

const defaultDocument: LocalSettingsDocument = {
  version: 1,
  activeUserId: 'anonymous',
  performanceTestModeEnabled: false,
  performanceTestModeConfigured: false,
  profiles: {},
  shortcutsByUser: {},
  shortcutsConfiguredByUser: {},
};

let writeQueue = Promise.resolve();

function normalizeUserId(value?: string) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 200 ? trimmed : 'anonymous';
}

function normalizeProfile(value: unknown): LocalProfile {
  if (!value || typeof value !== 'object') return { customId: '' };
  const candidate = value as Record<string, unknown>;
  const customId = typeof candidate.customId === 'string' ? candidate.customId.trim().slice(0, 24) : '';
  const avatarDataUrl =
    typeof candidate.avatarDataUrl === 'string' &&
    /^data:image\/(?:png|jpeg|webp);base64,/i.test(candidate.avatarDataUrl) &&
    candidate.avatarDataUrl.length <= 3_000_000
      ? candidate.avatarDataUrl
      : undefined;
  return { customId, ...(avatarDataUrl ? { avatarDataUrl } : {}) };
}

function normalizeShortcuts(value: unknown): ShortcutOverrides {
  if (!value || typeof value !== 'object') return {};
  const result: ShortcutOverrides = {};
  for (const [actionId, bindings] of Object.entries(value)) {
    if (!/^[a-z]+(?:\.[A-Za-z]+)+$/.test(actionId) || !Array.isArray(bindings)) continue;
    const nextBindings = bindings.flatMap((binding) => {
      if (!binding || typeof binding !== 'object') return [];
      const candidate = binding as Record<string, unknown>;
      if (typeof candidate.code !== 'string' || candidate.code.length > 80) return [];
      return [{
        code: candidate.code,
        ...(candidate.primary === true ? { primary: true } : {}),
        ...(candidate.shift === true ? { shift: true } : {}),
        ...(candidate.alt === true ? { alt: true } : {}),
      }];
    });
    result[actionId] = nextBindings.slice(0, 4);
  }
  return result;
}

function normalizeDocument(value: unknown): LocalSettingsDocument {
  if (!value || typeof value !== 'object') return structuredClone(defaultDocument);
  const candidate = value as Record<string, unknown>;
  const activeUserId = normalizeUserId(
    typeof candidate.activeUserId === 'string' ? candidate.activeUserId : undefined,
  );
  const profiles = Object.fromEntries(
    Object.entries(candidate.profiles && typeof candidate.profiles === 'object' ? candidate.profiles : {})
      .slice(0, 50)
      .map(([userId, profile]) => [normalizeUserId(userId), normalizeProfile(profile)]),
  );
  const shortcutsByUser = Object.fromEntries(
    Object.entries(
      candidate.shortcutsByUser && typeof candidate.shortcutsByUser === 'object'
        ? candidate.shortcutsByUser
        : {},
    )
      .slice(0, 50)
      .map(([userId, shortcuts]) => [normalizeUserId(userId), normalizeShortcuts(shortcuts)]),
  );
  const shortcutsConfiguredByUser = Object.fromEntries(
    Object.entries(
      candidate.shortcutsConfiguredByUser && typeof candidate.shortcutsConfiguredByUser === 'object'
        ? candidate.shortcutsConfiguredByUser
        : {},
    )
      .slice(0, 50)
      .map(([userId, configured]) => [normalizeUserId(userId), configured === true]),
  );
  return {
    version: 1,
    activeUserId,
    performanceTestModeEnabled: candidate.performanceTestModeEnabled === true,
    performanceTestModeConfigured: candidate.performanceTestModeConfigured === true,
    profiles,
    shortcutsByUser,
    shortcutsConfiguredByUser,
  };
}

async function readDocument() {
  try {
    return normalizeDocument(JSON.parse(await fs.readFile(serverConfig.localSettingsPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return structuredClone(defaultDocument);
  }
}

async function writeDocument(document: LocalSettingsDocument) {
  const next = normalizeDocument(document);
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(serverConfig.localSettingsPath), { recursive: true });
    const temporaryPath = `${serverConfig.localSettingsPath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, serverConfig.localSettingsPath);
  });
  await writeQueue;
}

function createView(document: LocalSettingsDocument, requestedUserId?: string): LocalSettingsView {
  const userId = normalizeUserId(requestedUserId ?? document.activeUserId);
  return {
    version: 1,
    activeUserId: userId,
    performanceTestModeEnabled: document.performanceTestModeEnabled,
    performanceTestModeConfigured: document.performanceTestModeConfigured,
    profile: document.profiles[userId] ?? { customId: '' },
    shortcutOverrides: document.shortcutsByUser[userId] ?? {},
    shortcutOverridesConfigured: document.shortcutsConfiguredByUser[userId] === true,
  };
}

export async function getLocalSettings(userId?: string) {
  return createView(await readDocument(), userId);
}

export async function updateLocalSettings(input: {
  userId?: string;
  activate?: boolean;
  performanceTestModeEnabled?: boolean;
  migrationPerformanceTestModeEnabled?: boolean;
  profile?: unknown;
  shortcutOverrides?: unknown;
  migrationShortcutOverrides?: unknown;
}) {
  const document = await readDocument();
  const userId = normalizeUserId(input.userId ?? document.activeUserId);
  if (input.activate) document.activeUserId = userId;
  if (typeof input.performanceTestModeEnabled === 'boolean') {
    document.performanceTestModeEnabled = input.performanceTestModeEnabled;
    document.performanceTestModeConfigured = true;
  } else if (
    !document.performanceTestModeConfigured &&
    typeof input.migrationPerformanceTestModeEnabled === 'boolean'
  ) {
    document.performanceTestModeEnabled = input.migrationPerformanceTestModeEnabled;
    document.performanceTestModeConfigured = true;
  }
  if (input.profile !== undefined) document.profiles[userId] = normalizeProfile(input.profile);
  if (input.shortcutOverrides !== undefined) {
    document.shortcutsByUser[userId] = normalizeShortcuts(input.shortcutOverrides);
    document.shortcutsConfiguredByUser[userId] = true;
  } else if (
    document.shortcutsConfiguredByUser[userId] !== true &&
    input.migrationShortcutOverrides !== undefined
  ) {
    document.shortcutsByUser[userId] = normalizeShortcuts(input.migrationShortcutOverrides);
    document.shortcutsConfiguredByUser[userId] = true;
  }
  await writeDocument(document);
  return createView(document, userId);
}
