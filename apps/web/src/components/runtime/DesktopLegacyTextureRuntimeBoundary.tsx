import type { ReactNode } from 'react';
import { useLocalTextureRuntime } from '@/hooks/useLocalTextureRuntime';
import { TextureRuntimeGate } from './TextureRuntimeGate';

export function DesktopLegacyTextureRuntimeBoundary({
  onBack,
  children,
}: {
  onBack: () => void;
  children: ReactNode;
}) {
  const runtime = useLocalTextureRuntime(true);
  return (
    <TextureRuntimeGate
      state={runtime.state}
      hasReadySession={runtime.hasReadySession}
      onRetry={() => void runtime.refresh()}
      onBack={onBack}
    >
      {children}
    </TextureRuntimeGate>
  );
}
