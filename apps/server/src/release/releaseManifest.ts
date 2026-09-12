import fs from 'node:fs';
import path from 'node:path';
import {
  CURRENT_PROTOCOL_VERSIONS,
  createReleaseManifest,
  type RuntimeMode,
} from '@liclick/contracts';
import { serverConfig } from '../config.js';

function rootPackageVersion() {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(serverConfig.repoRoot, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function runtimeMode(): RuntimeMode {
  const configured = process.env.LICLICK_RUNTIME_MODE?.trim();
  if (configured === 'cloud' || configured === 'development') {
    return configured;
  }
  return process.env.NODE_ENV === 'production' ? 'cloud' : 'development';
}

const gitSha =
  process.env.LICLICK_GIT_SHA?.trim() ||
  process.env.CI_COMMIT_SHA?.trim() ||
  'development';
const version = process.env.LICLICK_RELEASE_VERSION?.trim() || rootPackageVersion();
const shortSha = /^[a-f0-9]{7,64}$/i.test(gitSha) ? gitSha.slice(0, 8).toLowerCase() : gitSha;

export const serverReleaseManifest = createReleaseManifest({
  releaseId:
    process.env.LICLICK_RELEASE_ID?.trim() ||
    `${version}-${shortSha}`,
  gitSha,
  version,
  builtAt: process.env.LICLICK_BUILD_TIME?.trim() || new Date().toISOString(),
  runtimeMode: runtimeMode(),
  component: 'server',
  protocols: CURRENT_PROTOCOL_VERSIONS,
  capabilities: [
    'release-manifest',
    'project-revision-planned',
    ...(runtimeMode() === 'cloud' ? ['cloud-control-plane'] : ['development-runtime']),
  ],
});
