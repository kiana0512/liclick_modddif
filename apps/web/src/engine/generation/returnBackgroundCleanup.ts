import type { GenerationFraming } from '@liclick/contracts';
import { restoredFrameLayout } from './contentFraming';

/** GPT-RETURN-BACKGROUND-CLEANUP/1: conservative, alpha-only border-component cleanup.
 * Never clip to the input mask: a displaced subject must remain displaced for QA.
 * Plan all removals before writing; cancellation leaves the input unchanged.
 */
export async function cleanReturnBackground(
  frame: GenerationFraming,
  image: Pick<ImageData, 'width' | 'height' | 'data'>,
  checkpoint: () => Promise<void>,
) {
  if (frame.version !== 2) return false;
  const { width, height, data } = image;
  const layout = restoredFrameLayout(frame, width, height);
  const subject = frame.subject!;
  const sx = layout.width / frame.sourceWidth, sy = layout.height / frame.sourceHeight;
  const expected = [subject.left * sx - layout.left, subject.top * sy - layout.top,
    (subject.left + subject.width) * sx - layout.left,
    (subject.top + subject.height) * sy - layout.top];
  const tolerance = Math.max(16, Math.max(subject.width * sx, subject.height * sy) * 0.02);
  // Bound temporary memory even for provider outputs larger than requested.
  if (width * height > 4096 * 4096) return false;
  const labels = new Uint32Array(width * height);
  const queue = new Uint32Array(width * height);
  const components: { count: number; outside: number; edge: boolean; bounds: number[] }[] = [];
  let largest = -1, total = 0, steps = 0;
  await checkpoint();
  for (let seed = 0; seed < labels.length; seed++) {
    if ((seed & 65535) === 0) await checkpoint();
    if (labels[seed] || !data[seed * 4 + 3]) continue;
    const id = components.length + 1;
    // Highly fragmented alpha is not a safe automatic repair candidate.
    if (id > 4096) return false;
    let head = 0, tail = 1;
    queue[0] = seed; labels[seed] = id;
    const component = { count: 0, outside: 0, edge: false, bounds: [width, height, 0, 0] };
    while (head < tail) {
      const pixel = queue[head++], x = pixel % width, y = Math.floor(pixel / width);
      component.count++;
      component.edge ||= x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (x < expected[0] - 2 || y < expected[1] - 2 || x >= expected[2] + 2 || y >= expected[3] + 2) component.outside++;
      if (data[pixel * 4 + 3] >= 128) {
        component.bounds[0] = Math.min(component.bounds[0], x);
        component.bounds[1] = Math.min(component.bounds[1], y);
        component.bounds[2] = Math.max(component.bounds[2], x + 1);
        component.bounds[3] = Math.max(component.bounds[3], y + 1);
      }
      // Include diagonal and faint-alpha bridges so attached details cannot be removed.
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (!labels[next] && data[next * 4 + 3]) { labels[next] = id; queue[tail++] = next; }
      }
      if (++steps % 32768 === 0) await checkpoint();
    }
    total += component.count;
    components.push(component);
    if (largest < 0 || component.count > components[largest].count) largest = id - 1;
  }
  if (largest < 0) return false;
  const main = components[largest];
  if (main.count < total * 0.8 || main.bounds.some((v, i) => Math.abs(v - expected[i]) > tolerance)) return false;
  const remove = new Set<number>();
  let removed = 0;
  components.forEach((c, i) => {
    if (i !== largest && c.edge && c.outside >= c.count * 0.9) { remove.add(i + 1); removed += c.count; }
  });
  if (!removed || removed > main.count * 0.1) return false;
  await checkpoint();
  for (let i = 0; i < labels.length; i++) if (remove.has(labels[i])) data[i * 4 + 3] = 0;
  return true;
}
