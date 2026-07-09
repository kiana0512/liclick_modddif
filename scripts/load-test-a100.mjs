#!/usr/bin/env node
import { performance } from 'node:perf_hooks';

const baseUrl = (process.env.BASE_URL || process.argv[2] || 'http://127.0.0.1:46001/liclick/texture').replace(/\/$/, '');
const concurrency = Number(process.env.CONCURRENCY || process.argv[3] || 100);
const durationMs = Number(process.env.DURATION_SECONDS || process.argv[4] || 60) * 1000;
const sessionCookie = process.env.SESSION_COOKIE || '';

const endpoints = [
  { method: 'GET', path: '/', auth: false },
  { method: 'GET', path: '/api/health', auth: false },
  { method: 'GET', path: '/api/auth/provider-status', auth: false },
];

if (sessionCookie) {
  endpoints.push({ method: 'GET', path: '/api/auth/me', auth: true });
  endpoints.push({ method: 'GET', path: '/api/projects', auth: true });
}

const stats = {
  ok: 0,
  failed: 0,
  latencies: [],
  statuses: new Map(),
};

function recordStatus(status) {
  stats.statuses.set(status, (stats.statuses.get(status) || 0) + 1);
}

async function hit(endpoint, userIndex) {
  const startedAt = performance.now();
  try {
    const headers = { 'x-load-user': `load-user-${userIndex}` };
    if (endpoint.auth && sessionCookie) headers.cookie = sessionCookie;
    const response = await fetch(`${baseUrl}${endpoint.path}`, {
      method: endpoint.method,
      headers,
    });
    const elapsed = performance.now() - startedAt;
    stats.latencies.push(elapsed);
    recordStatus(response.status);
    if (response.ok) stats.ok += 1;
    else stats.failed += 1;
    await response.arrayBuffer().catch(() => undefined);
  } catch {
    const elapsed = performance.now() - startedAt;
    stats.latencies.push(elapsed);
    recordStatus('network-error');
    stats.failed += 1;
  }
}

async function worker(userIndex, deadline) {
  let cursor = userIndex % endpoints.length;
  while (performance.now() < deadline) {
    await hit(endpoints[cursor], userIndex);
    cursor = (cursor + 1) % endpoints.length;
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

console.log(`Load test target: ${baseUrl}`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Duration: ${Math.round(durationMs / 1000)}s`);
console.log(`Authenticated endpoints: ${sessionCookie ? 'enabled' : 'disabled'}`);

const startedAt = performance.now();
const deadline = startedAt + durationMs;
await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index + 1, deadline)));
const totalMs = performance.now() - startedAt;
const total = stats.ok + stats.failed;

console.log('\nResult');
console.log(`Requests: ${total}`);
console.log(`OK: ${stats.ok}`);
console.log(`Failed: ${stats.failed}`);
console.log(`RPS: ${(total / (totalMs / 1000)).toFixed(2)}`);
console.log(`p50: ${percentile(stats.latencies, 0.5).toFixed(1)}ms`);
console.log(`p95: ${percentile(stats.latencies, 0.95).toFixed(1)}ms`);
console.log(`p99: ${percentile(stats.latencies, 0.99).toFixed(1)}ms`);
console.log('Statuses:');
for (const [status, count] of [...stats.statuses.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
  console.log(`  ${status}: ${count}`);
}

if (stats.failed > 0) process.exitCode = 1;
