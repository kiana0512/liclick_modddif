import type { Object3D, Mesh, Material } from 'three';
import { isResidentProjectedMaterial } from '../projection/projectedMaterialIdentity';

// GPT-MULTIVIEW-PAIR-SEQUENCE v1.5.0. QA-only rejection may advance; transport/projection failures stop.
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
  preset: keyof typeof presetPairs | 'preset-3',
): T[][] {
  const remaining = new Map(views.map((view) => [view.id, view]));
  const take = (names: readonly string[]) =>
    names.flatMap((name) => {
      const view = [...remaining.values()].find((item) => item.value === name && (item.id === name || item.id === `preset-3-${name}`));
      if (!view) return [];
      remaining.delete(view.id);
      return [view];
    });
  // Adding a camera switches the UI selection to "custom" without replacing
  // its inherited preset cameras. Keep those original fixed pairs as well.
  const inheritedPreset =
    preset === 'preset-3' ? 'preset-1' : preset === 'custom'
      ? views.some((view) => view.value?.endsWith('-top') || view.value?.endsWith('-bottom'))
        ? 'preset-2'
        : 'preset-1'
      : preset;
  const pairs = presetPairs[inheritedPreset].map(take).filter((pair) => pair.length > 0);
  const poles = take(['top', 'bottom']);
  // Added views are never silently re-aimed, dropped or paired by a guessed angle.
  pairs.push(...[...remaining.values()].map((view) => [view]));
  if (poles.length) pairs.push(poles);
  const groups: T[][] = [];
  for (const pair of pairs) {
    const previous = groups.at(-1);
    // Keep the initial pair and added/unpaired cameras isolated. Combine only
    // consecutive complete preset pairs, preserving deterministic commit order.
    if (groups.length > 1 && previous?.length === 2 && pair.length === 2) {
      previous.push(...pair);
    } else {
      groups.push([...pair]);
    }
  }
  return groups;
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

export type GptPairCompletionDisposition = 'complete' | 'continue-after-qa' | 'stop';

export function gptPairCompletionDisposition(
  expected: number,
  projected: number,
  qaRejected: number,
): GptPairCompletionDisposition {
  if (
    !Number.isSafeInteger(expected) ||
    !Number.isSafeInteger(projected) ||
    !Number.isSafeInteger(qaRejected) ||
    expected < 1 ||
    projected < 0 ||
    projected > expected ||
    qaRejected < 0
  ) {
    return 'stop';
  }
  const missing = expected - projected;
  if (missing === 0) return 'complete';
  return qaRejected === missing ? 'continue-after-qa' : 'stop';
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
export function hasResidentProjectedLayers(root: Object3D | undefined, required: readonly string[]) {
  if (!root?.visible || !required.length) return false;
  let found = false;
  let complete = true;
  root.traverse((child) => {
    if (!(child as Mesh).isMesh || !child.visible) return;
    const material = (child as Mesh).material;
    for (const entry of (Array.isArray(material) ? material : [material]) as Material[]) {
      found = true;
      const uvIds = entry.userData.liclickResidentUvProjectionLayers as string[] | undefined;
      if (entry.name === 'LiclickUvOverlayPreview' && uvIds && required.every(id => uvIds.includes(id))) continue;
      const state = entry.userData.liclickProjectedLayerStackState as
        | { bindings?: Array<{ layerId?: string }> }
        | undefined;
      const ids = new Set(state?.bindings?.map((binding) => binding.layerId));
      if (!isResidentProjectedMaterial(entry) || !required.every((id) => ids.has(id))) complete = false;
    }
  });
  return found && complete;
}

// MODELVIEW-PRESENTATION-BARRIER v1.0.0: durable bindings also cover material reuse
// and completion before the caller starts waiting. No event or timeout bypass.
export async function waitForProjectedLayerPresentation(
  ready: () => boolean,
  assertActive: () => void,
  present: () => Promise<void>,
  timeoutMs = 60_000,
  onDelayed?: () => void,
) {
  let deadline = Date.now() + timeoutMs;
  for (;;) {
    assertActive();
    if (ready()) {
      await present();
      await present();
      assertActive();
      if (ready()) return;
    }
    if (Date.now() >= deadline) {
      // The image generation already succeeded. A delayed viewport is not a
      // generation failure and must not release the next capture out of order.
      onDelayed?.();
      deadline = Date.now() + Math.max(timeoutMs, 1_000);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Preserve the existing GPT contract while sharing the same strict barrier.
export const hasResidentGptLayers = hasResidentProjectedLayers;
export const waitForGptPairPresentation = waitForProjectedLayerPresentation;
