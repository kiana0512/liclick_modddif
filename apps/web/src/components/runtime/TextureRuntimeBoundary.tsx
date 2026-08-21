import { lazy, Suspense, type ReactNode } from 'react';

const requiresDesktopComponent = import.meta.env.VITE_LICLICK_RUNTIME_MODE !== 'cloud';
const DesktopLegacyTextureRuntimeBoundary = requiresDesktopComponent
  ? lazy(() =>
      import('./DesktopLegacyTextureRuntimeBoundary').then((module) => ({
        default: module.DesktopLegacyTextureRuntimeBoundary,
      })),
    )
  : undefined;

/**
 * A build-mode boundary: Cloud renders browser-local compute directly, while
 * desktop compatibility loads the old component gate as a separate chunk.
 */
export function TextureRuntimeBoundary({
  onBack,
  children,
}: {
  onBack: () => void;
  children: ReactNode;
}) {
  if (!DesktopLegacyTextureRuntimeBoundary) return children;
  return (
    <Suspense fallback={null}>
      <DesktopLegacyTextureRuntimeBoundary onBack={onBack}>
        {children}
      </DesktopLegacyTextureRuntimeBoundary>
    </Suspense>
  );
}
