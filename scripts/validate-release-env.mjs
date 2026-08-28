/* global console, process */

const pairs = [
  ['LICLICK_RELEASE_ID', 'VITE_LICLICK_RELEASE_ID'],
  ['LICLICK_GIT_SHA', 'VITE_LICLICK_GIT_SHA'],
  ['LICLICK_RELEASE_VERSION', 'VITE_LICLICK_RELEASE_VERSION'],
  ['LICLICK_BUILD_TIME', 'VITE_LICLICK_BUILD_TIME'],
  ['LICLICK_RUNTIME_MODE', 'VITE_LICLICK_RUNTIME_MODE'],
];

const errors = [];
for (const [serverName, webName] of pairs) {
  const serverValue = process.env[serverName]?.trim();
  const webValue = process.env[webName]?.trim();
  if (!serverValue) errors.push(`${serverName} is required for an immutable release build.`);
  if (!webValue) errors.push(`${webName} is required for an immutable release build.`);
  if (serverValue && webValue && serverValue !== webValue) {
    errors.push(`${serverName} and ${webName} must be identical.`);
  }
}

const gitSha = process.env.LICLICK_GIT_SHA?.trim() ?? '';
if (gitSha && !/^[a-f0-9]{40}$/i.test(gitSha)) {
  errors.push('LICLICK_GIT_SHA must be a complete 40-character hexadecimal Git SHA.');
}

const builtAt = process.env.LICLICK_BUILD_TIME?.trim() ?? '';
if (builtAt && !Number.isFinite(Date.parse(builtAt))) {
  errors.push('LICLICK_BUILD_TIME must be an ISO-compatible date.');
}

const runtimeMode = process.env.LICLICK_RUNTIME_MODE?.trim() ?? '';
if (runtimeMode && runtimeMode !== 'cloud') {
  errors.push('LICLICK_RUNTIME_MODE must be cloud for a release build.');
}

if (errors.length > 0) {
  console.error('Release environment validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Release environment validated: ${process.env.LICLICK_RELEASE_ID} (${gitSha.slice(0, 12)}, ${runtimeMode}).`,
  );
}
