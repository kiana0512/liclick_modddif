export type ClientIdentity = {
  machine_id: string;
  install_id: string;
  session_id: string;
};

const storageKeys = {
  machine: 'li3d.identity.machine-id.v1',
  install: 'li3d.identity.install-id.v1',
  session: 'li3d.identity.session-id.v1',
} as const;

const identityPatterns = {
  machine: /^machine_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  install: /^install_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  session: /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
} as const;

const memoryFallback = new Map<string, string>();

function randomUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function readOrCreateId(
  storage: 'localStorage' | 'sessionStorage',
  key: string,
  prefix: 'machine_' | 'install_' | 'sess_',
  pattern: RegExp,
) {
  const fallback = memoryFallback.get(key);
  if (fallback) return fallback;

  try {
    const target = window[storage];
    const saved = target.getItem(key);
    if (saved && pattern.test(saved)) return saved;
    const created = `${prefix}${randomUuid()}`;
    target.setItem(key, created);
    return created;
  } catch {
    // Storage can be unavailable in restricted/private browser contexts. Keep a
    // random page-lifetime ID instead of attempting any hardware fingerprint.
    const created = `${prefix}${randomUuid()}`;
    memoryFallback.set(key, created);
    return created;
  }
}

export function getClientIdentity(): ClientIdentity {
  return {
    machine_id: readOrCreateId('localStorage', storageKeys.machine, 'machine_', identityPatterns.machine),
    install_id: readOrCreateId('localStorage', storageKeys.install, 'install_', identityPatterns.install),
    session_id: readOrCreateId('sessionStorage', storageKeys.session, 'sess_', identityPatterns.session),
  };
}

export function createEventId() {
  return `evt_${randomUuid()}`;
}
