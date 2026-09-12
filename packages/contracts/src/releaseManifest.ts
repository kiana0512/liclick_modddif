export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;

export const CURRENT_PROTOCOL_VERSIONS = {
  api: '1.0',
  project: '0.6',
  compute: '1.0',
  asset: '1.0',
} as const;

export const RUNTIME_MODES = ['cloud', 'development'] as const;
export const RELEASE_COMPONENTS = ['web', 'server'] as const;

export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export type ReleaseComponent = (typeof RELEASE_COMPONENTS)[number];

export type ProtocolVersions = {
  api: string;
  project: string;
  compute: string;
  asset: string;
};

export type ReleaseManifest = {
  schemaVersion: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  releaseId: string;
  gitSha: string;
  version: string;
  builtAt: string;
  runtimeMode: RuntimeMode;
  component: ReleaseComponent;
  protocols: ProtocolVersions;
  capabilities: string[];
};

export type ReleaseManifestInput = Omit<ReleaseManifest, 'schemaVersion' | 'capabilities'> & {
  capabilities?: readonly string[];
};

export type ReleaseCompatibilityIssue = {
  code:
    | 'INVALID_MANIFEST'
    | 'MIXED_RELEASE'
    | 'API_PROTOCOL_MISMATCH'
    | 'PROJECT_PROTOCOL_MISMATCH'
    | 'COMPUTE_PROTOCOL_MISMATCH'
    | 'ASSET_PROTOCOL_MISMATCH';
  severity: 'warning' | 'error';
  message: string;
};

export type ReleaseCompatibility = {
  compatible: boolean;
  sameRelease: boolean;
  issues: ReleaseCompatibilityIssue[];
};

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const gitShaPattern = /^(?:development|unknown|[a-f0-9]{7,64})$/i;
const protocolPattern = /^\d+\.\d+(?:\.\d+)?$/;

function requiredIdentifier(value: unknown, name: string) {
  if (typeof value !== 'string' || !identifierPattern.test(value)) {
    throw new Error(`${name} must be a non-empty release identifier.`);
  }
  return value;
}

function requiredProtocol(value: unknown, name: string) {
  if (typeof value !== 'string' || !protocolPattern.test(value)) {
    throw new Error(`${name} must use a numeric major.minor protocol version.`);
  }
  return value;
}

function requiredDate(value: unknown) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('builtAt must be an ISO-compatible date string.');
  }
  return new Date(value).toISOString();
}

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return typeof value === 'string' && RUNTIME_MODES.includes(value as RuntimeMode);
}

function isReleaseComponent(value: unknown): value is ReleaseComponent {
  return typeof value === 'string' && RELEASE_COMPONENTS.includes(value as ReleaseComponent);
}

function normalizedCapabilities(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    .map((item) => item.trim())
    .filter((item) => identifierPattern.test(item))
    .sort();
}

export function createReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  if (!gitShaPattern.test(input.gitSha)) {
    throw new Error('gitSha must be development, unknown, or a hexadecimal Git SHA.');
  }
  if (!isRuntimeMode(input.runtimeMode)) throw new Error('runtimeMode is invalid.');
  if (!isReleaseComponent(input.component)) throw new Error('component is invalid.');
  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseId: requiredIdentifier(input.releaseId, 'releaseId'),
    gitSha: input.gitSha.toLowerCase(),
    version: requiredIdentifier(input.version, 'version'),
    builtAt: requiredDate(input.builtAt),
    runtimeMode: input.runtimeMode,
    component: input.component,
    protocols: {
      api: requiredProtocol(input.protocols.api, 'protocols.api'),
      project: requiredProtocol(input.protocols.project, 'protocols.project'),
      compute: requiredProtocol(input.protocols.compute, 'protocols.compute'),
      asset: requiredProtocol(input.protocols.asset, 'protocols.asset'),
    },
    capabilities: normalizedCapabilities(input.capabilities),
  };
}
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Release manifest must be an object.');
  }
  const record = value as Partial<ReleaseManifest>;
  if (record.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported release manifest schema: ${String(record.schemaVersion)}.`);
  }
  return createReleaseManifest({
    releaseId: record.releaseId as string,
    gitSha: record.gitSha as string,
    version: record.version as string,
    builtAt: record.builtAt as string,
    runtimeMode: record.runtimeMode as RuntimeMode,
    component: record.component as ReleaseComponent,
    protocols: record.protocols as ProtocolVersions,
    capabilities: record.capabilities,
  });
}

export function evaluateReleaseCompatibility(
  webManifest: ReleaseManifest,
  serverManifest: ReleaseManifest,
): ReleaseCompatibility {
  const issues: ReleaseCompatibilityIssue[] = [];
  const sameRelease = webManifest.releaseId === serverManifest.releaseId && webManifest.gitSha === serverManifest.gitSha;
  if (!sameRelease) {
    issues.push({
      code: 'MIXED_RELEASE',
      severity: 'warning',
      message: `Web ${webManifest.releaseId} and server ${serverManifest.releaseId} are different releases.`,
    });
  }
  const protocolChecks: Array<{
    key: keyof ProtocolVersions;
    code: ReleaseCompatibilityIssue['code'];
  }> = [
    { key: 'api', code: 'API_PROTOCOL_MISMATCH' },
    { key: 'project', code: 'PROJECT_PROTOCOL_MISMATCH' },
    { key: 'compute', code: 'COMPUTE_PROTOCOL_MISMATCH' },
    { key: 'asset', code: 'ASSET_PROTOCOL_MISMATCH' },
  ];
  for (const { key, code } of protocolChecks) {
    if (webManifest.protocols[key] === serverManifest.protocols[key]) continue;
    issues.push({
      code,
      severity: 'error',
      message: `${key} protocol mismatch: web=${webManifest.protocols[key]}, server=${serverManifest.protocols[key]}.`,
    });
  }
  return {
    compatible: issues.every((issue) => issue.severity !== 'error'),
    sameRelease,
    issues,
  };
}
