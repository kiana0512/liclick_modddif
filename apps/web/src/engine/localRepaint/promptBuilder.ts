import type { LocalRepaintMode } from '@/types/localRepaint';

const englishConstraint = `Keep the same object, camera angle, composition, and perspective.
Only modify the masked region and optional blank untextured regions.
Preserve all unmasked regions exactly.
Keep the material, color family, lighting style, and texture continuity consistent with surrounding regions.
Repair seams, missing texture, black artifacts, and discontinuities.
Do not change the silhouette, shape, object identity, camera angle, or projection relationship.`;

const chineseConstraint = `保持同一个物体、同一个相机角度、同一个构图和透视关系。
只修改蒙版区域以及可选的空白未贴图区域。
未蒙版区域必须完全保持不变。
保持材质、颜色、光照风格和周围纹理连续一致。
修复接缝、缺失纹理、黑边、断裂和不连续问题。
不要改变轮廓、形状、物体身份、相机角度和投影关系。`;

export function buildLocalRepaintPrompt(input: {
  userPrompt: string;
  materialDescription?: string;
  mode: LocalRepaintMode;
  preserveUnmaskedArea: boolean;
  includeBlankArea: boolean;
  language?: 'zh' | 'en';
}) {
  const constraint = input.language === 'en' ? englishConstraint : chineseConstraint;
  const modeHint =
    input.mode === 'edit_layer_image'
      ? input.language === 'en'
        ? 'Mode: edit the existing projected layer image only. Do not change projection mapping.'
        : '模式：只编辑现有投射图层图像，不改变投射映射关系。'
      : input.language === 'en'
        ? 'Mode: repair the current composed view and keep all protected regions unchanged.'
        : '模式：修补当前合成视角，并保持所有保护区域不变。';
  const blankHint = input.includeBlankArea
    ? input.language === 'en'
      ? 'Blank or untextured regions may be repaired when included in the mask.'
      : '空白或未贴图区域如果进入蒙版，可以一起修补。'
    : input.language === 'en'
      ? 'Do not edit blank regions unless they are explicitly masked by the user.'
      : '除非用户明确涂抹，否则不要编辑空白区域。';
  const preserveHint = input.preserveUnmaskedArea
    ? input.language === 'en'
      ? 'Unmasked pixels are protected by the application and must also be visually preserved.'
      : '未蒙版像素会被系统保护，也必须在视觉上保持不变。'
    : '';
  return [
    constraint,
    modeHint,
    blankHint,
    preserveHint,
    input.materialDescription ? `Material: ${input.materialDescription}` : '',
    input.userPrompt.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}
