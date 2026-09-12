import {
  CURRENT_PROTOCOL_VERSIONS,
  createReleaseManifest,
  evaluateReleaseCompatibility,
  parseReleaseManifest,
  type ReleaseCompatibility,
  type ReleaseManifest,
  type RuntimeMode,
} from '@liclick/contracts';
import { getWorkspaceApiBase } from './workspaceApiBase';

const workspaceApiBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

function runtimeMode(): RuntimeMode {
  const value = import.meta.env.VITE_LICLICK_RUNTIME_MODE?.trim();
  if (value === 'cloud' || value === 'development') return value;
  return import.meta.env.PROD ? 'cloud' : 'development';
}

const gitSha = import.meta.env.VITE_LICLICK_GIT_SHA?.trim() || 'development';
const version = import.meta.env.VITE_LICLICK_RELEASE_VERSION?.trim() || '0.1.13';
const shortSha = /^[a-f0-9]{7,64}$/i.test(gitSha) ? gitSha.slice(0, 8).toLowerCase() : gitSha;

export const webReleaseManifest = createReleaseManifest({
  releaseId: import.meta.env.VITE_LICLICK_RELEASE_ID?.trim() || `${version}-${shortSha}`,
  gitSha,
  version,
  builtAt: import.meta.env.VITE_LICLICK_BUILD_TIME?.trim() || new Date(0).toISOString(),
  runtimeMode: runtimeMode(),
  component: 'web',
  protocols: CURRENT_PROTOCOL_VERSIONS,
  capabilities: [
    'release-manifest',
    'browser-local-compute',
    ...(runtimeMode() === 'cloud' ? ['cloud-control-plane-client'] : ['development-runtime']),
  ],
});

export async function fetchServerReleaseManifest(): Promise<ReleaseManifest> {
  const response = await fetch(`${workspaceApiBase}/api/release`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Release manifest request failed (${response.status}).`);
  return parseReleaseManifest(await response.json());
}

export async function checkReleaseCompatibility(): Promise<ReleaseCompatibility> {
  return evaluateReleaseCompatibility(webReleaseManifest, await fetchServerReleaseManifest());
}

export type ReleaseCompatibilityState =
  | { status: 'checking'; web: ReleaseManifest }
  | { status: 'compatible'; web: ReleaseManifest; server: ReleaseManifest; compatibility: ReleaseCompatibility }
  | { status: 'incompatible'; web: ReleaseManifest; server: ReleaseManifest; compatibility: ReleaseCompatibility }
  | { status: 'unavailable'; web: ReleaseManifest; error: string };

export const releaseCompatibilityEventName = 'li3d:release-compatibility';

function publishReleaseState(state: ReleaseCompatibilityState) {
  const root = document.documentElement;
  root.dataset.li3dReleaseId = webReleaseManifest.releaseId;
  root.dataset.li3dGitSha = webReleaseManifest.gitSha;
  root.dataset.li3dRuntimeMode = webReleaseManifest.runtimeMode;
  root.dataset.li3dReleaseCompatibility = state.status;
  window.dispatchEvent(new CustomEvent(releaseCompatibilityEventName, { detail: state }));
}

/**
 * Publishes release identity for support tooling and detects mixed deployments.
 * Phase 1 is intentionally observational: an unavailable control plane does not
 * replace the existing application error handling, while protocol mismatches are
 * made explicit for the UI/telemetry layer to block in the next migration step.
 */
export async function initializeReleaseCompatibility(): Promise<ReleaseCompatibilityState> {
  const checking: ReleaseCompatibilityState = { status: 'checking', web: webReleaseManifest };
  publishReleaseState(checking);
  try {
    const server = await fetchServerReleaseManifest();
    const compatibility = evaluateReleaseCompatibility(webReleaseManifest, server);
    const state: ReleaseCompatibilityState = {
      status: compatibility.compatible ? 'compatible' : 'incompatible',
      web: webReleaseManifest,
      server,
      compatibility,
    };
    publishReleaseState(state);
    if (!compatibility.sameRelease) {
      console.warn('[LI3D release] Mixed Web/Server release detected.', compatibility.issues);
    }
    if (!compatibility.compatible) {
      console.error('[LI3D release] Protocol incompatibility detected.', compatibility.issues);
    }
    return state;
  } catch (error) {
    const state: ReleaseCompatibilityState = {
      status: 'unavailable',
      web: webReleaseManifest,
      error: error instanceof Error ? error.message : String(error),
    };
    publishReleaseState(state);
    console.warn('[LI3D release] Server release manifest is unavailable.', state.error);
    return state;
  }
}
