import { useEffect, useLayoutEffect, useRef } from 'react';
import { useToastStore } from '@/stores/toastStore';

export function RepaintLayerNotice({ onCreate, onCancel }: {
  onCreate: () => void;
  onCancel: () => void;
}) {
  const callbacks = useRef({ onCreate, onCancel });
  useLayoutEffect(() => { callbacks.current = { onCreate, onCancel }; });
  useEffect(() => {
    const dedupeKey = 'local-repaint:create-layer';
    let finished = false;
    useToastStore.getState().pushToast({
      title: '请先新建绘制图层',
      description: '请新建图层后开始绘制，或选择已有的可见 UV 绘制图层。内容识别填补图层不能直接绘制；后续绘制将继续写入选中的绘制图层。',
      tone: 'warning',
      persistent: true,
      dedupeKey,
      action: {
        label: '新建图层',
        icon: 'add-layer',
        onClick: () => {
          if (finished) return;
          finished = true;
          callbacks.current.onCreate();
        },
      },
    });
    const id = useToastStore.getState().toasts.find(toast => toast.dedupeKey === dedupeKey)?.id;
    const cancelIfDismissed = () => {
      if (finished || (id && useToastStore.getState().toasts.some(toast => toast.id === id))) return;
      finished = true;
      callbacks.current.onCancel();
    };
    const unsubscribe = useToastStore.subscribe(cancelIfDismissed);
    // A higher-priority error may suppress this notice. Allow a subsequent click to retry.
    queueMicrotask(cancelIfDismissed);
    return () => {
      finished = true;
      unsubscribe();
      if (id) useToastStore.getState().dismissToast(id);
    };
  }, []);
  return null;
}
