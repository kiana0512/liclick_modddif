import { createContext, useContext } from 'react';
import type { EngineSession } from './engineSession';

export const EngineSessionContext = createContext<EngineSession | undefined>(undefined);

export function useEngineSession() {
  return useContext(EngineSessionContext);
}
