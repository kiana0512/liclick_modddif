import { useEffect, useRef } from 'react';

export function RepaintLayerDialog({ onCreate, onCancel }: {
  onCreate: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog ref={dialog} aria-labelledby="repaint-layer-title"
      onCancel={onCancel} onKeyDown={(event) => event.stopPropagation()}
      className="m-auto w-[420px] max-w-[90vw] rounded-xl border border-white/20 bg-[#181824] p-6 text-white backdrop:bg-black/60">
      <h2 id="repaint-layer-title" className="text-base font-semibold">请先新建绘制图层</h2>
      <p className="mt-3 text-sm leading-6 text-white/70">
        局部重绘需要一个可见的 UV 图层。新建后，后续绘制和新的生成结果都会写入选中的图层，不会自动新建。
        已有 UV 图层时，也可以取消后在图层面板中选择它；隐藏的图层请先开启可见性。
      </p>
      <div className="mt-5 flex justify-end gap-3">
        <button autoFocus className="rounded px-3 py-2 text-sm hover:bg-white/10" onClick={onCancel}>取消</button>
        <button className="rounded bg-fuchsia-600 px-3 py-2 text-sm hover:bg-fuchsia-500" onClick={onCreate}>新建图层并开始绘制</button>
      </div>
    </dialog>
  );
}
