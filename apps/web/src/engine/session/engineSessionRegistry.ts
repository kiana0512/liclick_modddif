import type { LocalComputePlan } from '@liclick/contracts';
import { EngineSession, type EngineSessionSnapshot } from './engineSession';

type RegistryEntry = {
  session: EngineSession;
  references: number;
  disposeTimer?: number;
  releasedAt?: number;
};

const entries = new Map<string, RegistryEntry>();
const SESSION_RELEASE_GRACE_MS = 10_000;
const MAX_IDLE_ENGINE_SESSIONS = 3;

function publishSessionProbe(snapshot?: EngineSessionSnapshot) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.li3dEngineSession = snapshot?.id ?? '';
  root.dataset.li3dEngineProject = snapshot?.projectId ?? '';
  root.dataset.li3dEngineState = snapshot?.state ?? 'none';
  root.dataset.li3dEngineTasks = String(
    (snapshot?.activeTasks ?? 0) + (snapshot?.queuedTasks ?? 0),
  );
  root.dataset.li3dEngineResources = String(snapshot?.resources ?? 0);
  root.dataset.li3dEngineResourceBytes = String(snapshot?.estimatedResourceBytes ?? 0);
}

function publishMostRecentReferencedSession() {
  const referenced = [...entries.values()].reverse().find((entry) => entry.references > 0);
  publishSessionProbe(referenced?.session.snapshot());
}

function disposeEntry(projectId: string, entry: RegistryEntry) {
  if (entry.disposeTimer !== undefined) window.clearTimeout(entry.disposeTimer);
  if (entries.get(projectId) !== entry) return;
  entries.delete(projectId);
  void entry.session.dispose();
}

function evictExcessIdleSessions() {
  const idleEntries = [...entries.entries()]
    .filter(([, entry]) => entry.references === 0)
    .sort((left, right) => (left[1].releasedAt ?? 0) - (right[1].releasedAt ?? 0));
  const excess = Math.max(0, idleEntries.length - MAX_IDLE_ENGINE_SESSIONS);
  idleEntries.slice(0, excess).forEach(([projectId, entry]) => disposeEntry(projectId, entry));
}

export function acquireEngineSession(projectId: string, plan: LocalComputePlan) {
  let entry = entries.get(projectId);
  if (!entry) {
    const session = new EngineSession(projectId, plan);
    entry = { session, references: 0 };
    entries.set(projectId, entry);
    session.subscribe(publishSessionProbe);
  }
  if (entry.disposeTimer !== undefined) window.clearTimeout(entry.disposeTimer);
  entry.disposeTimer = undefined;
  entry.releasedAt = undefined;
  entry.references += 1;
  entry.session.resume();
  publishSessionProbe(entry.session.snapshot());
  return entry.session;
}

export function releaseEngineSession(projectId: string) {
  const entry = entries.get(projectId);
  if (!entry) return;
  entry.references = Math.max(0, entry.references - 1);
  if (entry.references > 0 || entry.disposeTimer !== undefined) return;
  entry.session.suspend();
  entry.releasedAt = performance.now();
  entry.disposeTimer = window.setTimeout(() => {
    const current = entries.get(projectId);
    if (!current || current.references > 0) return;
    disposeEntry(projectId, current);
    publishMostRecentReferencedSession();
  }, SESSION_RELEASE_GRACE_MS);
  evictExcessIdleSessions();
}

export function peekEngineSession(projectId: string) {
  return entries.get(projectId)?.session;
}

export function engineSessionRegistrySnapshot() {
  const registryEntries = [...entries.values()];
  return {
    total: registryEntries.length,
    referenced: registryEntries.filter((entry) => entry.references > 0).length,
    idle: registryEntries.filter((entry) => entry.references === 0).length,
    estimatedResourceBytes: registryEntries.reduce(
      (total, entry) => total + entry.session.snapshot().estimatedResourceBytes,
      0,
    ),
  };
}
