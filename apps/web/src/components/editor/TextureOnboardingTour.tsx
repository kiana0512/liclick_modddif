import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import {
  loadTour,
  nextTour,
  placeTourCard,
  saveTour,
  tutorials,
  type TourProgress,
  type TourRect,
  type Tutorial,
} from '@/engine/onboarding/textureOnboarding';

type TextureOnboardingTourProps = {
  projectId: string;
  projectCreatedAt: string;
  forceStart?: boolean;
  suspended?: boolean;
};
const labels: Record<Tutorial, string> = {
  basic: '基础入门',
  single: '单视图调整',
  repaint: '局部重绘',
};
const buttonClass =
  'rounded-md border border-white/20 px-3 py-1.5 text-xs hover:bg-white/10 disabled:opacity-40';
const fallbackStorage = { getItem: () => null, setItem: () => undefined };
function storage() {
  try {
    return window.localStorage;
  } catch {
    return fallbackStorage;
  }
}
function findTarget(target: string) {
  return [...document.querySelectorAll<HTMLElement>(`[data-texture-onboarding="${target}"]`)].find(
    (element) =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
  );
}

export function TextureOnboardingTour({
  projectId,
  projectCreatedAt,
  forceStart = false,
  suspended = false,
}: TextureOnboardingTourProps) {
  const [progress, setProgress] = useState<TourProgress>(() => {
    const forcePreview =
      forceStart || new URLSearchParams(window.location.search).get('textureTour') === '1';
    const age = Date.now() - Date.parse(projectCreatedAt);
    return loadTour(storage(), projectId, forcePreview || (age >= 0 && age <= 30 * 60 * 1000));
  });
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [targetRect, setTargetRect] = useState<TourRect>();
  const [complete, setComplete] = useState(false);
  const [cardHeight, setCardHeight] = useState(230);
  const [, setViewportRevision] = useState(0);
  const cardRef = useRef<HTMLElement>(null);
  const mode = useWorkspaceLayoutStore((state) => state.mode);
  const initialLaunch = useRef(progress.status === 'active');
  useEffect(() => {
    if (!initialLaunch.current) return;
    initialLaunch.current = false;
    useWorkspaceLayoutStore.getState().setMode('texture');
  }, []);
  const step = tutorials[progress.track][progress.step];
  const active = progress.status === 'active' && !suspended && mode === 'texture';
  const confirm = 'confirm' in step && step.confirm;
  const update = useCallback(
    (value: TourProgress) => {
      saveTour(storage(), projectId, value);
      setComplete(false);
      setTargetRect(undefined);
      setProgress(value);
    },
    [projectId],
  );
  useEffect(() => {
    saveTour(storage(), projectId, progress);
  }, [projectId, progress]);
  const pause = useCallback(() => update({ ...progress, status: 'paused' }), [progress, update]);
  const advance = useCallback(() => update(nextTour(progress)), [progress, update]);

  const reveal = useCallback(() => {
    const layout = useWorkspaceLayoutStore.getState();
    layout.setMode('texture');
    const panel = step.target === 'import-model' ? 'objects' : 'generate';
    layout.showPanel(panel);
    layout.setPanelCollapsed(panel, false);
    // Wait for the expanded panel to mount before locating its operation.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        findTarget(step.target)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
      ),
    );
  }, [step.target]);

  useEffect(() => {
    if (!active) return;
    let completedAt = 0;
    const inspect = () => {
      const target = findTarget(step.target);
      const rect = target?.getBoundingClientRect();
      const visible =
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < innerHeight &&
        rect.right > 0 &&
        rect.left < innerWidth;
      const next = visible
        ? {
            left: Math.max(8, rect.left - 6),
            top: Math.max(8, rect.top - 6),
            right: Math.min(innerWidth - 8, rect.right + 6),
            bottom: Math.min(innerHeight - 8, rect.bottom + 6),
            width: 0,
            height: 0,
          }
        : undefined;
      if (next) {
        next.width = next.right - next.left;
        next.height = next.bottom - next.top;
      }
      setTargetRect((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
      const freshResult =
        (progress.track === 'single' && progress.step === 1) ||
        (progress.track === 'repaint' && progress.step === 1);
      if (freshResult && target && progress.generationBefore === undefined) {
        update({ ...progress, generationBefore: target.dataset.onboardingGeneration ?? '' });
        return;
      }
      const ready = Boolean(
        visible &&
        target?.dataset.onboardingComplete === 'true' &&
        (!freshResult ||
          (target.dataset.onboardingGeneration &&
            target.dataset.onboardingGeneration !== progress.generationBefore)) &&
        (progress.track !== 'single' ||
          progress.step !== 1 ||
          target.dataset.onboardingView === 'single'),
      );
      setComplete(ready);
      if (ready && !progress.review && !confirm && !menu && !collapsed) {
        if (!completedAt) completedAt = Date.now();
        if (Date.now() - completedAt >= 500) advance();
      } else completedAt = 0;
    };
    inspect();
    const timer = window.setInterval(inspect, 350);
    const resize = () => {
      setViewportRevision((value) => value + 1);
      inspect();
    };
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', inspect, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', inspect, true);
    };
  }, [active, advance, collapsed, confirm, menu, progress, step.target, update]);

  useEffect(() => {
    if (!active && !menu) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menu) setMenu(false);
      else pause();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [active, menu, pause]);
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const observer = new ResizeObserver(() => setCardHeight(card.getBoundingClientRect().height));
    observer.observe(card);
    return () => observer.disconnect();
  }, [active, collapsed, menu]);

  const start = (track: Tutorial) => {
    const generationTarget = document.querySelector<HTMLElement>(
      `[data-texture-onboarding="${track === 'repaint' ? 'repaint-generate' : 'generate-texture'}"]`,
    );
    update({
      track,
      step: 0,
      status: 'active',
      review: track === 'basic',
      generationBefore: generationTarget
        ? (generationTarget.dataset.onboardingGeneration ?? '')
        : undefined,
    });
    setMenu(false);
    setCollapsed(false);
    useWorkspaceLayoutStore.getState().setMode('texture');
  };
  if (suspended) return null;
  const width = Math.min(304, innerWidth - 32);
  const position = placeTourCard(targetRect, width, cardHeight, innerWidth, innerHeight);
  const compact = collapsed || position.compact;
  const launcher = !active || compact;
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[180] text-white" aria-live="polite">
      {active && targetRect && !menu && !compact && (
        <div
          className="pointer-events-none fixed rounded-xl border-2 border-liclick-pink"
          style={{
            left: targetRect.left,
            top: targetRect.top,
            width: targetRect.width,
            height: targetRect.height,
          }}
        />
      )}
      {(launcher || menu) && (
        <div className="pointer-events-auto fixed right-4 top-[72px] max-w-[calc(100vw-32px)]">
          <button
            className={`${buttonClass} bg-[#17131f]`}
            onClick={() => setMenu(!menu)}
            aria-expanded={menu}
          >
            {active
              ? `${labels[progress.track]} ${progress.step + 1}/${tutorials[progress.track].length}`
              : progress.status === 'done'
                ? '引导已完成 · 进阶教程'
                : '新手引导'}
          </button>
          {menu && (
            <section
              aria-label="新手引导菜单"
              className="mt-2 grid w-[280px] max-w-full gap-2 rounded-xl border border-white/20 bg-[#17131f] p-4 shadow-xl"
            >
              {active && (
                <>
                  <p className="text-sm font-semibold">{step.title}</p>
                  <p className="text-sm text-white/75">{step.body}</p>
                  {(progress.review || confirm) && (
                    <button
                      className={buttonClass}
                      disabled={!complete}
                      onClick={() => {
                        advance();
                        setMenu(false);
                      }}
                    >
                      {confirm ? '已涂抹并确认效果' : '下一步'}
                    </button>
                  )}
                </>
              )}
              <p className="mb-1 text-sm text-white/70">
                基础三步：导入模型 → 添加参考图 → 生成纹理
              </p>
              {progress.status !== 'done' && (
                <button
                  className={buttonClass}
                  onClick={() => {
                    update({ ...progress, status: 'active' });
                    setMenu(false);
                    setCollapsed(false);
                    reveal();
                  }}
                >
                  继续{labels[progress.track]} · 第 {progress.step + 1} 步
                </button>
              )}
              <button className={buttonClass} onClick={() => start('basic')}>
                重新学习基础入门
              </button>
              <button className={buttonClass} onClick={() => start('single')}>
                选学：单视图调整
              </button>
              <button className={buttonClass} onClick={() => start('repaint')}>
                选学：局部重绘
              </button>
              {active && (
                <button
                  className={buttonClass}
                  onClick={() => {
                    pause();
                    setMenu(false);
                  }}
                >
                  暂停引导
                </button>
              )}
              <button className={buttonClass} onClick={() => setMenu(false)}>
                收起菜单
              </button>
            </section>
          )}
        </div>
      )}
      {active && !compact && !menu && (
        <section
          ref={cardRef}
          role="dialog"
          aria-modal="false"
          aria-label={`${labels[progress.track]}：${step.title}`}
          className="pointer-events-auto fixed rounded-xl border border-white/20 bg-[#17131f] p-4 shadow-xl"
          style={{
            left: position.left,
            top: position.top,
            width,
            maxHeight: 'calc(100vh - 96px)',
            overflowY: 'auto',
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs text-liclick-pink">
                {labels[progress.track]} · {progress.step + 1}/{tutorials[progress.track].length}
              </div>
              <h2 className="mt-1 text-lg font-bold">{step.title}</h2>
            </div>
            <button
              className="rounded p-1 hover:bg-white/10"
              aria-label="暂停引导"
              title="暂停，下次可继续"
              onClick={pause}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-2 text-sm leading-6 text-white/75">{step.body}</p>
          {!targetRect && (
            <p className="mt-2 text-xs text-white/60">
              操作区暂未显示，请先定位；如仍未出现，请先导入并选中模型。
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {progress.step > 0 && (
              <button
                className={buttonClass}
                onClick={() => update({ ...progress, step: progress.step - 1, review: true })}
              >
                上一步
              </button>
            )}
            <button className={buttonClass} onClick={reveal}>
              定位操作区
            </button>
            <button className={buttonClass} onClick={() => setCollapsed(true)}>
              收起
            </button>
            {(progress.review || confirm) && (
              <button className={buttonClass} disabled={!complete} onClick={advance}>
                {confirm
                  ? '已涂抹并确认效果'
                  : progress.step === tutorials[progress.track].length - 1
                    ? '完成引导'
                    : '下一步'}
              </button>
            )}
          </div>
        </section>
      )}
    </div>,
    document.body,
  );
}
