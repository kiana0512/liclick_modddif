import type { ReactNode } from 'react';

/**
 * Browser-local compute runs without an installed host component. Keeping the
 * boundary preserves the route API while making the browser path unconditional.
 */
export function TextureRuntimeBoundary({
  onBack,
  children,
}: {
  onBack: () => void;
  children: ReactNode;
}) {
  void onBack;
  return children;
}
