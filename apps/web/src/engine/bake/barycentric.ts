export type Vec2 = { x: number; y: number };

export type Barycentric = {
  a: number;
  b: number;
  c: number;
};

export function getBarycentric(point: Vec2, p0: Vec2, p1: Vec2, p2: Vec2): Barycentric | undefined {
  const v0x = p1.x - p0.x;
  const v0y = p1.y - p0.y;
  const v1x = p2.x - p0.x;
  const v1y = p2.y - p0.y;
  const v2x = point.x - p0.x;
  const v2y = point.y - p0.y;
  const denominator = v0x * v1y - v1x * v0y;
  if (Math.abs(denominator) < 1e-8) return undefined;

  const b = (v2x * v1y - v1x * v2y) / denominator;
  const c = (v0x * v2y - v2x * v0y) / denominator;
  const a = 1 - b - c;
  return { a, b, c };
}

export function isInsideBarycentric(barycentric: Barycentric, epsilon = -0.0001) {
  return barycentric.a >= epsilon && barycentric.b >= epsilon && barycentric.c >= epsilon;
}

export function interpolate3(
  barycentric: Barycentric,
  p0: [number, number, number],
  p1: [number, number, number],
  p2: [number, number, number],
): [number, number, number] {
  return [
    p0[0] * barycentric.a + p1[0] * barycentric.b + p2[0] * barycentric.c,
    p0[1] * barycentric.a + p1[1] * barycentric.b + p2[1] * barycentric.c,
    p0[2] * barycentric.a + p1[2] * barycentric.b + p2[2] * barycentric.c,
  ];
}
