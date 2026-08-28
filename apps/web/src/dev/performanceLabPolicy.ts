/**
 * The performance lab is a read-only diagnostic overlay for the project that
 * is already loaded by the normal workspace route.
 *
 * Data-safety invariant: this policy must never select, create, replace, or
 * persist models, layers, captures, generations, or projects.
 */
export function isPerformanceLabEnabled(search: string) {
  return new URLSearchParams(search).get('perfLab') === '1';
}
