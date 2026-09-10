import type { Object3D, Mesh, Material } from 'three';
import { isResidentProjectedMaterial } from '../projection/projectedMaterialIdentity';

// GPT-MULTIVIEW-PAIR-SEQUENCE v1.0.0. Preview order is deliberately untouched.
const presetPairs = {
  'preset-1': [
    ['front', 'back'],
    ['front-left', 'back-right'],
    ['left', 'right'],
    ['back-left', 'front-right'],
  ],
  'preset-2': [
    ['front', 'back'],
    ['left', 'right'],
    ['right-top', 'left-bottom'],
    ['front-top', 'back-bottom'],
    ['left-top', 'right-bottom'],
    ['back-top', 'front-bottom'],
  ],
  custom: [
    ['front', 'back'],
    ['left', 'right'],
  ],
} as const;

export function planGptViewPairs<T extends { id: string; value?: string }>(
  views: readonly T[],
  preset: keyof typeof presetPairs,
): T[][] {
  const remaining = new Map(views.map((view) => [view.id, view]));
  const take = (names: readonly string[]) =>
    names.flatMap((name) => {
      const view = [...remaining.values()].find((item) => item.value === name && item.id === name);
      if (!view) return [];
      remaining.delete(view.id);
      return [view];
    });
  // Adding a camera switches the UI selection to "custom" without replacing
  // its inherited preset cameras. Keep those original fixed pairs as well.
  const inheritedPreset =
    preset === 'custom'
      ? views.some((view) => view.value?.endsWith('-top') || view.value?.endsWith('-bottom'))
        ? 'preset-2'
        : 'preset-1'
      : preset;
  const pairs = presetPairs[inheritedPreset].map(take).filter((pair) => pair.length > 0);
  const poles = take(['top', 'bottom']);
  // Added views are never silently re-aimed, dropped or paired by a guessed angle.
  pairs.push(...[...remaining.values()].map((view) => [view]));
  if (poles.length) pairs.push(poles);
  return pairs;
}

export async function runGptViewPairs<T>(
  pairs: readonly (readonly T[])[],
  assertActive: () => void,
  execute: (pair: readonly T[], index: number) => Promise<void>,
) {
  for (let index = 0; index < pairs.length; index += 1) {
    assertActive();
    await execute(pairs[index]!, index);
    assertActive();
  }
}

// Jobs wait in parallel, but commits never depend on network completion order.
// A successful sibling is retained even if its partner fails.
export async function settleGptPairInOrder<T, R, C>(
  items: readonly T[],
  wait: (item: T) => Promise<R>,
  commit: (item: T, result: R) => Promise<C>,
): Promise<PromiseSettledResult<C>[]> {
  const ready = await Promise.allSettled(items.map(wait));
  const committed: PromiseSettledResult<C>[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const result = ready[index]!;
    if (result.status === 'rejected') {
      committed.push(result);
      continue;
    }
    try {
      committed.push({ status: 'fulfilled', value: await commit(items[index]!, result.value) });
    } catch (reason) {
      committed.push({ status: 'rejected', reason });
    }
  }
  return committed;
}

// Inspect actual material bindings, not a generic resident event or stale row count.
export function hasResidentGptLayers(root: Object3D | undefined, required: readonly string[]) {
  if (!root?.visible || !required.length) return false;
  let found = false;
  let complete = true;
  root.traverse((child) => {
    if (!(child as Mesh).isMesh || !child.visible) return;
    const material = (child as Mesh).material;
    for (const entry of (Array.isArray(material) ? material : [material]) as Material[]) {
      found = true;
      const state = entry.userData.liclickProjectedLayerStackState as
        | { bindings?: Array<{ layerId?: string }> }
        | undefined;
      const ids = new Set(state?.bindings?.map((binding) => binding.layerId));
      if (!isResidentProjectedMaterial(entry) || !required.every((id) => ids.has(id))) complete = false;
    }
  });
  return found && complete;
}

export async function waitForGptPairPresentation(
  ready: () => boolean,
  assertActive: () => void,
  present: () => Promise<void>,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    assertActive();
    if (ready()) {
      await present();
      await present();
      assertActive();
      if (ready()) return;
    }
    if (Date.now() >= deadline)
      throw new Error('本组纹理已保存，但视口尚未完成显示；已停止后续视角，请检查图层显示状态。');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
