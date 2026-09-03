// M15 / CLOUD-DEPLOYMENT v1.0.0. Run before migrations and server startup.
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function validateRuntimeEnv(env) {
  const errors = [];
  for (const [name, value] of Object.entries({
    LICLICK_RUNTIME_MODE: 'cloud',
    LICLICK_PROJECT_REPOSITORY: 'postgres',
    AUTH_MODE: 'feishu-oauth',
    SESSION_COOKIE_SECURE: 'true',
  })) {
    if (env[name] !== value) errors.push(name + ' must be ' + value);
  }
  const required = [
    'SESSION_SECRET', 'FEISHU_OAUTH_CLIENT_ID', 'FEISHU_OAUTH_CLIENT_SECRET',
    'LICLICK_CLOUD_DATABASE_URL', 'LICLICK_OBJECT_STORAGE_ENDPOINT',
    'LICLICK_OBJECT_STORAGE_BUCKET', 'LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID',
    'LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY',
  ];
  for (const name of required) {
    if (!env[name]?.trim()) errors.push(name + ' is required');
  }
  for (const [name, protocols] of [
    ['LICLICK_CLOUD_DATABASE_URL', ['postgres:', 'postgresql:']],
    ['LICLICK_OBJECT_STORAGE_ENDPOINT', ['https:']],
  ]) {
    try {
      if (!protocols.includes(new URL(env[name]).protocol)) throw new Error();
    } catch {
      errors.push(name + ' must use ' + protocols.join(' or '));
    }
  }
  if (env.LICLICK_SHARED_TEST_ACCOUNT_ENABLED === 'true') {
    errors.push('Shared test accounts cannot be enabled by this production deployment');
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = validateRuntimeEnv(process.env);
  if (errors.length) {
    process.stderr.write('Cloud runtime configuration is incomplete:\n' + errors.join('\n') + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('Cloud runtime configuration validated (values redacted).\n');
  }
}
