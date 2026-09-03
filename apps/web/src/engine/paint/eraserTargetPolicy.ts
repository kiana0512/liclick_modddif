import type { Layer } from '@/types/layer';

export const ERASER_ALGORITHM_ID = 'ALG-ERASE-001' as const;
export const ERASER_ALGORITHM_VERSION = 1 as const;

export type EraserTargetKind =
  | 'uv-coverage'
  | 'projected-mask'
  | 'local-repaint-coverage'
  | 'convert-content-aware'
  | 'blocked';

export type EraserTargetPolicy = {
  kind: EraserTargetKind;
  canActivate: boolean;
  requiresEditableUvCopy: boolean;
  label: string;
  reason?: string;
};

type EraserPolicyLayer = Pick<
  Layer,
  | 'id'
  | 'name'
  | 'type'
  | 'role'
  | 'imageUrl'
  | 'maskUrl'
  | 'maskSpace'
  | 'localRepaintMaskUrl'
  | 'localRepaintSourceUrl'
  | 'camera'
  | 'generationId'
  | 'eraserAlgorithmVersion'
>;

export function isContentAwareEraserUnderlay(layer: EraserPolicyLayer) {
  return Boolean(
    layer.type === 'uv' &&
      (layer.role === 'content-aware-underlay' ||
        layer.generationId === 'texture-map-content-aware-repair' ||
        layer.id.startsWith('content-aware-uv-repair')),
  );
}

export function isLocalRepaintEraserLayer(layer: EraserPolicyLayer) {
  return Boolean(
    (layer.type === 'projected' || layer.type === 'uv') &&
      (layer.role === 'local-repaint-overlay' ||
        layer.role === 'local-repaint-draft' ||
        layer.id.startsWith('local-repaint-') ||
        layer.localRepaintSourceUrl ||
        layer.localRepaintMaskUrl ||
        layer.imageUrl.includes('surface-edit:local-repaint')),
  );
}

/**
 * Only ordinary projected layers own a removable eraser keep-mask. UV erasing
 * changes image alpha directly, while local repaint masks are authored
 * coverage and must never be discarded by this command.
 */
export function hasClearableProjectedEraserMask(layer?: EraserPolicyLayer) {
  return Boolean(
    layer &&
      layer.type === 'projected' &&
      !isLocalRepaintEraserLayer(layer) &&
      layer.maskUrl &&
      layer.maskSpace === 'uv' &&
      layer.eraserAlgorithmVersion === ERASER_ALGORITHM_VERSION,
  );
}

/**
 * Selects one eraser contract for every layer family. The caller must not infer
 * editability from `Layer.type` independently: projected layers edit a keep
 * mask, UV layers edit their own alpha coverage, and generated underlays remain
 * immutable until the user explicitly creates an editable UV copy.
 */
export function getEraserTargetPolicy(layer?: EraserPolicyLayer): EraserTargetPolicy {
  if (!layer) {
    return {
      kind: 'blocked',
      canActivate: false,
      requiresEditableUvCopy: false,
      label: '未选择图层',
      reason: '请先选择一个可编辑的 UV、投影或局部重绘图层。',
    };
  }

  if (isContentAwareEraserUnderlay(layer)) {
    return {
      kind: 'convert-content-aware',
      canActivate: false,
      requiresEditableUvCopy: true,
      label: '内容填补底图',
      reason: '内容填补底图是只读计算结果；请先转为可编辑 UV 副本。',
    };
  }

  if (isLocalRepaintEraserLayer(layer)) {
    const hasEditableCoverage =
      layer.type === 'uv'
        ? Boolean(layer.imageUrl)
        : Boolean(layer.camera && (layer.localRepaintMaskUrl || layer.maskUrl));
    return {
      kind: 'local-repaint-coverage',
      canActivate: hasEditableCoverage,
      requiresEditableUvCopy: false,
      label: '局部重绘覆盖',
      reason: hasEditableCoverage ? undefined : '这个局部重绘图层还没有可编辑的覆盖数据。',
    };
  }

  if (layer.type === 'projected') {
    const canActivate = Boolean(layer.imageUrl && layer.camera);
    return {
      kind: 'projected-mask',
      canActivate,
      requiresEditableUvCopy: false,
      label: '投影图层蒙版',
      reason: canActivate ? undefined : '投影图层缺少图片或投影相机，无法编辑蒙版。',
    };
  }

  if (layer.type === 'uv') {
    const canActivate = Boolean(layer.imageUrl);
    return {
      kind: 'uv-coverage',
      canActivate,
      requiresEditableUvCopy: false,
      label: 'UV 图层覆盖',
      reason: canActivate ? undefined : '空白 UV 图层还没有可擦除的像素。',
    };
  }

  return {
    kind: 'blocked',
    canActivate: false,
    requiresEditableUvCopy: false,
    label: layer.type === 'normal' ? '法线图层' : '补丁图层',
    reason: layer.type === 'normal' ? '法线图层不能使用颜色橡皮擦。' : '补丁图层请先合并为 UV 图层。',
  };
}
