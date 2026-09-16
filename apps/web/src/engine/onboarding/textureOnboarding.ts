export const tutorials = {
  basic: [
    {
      target: 'import-model',
      title: '导入模型',
      body: '点击对象栏“+”，或把模型拖进视口。模型导入后继续。',
    },
    {
      target: 'reference-images',
      title: '添加参考图',
      body: '添加并选中一张单图或一组六视图，作为纹理参考。',
    },
    {
      target: 'generate-texture',
      title: '生成纹理',
      body: '点击生成，等待纹理生成并应用到模型。生成失败时可重试，引导进度会保留。',
    },
  ],
  single: [
    {
      target: 'single-view',
      title: '切换到单视图',
      body: '在生成面板选择单视图，调整到想修改的角度。',
    },
    {
      target: 'generate-texture',
      title: '调整当前视角',
      body: '设置参考图和提示词，再生成一次纹理。查看结果后，可继续调整其他角度。',
    },
  ],
  repaint: [
    {
      target: 'repaint-mask',
      title: '画出修改范围',
      body: '选择蒙版画笔，在模型上涂出需要修改的区域。画出范围后继续。',
    },
    {
      target: 'repaint-generate',
      title: '生成局部效果',
      body: '填写修改要求，点击局部生图，等待结果准备好。',
    },
    {
      target: 'repaint-apply',
      title: '涂抹应用结果',
      body: '选择重绘画笔，在蒙版范围内涂抹，查看模型上的效果。确认完成后结束本教程。',
      confirm: true,
    },
  ],
} satisfies Record<string, { target: string; title: string; body: string; confirm?: boolean }[]>;

export type Tutorial = keyof typeof tutorials;
export type TourProgress = {
  track: Tutorial;
  step: number;
  status: 'active' | 'paused' | 'done';
  review: boolean;
  generationBefore?: string;
};
const session = new Map<string, TourProgress>();
export const tourStorageKey = (id: string) => `li3d:texture-onboarding:v3:${id}`;

export function saveTour(storage: Pick<Storage, 'setItem'>, id: string, progress: TourProgress) {
  session.set(id, progress);
  try {
    storage.setItem(tourStorageKey(id), JSON.stringify(progress));
  } catch {
    /* Session fallback. */
  }
}

export function loadTour(
  storage: Pick<Storage, 'getItem'>,
  id: string,
  start: boolean,
): TourProgress {
  if (session.has(id)) return session.get(id)!;
  const initial: TourProgress = {
    track: 'basic',
    step: 0,
    status: start ? 'active' : 'paused',
    review: false,
  };
  try {
    const raw = storage.getItem(tourStorageKey(id));
    if (raw) {
      const saved = JSON.parse(raw) as TourProgress;
      if (
        Object.hasOwn(tutorials, saved.track) &&
        Number.isInteger(saved.step) &&
        saved.step >= 0 &&
        saved.step < tutorials[saved.track].length &&
        ['active', 'paused', 'done'].includes(saved.status) &&
        typeof saved.review === 'boolean' &&
        (saved.generationBefore === undefined || typeof saved.generationBefore === 'string')
      )
        return saved;
    }
    const legacy =
      storage.getItem(`li3d:texture-onboarding:v2:${id}`) ??
      storage.getItem(`li3d:texture-onboarding:v1:${id}`);
    if (legacy !== null) {
      if (legacy === 'done' || (Number.isInteger(Number(legacy)) && Number(legacy) >= 3))
        return { ...initial, step: 2, status: 'done' };
      const step = Number(legacy);
      return {
        ...initial,
        step: Number.isInteger(step) && step >= 0 && step < 3 ? step : 0,
        status: 'paused',
      };
    }
  } catch {
    /* Invalid/unavailable storage must not prevent opening the editor. */
  }
  return initial;
}

export function nextTour(progress: TourProgress): TourProgress {
  return progress.step + 1 < tutorials[progress.track].length
    ? { ...progress, step: progress.step + 1 }
    : { ...progress, status: 'done', review: false };
}

export type TourRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};
/** Keep the measured card outside the target; collapse when no free area can fit it. */
export function placeTourCard(
  rect: TourRect | undefined,
  width: number,
  height: number,
  vw: number,
  vh: number,
) {
  const clamp = (value: number, limit: number) => Math.max(12, Math.min(value, limit - 12));
  if (!rect) return { left: Math.max(12, vw - width - 16), top: 72, compact: false };
  const x = clamp(rect.left, vw - width),
    y = clamp(rect.top, vh - height);
  const candidates = [
    { left: rect.right + 16, top: y },
    { left: rect.left - width - 16, top: y },
    { left: x, top: rect.top - height - 16 },
    { left: x, top: rect.bottom + 16 },
  ];
  const position = candidates.find(
    (p) => p.left >= 12 && p.top >= 12 && p.left + width <= vw - 12 && p.top + height <= vh - 12,
  );
  return position ? { ...position, compact: false } : { left: 16, top: 72, compact: true };
}
