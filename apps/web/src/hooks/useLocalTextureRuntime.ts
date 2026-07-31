import { useCallback, useEffect, useState } from 'react';
import {
  checkLocalTextureRuntime,
  type LocalTextureRuntimeState,
} from '@/services/localTextureRuntimeClient';

export function useLocalTextureRuntime(enabled = true) {
  const [state, setState] = useState<LocalTextureRuntimeState>({ status: 'checking' });

  const refresh = useCallback(async () => {
    setState((current) => (current.status === 'ready' ? current : { status: 'checking' }));
    const next = await checkLocalTextureRuntime();
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15_000);
    const handleFocus = () => void refresh();
    window.addEventListener('focus', handleFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
    };
  }, [enabled, refresh]);

  return { state, refresh };
}
