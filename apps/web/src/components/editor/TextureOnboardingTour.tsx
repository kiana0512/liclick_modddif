import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, MousePointerClick, X } from 'lucide-react';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';

type TextureOnboardingTourProps = {
  projectId: string;
  projectCreatedAt: string;
};

type TourTarget =
  | 'import-model'
  | 'reference-images'
  | 'generate-texture'
  | 'edit-tools'
  | 'single-view';

type TourStep = {
  target: TourTarget;
  eyebrow: string;
  title: string;
  body: string;
  placement: 'right' | 'above';
};

type TargetRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

const TOUR_VERSION = 1;
const NEW_PROJECT_WINDOW_MS = 30 * 60 * 1000;
const TARGET_PADDING = 8;
const CARD_WIDTH = 304;
const CARD_HEIGHT_ESTIMATE = 174;
const STEP_COMPLETION_DELAY_MS = 280;

const tourSteps: TourStep[] = [
  {
    target: 'import-model',
    eyebrow: '第一步',
    title: '导入模型',
    body: '点击对象栏“+”，或把模型直接拖进视口。',
    placement: 'right',
  },
  {
    target: 'reference-images',
    eyebrow: '第二步',
    title: '添加参考图',
    body: '单图、多视图任选；只有单图时会自动补全多视图。',
    placement: 'right',
  },
  {
    target: 'generate-texture',
    eyebrow: '第三步',
    title: '生成纹理',
    body: '点击底部按钮，即可生成纹理贴图。',
    placement: 'above',
  },
  {
    target: 'single-view',
    eyebrow: '第四步 · 1/2',
    title: '修改单视图',
    body: '切换到单视图，修改想要调整视角的纹理。',
    placement: 'right',
  },
  {
    target: 'edit-tools',
    eyebrow: '第四步 · 2/2',
    title: '橡皮擦与局部重绘',
    body: '橡皮擦清理选中图层的纹理\n局部修改按蒙版 → 局部生图 → 重绘使用。',
    placement: 'above',
  },
];

function getStorageKey(projectId: string) {
  return `li3d:texture-onboarding:v${TOUR_VERSION}:${projectId}`;
}

function readSavedStep(storageKey: string) {
  try {
    const value = window.localStorage.getItem(storageKey);
    if (value === 'done') return { done: true, step: 0, exists: true };
    const parsed = Number(value);
    return {
      done: false,
      step: Number.isInteger(parsed) && parsed >= 0 && parsed < tourSteps.length ? parsed : 0,
      exists: value !== null,
    };
  } catch {
    return { done: false, step: 0, exists: false };
  }
}

function writeSavedStep(storageKey: string, value: number | 'done') {
  try {
    window.localStorage.setItem(storageKey, String(value));
  } catch {
    // The tour still works for this session when storage is unavailable.
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function sameRect(left: TargetRect | undefined, right: TargetRect) {
  if (!left) return false;
  return (
    Math.abs(left.left - right.left) < 0.5 &&
    Math.abs(left.top - right.top) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5 &&
    Math.abs(left.height - right.height) < 0.5
  );
}

export function TextureOnboardingTour({ projectId, projectCreatedAt }: TextureOnboardingTourProps) {
  const storageKey = useMemo(() => getStorageKey(projectId), [projectId]);
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect>();
  const setMode = useWorkspaceLayoutStore((state) => state.setMode);
  const showPanel = useWorkspaceLayoutStore((state) => state.showPanel);
  const setPanelCollapsed = useWorkspaceLayoutStore((state) => state.setPanelCollapsed);
  const step = tourSteps[stepIndex];

  useEffect(() => {
    const saved = readSavedStep(storageKey);
    const forcePreview = new URLSearchParams(window.location.search).get('textureTour') === '1';
    const createdAt = Date.parse(projectCreatedAt);
    const isNewProject =
      Number.isFinite(createdAt) &&
      Date.now() - createdAt >= 0 &&
      Date.now() - createdAt <= NEW_PROJECT_WINDOW_MS;
    setStepIndex(forcePreview ? 0 : saved.step);
    setActive(forcePreview || (!saved.done && (isNewProject || saved.exists)));
  }, [projectCreatedAt, storageKey]);

  useEffect(() => {
    if (!active) return;
    setMode('texture');
    showPanel('objects');
    showPanel('generate');
    setPanelCollapsed('objects', false);
    setPanelCollapsed('generate', false);
  }, [active, setMode, setPanelCollapsed, showPanel]);

  const finish = useCallback(() => {
    writeSavedStep(storageKey, 'done');
    setActive(false);
    setTargetRect(undefined);
  }, [storageKey]);

  const advance = useCallback(() => {
    if (stepIndex >= tourSteps.length - 1) {
      finish();
      return;
    }
    const nextStep = stepIndex + 1;
    writeSavedStep(storageKey, nextStep);
    setStepIndex(nextStep);
  }, [finish, stepIndex, storageKey]);

  useEffect(() => {
    if (!active || !step) return undefined;
    let frame = 0;
    let target: HTMLElement | null = null;
    let observer: ResizeObserver | undefined;
    let completionTimer: number | undefined;
    let completionScheduled = false;

    const scheduleAdvanceWhenCompleted = (element: HTMLElement | null) => {
      if (completionScheduled || element?.dataset.onboardingComplete !== 'true') return;
      completionScheduled = true;
      completionTimer = window.setTimeout(advance, STEP_COMPLETION_DELAY_MS);
    };

    const updateTarget = () => {
      target = document.querySelector<HTMLElement>(`[data-texture-onboarding="${step.target}"]`);
      if (!target) {
        setTargetRect(undefined);
        return;
      }
      scheduleAdvanceWhenCompleted(target);
      const rect = target.getBoundingClientRect();
      const nextRect: TargetRect = {
        left: clamp(rect.left - TARGET_PADDING, 8, window.innerWidth - 8),
        top: clamp(rect.top - TARGET_PADDING, 8, window.innerHeight - 8),
        right: clamp(rect.right + TARGET_PADDING, 8, window.innerWidth - 8),
        bottom: clamp(rect.bottom + TARGET_PADDING, 8, window.innerHeight - 8),
        width: Math.min(rect.width + TARGET_PADDING * 2, window.innerWidth - 16),
        height: Math.min(rect.height + TARGET_PADDING * 2, window.innerHeight - 16),
      };
      nextRect.width = Math.max(1, nextRect.right - nextRect.left);
      nextRect.height = Math.max(1, nextRect.bottom - nextRect.top);
      setTargetRect((current) => (sameRect(current, nextRect) ? current : nextRect));
    };

    const revealTarget = () => {
      const element = document.querySelector<HTMLElement>(
        `[data-texture-onboarding="${step.target}"]`,
      );
      element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      updateTarget();
      if (element && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(updateTarget);
        observer.observe(element);
      }
    };

    frame = window.requestAnimationFrame(revealTarget);
    const retryTimer = window.setInterval(updateTarget, 350);
    window.addEventListener('resize', updateTarget);
    window.addEventListener('scroll', updateTarget, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(retryTimer);
      window.removeEventListener('resize', updateTarget);
      window.removeEventListener('scroll', updateTarget, true);
      if (completionTimer !== undefined) window.clearTimeout(completionTimer);
      observer?.disconnect();
    };
  }, [active, advance, step]);

  useEffect(() => {
    if (!active) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, finish]);

  if (!active || !step || typeof document === 'undefined') return null;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const cardWidth = Math.min(CARD_WIDTH, viewportWidth - 32);
  const preferredRight = targetRect && targetRect.right + 18 + cardWidth <= viewportWidth - 16;
  const preferredAbove = targetRect && targetRect.top >= CARD_HEIGHT_ESTIMATE + 24;
  const placement =
    step.placement === 'right' && preferredRight
      ? 'right'
      : preferredAbove
        ? 'above'
        : targetRect && targetRect.bottom + CARD_HEIGHT_ESTIMATE + 18 <= viewportHeight
          ? 'below'
          : 'center';
  const cardLeft = !targetRect
    ? (viewportWidth - cardWidth) / 2
    : placement === 'right'
      ? targetRect.right + 18
      : clamp(
          targetRect.left + targetRect.width / 2 - cardWidth / 2,
          16,
          viewportWidth - cardWidth - 16,
        );
  const cardTop = !targetRect
    ? (viewportHeight - CARD_HEIGHT_ESTIMATE) / 2
    : placement === 'right'
      ? clamp(
          targetRect.top + targetRect.height / 2 - CARD_HEIGHT_ESTIMATE / 2,
          16,
          viewportHeight - CARD_HEIGHT_ESTIMATE - 16,
        )
      : placement === 'above'
        ? targetRect.top - CARD_HEIGHT_ESTIMATE - 18
        : placement === 'below'
          ? targetRect.bottom + 18
          : (viewportHeight - CARD_HEIGHT_ESTIMATE) / 2;
  const isLastStep = stepIndex === tourSteps.length - 1;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[180] text-white" aria-live="polite">
      {targetRect ? (
        <div
          className="pointer-events-none fixed rounded-xl border-2 border-liclick-pink shadow-[0_0_0_4px_rgba(236,72,189,0.16),0_0_34px_rgba(236,72,189,0.42)]"
          style={{
            left: targetRect.left,
            top: targetRect.top,
            width: targetRect.width,
            height: targetRect.height,
          }}
        />
      ) : null}

      <button
        type="button"
        className="hidden"
        aria-label={isLastStep ? '完成新手引导' : '下一条新手引导'}
      />

      <section
        role="dialog"
        aria-modal="false"
        aria-label={`${step.eyebrow}：${step.title}`}
        tabIndex={0}
        className="pointer-events-auto fixed z-[182] overflow-hidden rounded-xl border border-white/16 bg-[#17131f]/98 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.66)] backdrop-blur-xl outline-none"
        style={{ left: cardLeft, top: cardTop, width: cardWidth }}
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-liclick-pink to-liclick-purple" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold tracking-[0.14em] text-liclick-pink">
              {step.eyebrow}
            </div>
            <h2 className="mt-1 text-lg font-bold text-white">{step.title}</h2>
          </div>
          <button
            type="button"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/48 transition hover:bg-white/10 hover:text-white"
            aria-label="跳过引导"
            title="跳过引导"
            onClick={(event) => {
              event.stopPropagation();
              finish();
            }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 whitespace-pre-line text-sm leading-6 text-white/72">{step.body}</p>
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/10 pt-3">
          <div
            className="flex items-center gap-1.5"
            aria-label={`引导 ${stepIndex + 1}/${tourSteps.length}`}
          >
            {tourSteps.map((item, index) => (
              <span
                key={item.target}
                className={`h-1.5 rounded-full transition-all ${
                  index === stepIndex
                    ? 'w-5 bg-liclick-pink'
                    : index < stepIndex
                      ? 'w-1.5 bg-white/48'
                      : 'w-1.5 bg-white/18'
                }`}
              />
            ))}
          </div>
          <span className="flex items-center gap-1.5 text-xs font-semibold text-white/70">
            {isLastStep ? (
              <>
                <Check className="h-3.5 w-3.5" /> 完成当前操作后结束引导
              </>
            ) : (
              <>
                <MousePointerClick className="h-3.5 w-3.5" /> 完成当前操作后自动继续
              </>
            )}
          </span>
        </div>
      </section>
    </div>,
    document.body,
  );
}
