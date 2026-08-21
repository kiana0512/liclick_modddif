import { useEffect, useState, type ReactNode } from 'react';
import { getBrowserComputeState } from '@/platform/browserComputeCapabilities';
import type { EngineSession } from './engineSession';
import { EngineSessionContext } from './engineSessionContext';
import { acquireEngineSession, releaseEngineSession } from './engineSessionRegistry';

export function EngineSessionBoundary({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const [session, setSession] = useState<EngineSession>();

  useEffect(() => {
    let cancelled = false;
    let acquired: EngineSession | undefined;
    void getBrowserComputeState().then((compute) => {
      if (cancelled) return;
      acquired = acquireEngineSession(projectId, compute.plan);
      setSession(acquired);
    });
    return () => {
      cancelled = true;
      if (acquired) releaseEngineSession(projectId);
    };
  }, [projectId]);

  return (
    <EngineSessionContext.Provider value={session}>{children}</EngineSessionContext.Provider>
  );
}
