import { create } from 'zustand';

export type ShortcutScope = 'global' | 'scene' | 'texture' | 'image' | 'repaint';

export type ShortcutActionId =
  | 'project.save'
  | 'history.undo'
  | 'history.redo'
  | 'view.front'
  | 'view.back'
  | 'view.right'
  | 'view.left'
  | 'view.top'
  | 'view.bottom'
  | 'view.toggleProjection'
  | 'view.focus'
  | 'scene.arrange'
  | 'scene.select'
  | 'scene.translate'
  | 'scene.rotate'
  | 'scene.scale'
  | 'texture.clearMask'
  | 'texture.duplicateLayer'
  | 'texture.invertMask'
  | 'texture.newLayer'
  | 'texture.moveLayerUp'
  | 'texture.moveLayerDown'
  | 'texture.showAllLayers'
  | 'texture.toggleLayer'
  | 'texture.select'
  | 'texture.brushSmaller'
  | 'texture.brushLarger'
  | 'texture.maskAdd'
  | 'texture.maskSubtract'
  | 'texture.localRepaint'
  | 'image.move'
  | 'image.select'
  | 'image.brush'
  | 'image.eraser'
  | 'image.fill'
  | 'image.picker'
  | 'image.pan'
  | 'image.brushSmaller'
  | 'image.brushLarger'
  | 'image.hardnessSofter'
  | 'image.hardnessHarder'
  | 'repaint.brush'
  | 'repaint.eraser'
  | 'repaint.brushSmaller'
  | 'repaint.brushLarger';

export type ShortcutBinding = {
  code: string;
  primary?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ShortcutDefinition = {
  id: ShortcutActionId;
  scope: ShortcutScope;
  categoryZh: string;
  categoryEn: string;
  labelZh: string;
  labelEn: string;
  defaults: ShortcutBinding[];
};

const binding = (
  code: string,
  modifiers: Omit<ShortcutBinding, 'code'> = {},
): ShortcutBinding => ({ code, ...modifiers });

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  { id: 'project.save', scope: 'global', categoryZh: '通用', categoryEn: 'General', labelZh: '保存项目', labelEn: 'Save project', defaults: [binding('KeyS', { primary: true })] },
  { id: 'history.undo', scope: 'global', categoryZh: '通用', categoryEn: 'General', labelZh: '撤销', labelEn: 'Undo', defaults: [binding('KeyZ', { primary: true })] },
  { id: 'history.redo', scope: 'global', categoryZh: '通用', categoryEn: 'General', labelZh: '重做', labelEn: 'Redo', defaults: [binding('KeyY', { primary: true }), binding('KeyZ', { primary: true, shift: true })] },
  { id: 'view.front', scope: 'global', categoryZh: '视口', categoryEn: 'Viewport', labelZh: '前视图', labelEn: 'Front view', defaults: [binding('Numpad1')] },
  { id: 'view.back', scope: 'global', categoryZh: '视口', categoryEn: 'Viewport', labelZh: '后视图', labelEn: 'Back view', defaults: [binding('Numpad1', { primary: true })] },
  { id: 'view.right', scope: 'global', categoryZh: '视口', categoryEn: 'Viewport', labelZh: '右视图', labelEn: 'Right view', defaults: [binding('Numpad3')] },
  { id: 'view.left', scope: 'global', categoryZh: '视口', categoryEn: 'Viewport', labelZh: '左视图', labelEn: 'Left view', defaults: [binding('Numpad3', { primary: true })] },
  { id: 'view.top', scope: 'global', categoryZh: '视口', categoryEn: 'Viewport', labelZh: '顶视图', labelEn: 'Top view', defaults: [binding('Numpad7')] },
  { id: 'view.bottom', scope: 'global', categoryZh: '视口', categoryEn: 'Viewport', labelZh: '底视图', labelEn: 'Bottom view', defaults: [binding('Numpad7', { primary: true })] },
  { id: 'view.toggleProjection', scope: 'global', categoryZh: '视口', categoryEn: 'Viewport', labelZh: '透视/正交切换', labelEn: 'Toggle perspective', defaults: [binding('Numpad5')] },
  { id: 'view.focus', scope: 'global', categoryZh: '视口', categoryEn: 'Viewport', labelZh: '聚焦当前模型', labelEn: 'Focus selected model', defaults: [binding('KeyF'), binding('NumpadDecimal')] },
  { id: 'scene.arrange', scope: 'global', categoryZh: '对象', categoryEn: 'Objects', labelZh: '自动排列模型', labelEn: 'Arrange models', defaults: [binding('KeyA', { primary: true, shift: true })] },
  { id: 'scene.select', scope: 'scene', categoryZh: '场景工具', categoryEn: 'Scene tools', labelZh: '选择', labelEn: 'Select', defaults: [binding('KeyQ')] },
  { id: 'scene.translate', scope: 'scene', categoryZh: '场景工具', categoryEn: 'Scene tools', labelZh: '移动', labelEn: 'Move', defaults: [binding('KeyW')] },
  { id: 'scene.rotate', scope: 'scene', categoryZh: '场景工具', categoryEn: 'Scene tools', labelZh: '旋转', labelEn: 'Rotate', defaults: [binding('KeyE')] },
  { id: 'scene.scale', scope: 'scene', categoryZh: '场景工具', categoryEn: 'Scene tools', labelZh: '缩放', labelEn: 'Scale', defaults: [binding('KeyR')] },
  { id: 'texture.clearMask', scope: 'texture', categoryZh: '纹理编辑', categoryEn: 'Texture editing', labelZh: '清除蒙版', labelEn: 'Clear mask', defaults: [binding('KeyD', { primary: true, shift: true })] },
  { id: 'texture.duplicateLayer', scope: 'texture', categoryZh: '纹理编辑', categoryEn: 'Texture editing', labelZh: '复制图层', labelEn: 'Duplicate layer', defaults: [binding('KeyD', { primary: true })] },
  { id: 'texture.invertMask', scope: 'texture', categoryZh: '纹理编辑', categoryEn: 'Texture editing', labelZh: '反转蒙版', labelEn: 'Invert mask', defaults: [binding('KeyI', { primary: true })] },
  { id: 'texture.newLayer', scope: 'texture', categoryZh: '纹理编辑', categoryEn: 'Texture editing', labelZh: '新建空图层', labelEn: 'New empty layer', defaults: [binding('KeyN', { primary: true, shift: true })] },
  { id: 'texture.moveLayerUp', scope: 'texture', categoryZh: '纹理编辑', categoryEn: 'Texture editing', labelZh: '上移图层', labelEn: 'Move layer up', defaults: [binding('BracketLeft', { primary: true })] },
  { id: 'texture.moveLayerDown', scope: 'texture', categoryZh: '纹理编辑', categoryEn: 'Texture editing', labelZh: '下移图层', labelEn: 'Move layer down', defaults: [binding('BracketRight', { primary: true })] },
  { id: 'texture.showAllLayers', scope: 'texture', categoryZh: '纹理编辑', categoryEn: 'Texture editing', labelZh: '显示全部图层', labelEn: 'Show all layers', defaults: [binding('KeyH', { alt: true })] },
  { id: 'texture.toggleLayer', scope: 'texture', categoryZh: '纹理编辑', categoryEn: 'Texture editing', labelZh: '切换当前图层显隐', labelEn: 'Toggle active layer', defaults: [binding('KeyH')] },
  { id: 'texture.select', scope: 'texture', categoryZh: '纹理画笔', categoryEn: 'Texture brush', labelZh: '选择工具', labelEn: 'Select tool', defaults: [binding('KeyQ')] },
  { id: 'texture.brushSmaller', scope: 'texture', categoryZh: '纹理画笔', categoryEn: 'Texture brush', labelZh: '减小画笔', labelEn: 'Decrease brush size', defaults: [binding('BracketLeft')] },
  { id: 'texture.brushLarger', scope: 'texture', categoryZh: '纹理画笔', categoryEn: 'Texture brush', labelZh: '增大画笔', labelEn: 'Increase brush size', defaults: [binding('BracketRight')] },
  { id: 'texture.maskAdd', scope: 'texture', categoryZh: '局部重绘', categoryEn: 'Local repaint', labelZh: '添加蒙版', labelEn: 'Add mask', defaults: [binding('KeyK')] },
  { id: 'texture.maskSubtract', scope: 'texture', categoryZh: '局部重绘', categoryEn: 'Local repaint', labelZh: '减去蒙版', labelEn: 'Subtract mask', defaults: [binding('KeyO')] },
  { id: 'texture.localRepaint', scope: 'texture', categoryZh: '局部重绘', categoryEn: 'Local repaint', labelZh: '打开局部重绘', labelEn: 'Open local repaint', defaults: [binding('KeyI')] },
  { id: 'image.move', scope: 'image', categoryZh: '图像编辑器', categoryEn: 'Image editor', labelZh: '移动工具', labelEn: 'Move tool', defaults: [binding('KeyV')] },
  { id: 'image.select', scope: 'image', categoryZh: '图像编辑器', categoryEn: 'Image editor', labelZh: '选区工具', labelEn: 'Selection tool', defaults: [binding('KeyM')] },
  { id: 'image.brush', scope: 'image', categoryZh: '图像编辑器', categoryEn: 'Image editor', labelZh: '画笔', labelEn: 'Brush', defaults: [binding('KeyB')] },
  { id: 'image.eraser', scope: 'image', categoryZh: '图像编辑器', categoryEn: 'Image editor', labelZh: '橡皮', labelEn: 'Eraser', defaults: [binding('KeyE')] },
  { id: 'image.fill', scope: 'image', categoryZh: '图像编辑器', categoryEn: 'Image editor', labelZh: '填充工具', labelEn: 'Fill tool', defaults: [binding('KeyG')] },
  { id: 'image.picker', scope: 'image', categoryZh: '图像编辑器', categoryEn: 'Image editor', labelZh: '吸管工具', labelEn: 'Eyedropper', defaults: [binding('KeyI')] },
  { id: 'image.pan', scope: 'image', categoryZh: '图像编辑器', categoryEn: 'Image editor', labelZh: '临时抓手', labelEn: 'Temporary hand tool', defaults: [binding('Space')] },
  { id: 'image.brushSmaller', scope: 'image', categoryZh: '图像编辑器', categoryEn: 'Image editor', labelZh: '减小画笔', labelEn: 'Decrease brush size', defaults: [binding('BracketLeft')] },
  { id: 'image.brushLarger', scope: 'image', categoryZh: '图像编辑器', categoryEn: 'Image editor', labelZh: '增大画笔', labelEn: 'Increase brush size', defaults: [binding('BracketRight')] },
  { id: 'image.hardnessSofter', scope: 'image', categoryZh: '图像编辑器', categoryEn: 'Image editor', labelZh: '降低硬度', labelEn: 'Decrease hardness', defaults: [binding('BracketLeft', { shift: true })] },
  { id: 'image.hardnessHarder', scope: 'image', categoryZh: '图像编辑器', categoryEn: 'Image editor', labelZh: '提高硬度', labelEn: 'Increase hardness', defaults: [binding('BracketRight', { shift: true })] },
  { id: 'repaint.brush', scope: 'repaint', categoryZh: '重绘蒙版编辑器', categoryEn: 'Repaint mask editor', labelZh: '画笔', labelEn: 'Brush', defaults: [binding('KeyB')] },
  { id: 'repaint.eraser', scope: 'repaint', categoryZh: '重绘蒙版编辑器', categoryEn: 'Repaint mask editor', labelZh: '橡皮', labelEn: 'Eraser', defaults: [binding('KeyE')] },
  { id: 'repaint.brushSmaller', scope: 'repaint', categoryZh: '重绘蒙版编辑器', categoryEn: 'Repaint mask editor', labelZh: '减小画笔', labelEn: 'Decrease brush size', defaults: [binding('BracketLeft')] },
  { id: 'repaint.brushLarger', scope: 'repaint', categoryZh: '重绘蒙版编辑器', categoryEn: 'Repaint mask editor', labelZh: '增大画笔', labelEn: 'Increase brush size', defaults: [binding('BracketRight')] },
];

const definitionById = new Map(SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition]));

export type ShortcutOverrides = Partial<Record<ShortcutActionId, ShortcutBinding[]>>;

type ShortcutStore = {
  activeUserId: string;
  overrides: ShortcutOverrides;
  setActiveUser: (userId?: string) => void;
  setBindings: (actionId: ShortcutActionId, bindings: ShortcutBinding[]) => void;
  replaceOverrides: (overrides: ShortcutOverrides) => void;
  resetAll: () => void;
};

const STORAGE_PREFIX = 'liclick-shortcuts-v1:';

function storageKey(userId: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId || 'anonymous')}`;
}

function loadOverrides(userId: string): ShortcutOverrides {
  if (typeof window === 'undefined') return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(userId)) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([actionId, bindings]) =>
        definitionById.has(actionId as ShortcutActionId) &&
        Array.isArray(bindings) &&
        bindings.every((item) => item && typeof item === 'object' && typeof item.code === 'string'),
      ),
    ) as ShortcutOverrides;
  } catch {
    return {};
  }
}

function saveOverrides(userId: string, overrides: ShortcutOverrides) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey(userId), JSON.stringify(overrides));
}

export const useShortcutStore = create<ShortcutStore>((set, get) => ({
  activeUserId: 'anonymous',
  overrides: loadOverrides('anonymous'),
  setActiveUser: (userId = 'anonymous') => {
    const nextUserId = userId || 'anonymous';
    if (get().activeUserId === nextUserId) return;
    set({ activeUserId: nextUserId, overrides: loadOverrides(nextUserId) });
  },
  setBindings: (actionId, bindings) => {
    const nextOverrides = { ...get().overrides, [actionId]: bindings };
    saveOverrides(get().activeUserId, nextOverrides);
    set({ overrides: nextOverrides });
  },
  replaceOverrides: (overrides) => {
    const nextOverrides = Object.fromEntries(
      Object.entries(overrides).filter(([actionId, bindings]) =>
        definitionById.has(actionId as ShortcutActionId) && Array.isArray(bindings),
      ),
    ) as ShortcutOverrides;
    saveOverrides(get().activeUserId, nextOverrides);
    set({ overrides: nextOverrides });
  },
  resetAll: () => {
    saveOverrides(get().activeUserId, {});
    set({ overrides: {} });
  },
}));

export function getShortcutBindings(actionId: ShortcutActionId) {
  const definition = definitionById.get(actionId);
  return useShortcutStore.getState().overrides[actionId] ?? definition?.defaults ?? [];
}

export function shortcutMatches(event: KeyboardEvent, actionId: ShortcutActionId) {
  const eventPrimary = event.ctrlKey || event.metaKey;
  return getShortcutBindings(actionId).some(
    (item) =>
      item.code === event.code &&
      Boolean(item.primary) === eventPrimary &&
      Boolean(item.shift) === event.shiftKey &&
      Boolean(item.alt) === event.altKey,
  );
}

export function shortcutBindingKey(item: ShortcutBinding) {
  return [item.primary ? 'primary' : '', item.shift ? 'shift' : '', item.alt ? 'alt' : '', item.code]
    .filter(Boolean)
    .join('+');
}

export function formatShortcutBinding(item: ShortcutBinding) {
  const keyLabels: Record<string, string> = {
    Space: 'Space',
    BracketLeft: '[',
    BracketRight: ']',
    NumpadDecimal: 'Num .',
  };
  const codeLabel =
    keyLabels[item.code] ??
    (item.code.startsWith('Key') ? item.code.slice(3) : item.code.replace('Numpad', 'Num '));
  return [item.primary ? 'Ctrl' : '', item.shift ? 'Shift' : '', item.alt ? 'Alt' : '', codeLabel]
    .filter(Boolean)
    .join('+');
}

export function captureShortcutBinding(event: KeyboardEvent): ShortcutBinding | undefined {
  if (['ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight'].includes(event.code)) {
    return undefined;
  }
  return {
    code: event.code,
    primary: event.ctrlKey || event.metaKey || undefined,
    shift: event.shiftKey || undefined,
    alt: event.altKey || undefined,
  };
}
