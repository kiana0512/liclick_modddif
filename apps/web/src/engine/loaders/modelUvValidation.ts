import type { Mesh, Object3D } from 'three';

export type ModelUvReport = { triangles: number; missing: number; invalid: number; outside: number; degenerate: number };

// Match the drawing kernel after conversion to Float32; do not reject merely small UV islands.
export function inspectModelUv(root: Object3D): ModelUvReport {
  const report: ModelUvReport = { triangles: 0, missing: 0, invalid: 0, outside: 0, degenerate: 0 };
  root.traverse(child => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry, position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
    if (!position) return;
    const index = geometry.getIndex(), count = index?.count ?? position.count;
    for (let i = geometry.drawRange.start; i + 2 < Math.min(count, geometry.drawRange.start + geometry.drawRange.count); i += 3) {
      report.triangles++;
      if (!uv) { report.missing++; continue; }
      const ids = [0, 1, 2].map(j => index?.getX(i + j) ?? i + j);
      const u = ids.map(j => Math.fround(uv.getX(j))), v = ids.map(j => Math.fround(uv.getY(j)));
      if (![...u, ...v].every(Number.isFinite)) { report.invalid++; continue; }
      if ([...u, ...v].some(x => x < 0 || x > 1)) report.outside++;
      if ((u[1] - u[0]) * (v[2] - v[0]) === (u[2] - u[0]) * (v[1] - v[0])) report.degenerate++;
    }
  });
  return report;
}

export function needsUvRepair(report: ModelUvReport) {
  return report.missing + report.invalid + report.outside + report.degenerate > 0;
}
