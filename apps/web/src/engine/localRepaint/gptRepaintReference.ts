import type { ReferenceImage } from '@/types/project';

/** GPT reference mode never guesses from generation history or paired views. */
export function resolveGptRepaintReference(input: {
  enabled: boolean;
  references: ReferenceImage[];
  selectedReferenceIds: string[];
}) {
  if (!input.enabled) return undefined;
  const selected = input.selectedReferenceIds
    .map((id) => input.references.find((reference) => reference.id === id))
    .find((reference) => Boolean(reference));
  if (!selected) throw new Error('已开启材质参考，请先选择一张参考图，或关闭“使用材质参考图”。');
  return { ...selected };
}
