import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelUvReport } from '@/engine/loaders/modelUvValidation';

export function useModelUvRepairConfirmation() {
  const [pending, setPending] = useState<{ name: string; report: ModelUvReport; operation: 'uv' | 'decimate' }>();
  const resolveRef = useRef<(accepted: boolean) => void>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const finish = useCallback((accepted: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = undefined;
    setPending(undefined);
    resolve?.(accepted);
  }, []);
  useEffect(() => () => resolveRef.current?.(false), []);
  useEffect(() => { if (pending) dialogRef.current?.showModal(); }, [pending]);
  const confirm = useCallback((name: string, report: ModelUvReport, signal: AbortSignal, operation: 'uv' | 'decimate' = 'uv') =>
    new Promise<boolean>(resolve => {
      if (signal.aborted) { resolve(false); return; }
      const abort = () => finish(false);
      signal.addEventListener('abort', abort, { once: true });
      resolveRef.current = accepted => { signal.removeEventListener('abort', abort); resolve(accepted); };
      setPending({ name, report, operation });
    }), [finish]);
  const dialog = pending ? createPortal(
    <dialog ref={dialogRef} data-editor-shortcut-scope="uv-repair" aria-labelledby="uv-repair-title" aria-describedby="uv-repair-description"
      className="w-[min(480px,90vw)] rounded-xl border border-white/20 bg-[#17171f] p-6 text-white backdrop:bg-black/60"
      onCancel={event => { event.preventDefault(); finish(false); }} onClose={() => finish(false)}
      onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      <h2 id="uv-repair-title" className="text-lg font-semibold">{pending.operation === 'decimate' ? '模型面数较高，需要减面' : '模型 UV 需要修复'}</h2>
      <p className="mt-2 break-all text-sm text-white/70">{pending.name}</p>
      <div id="uv-repair-description" className="mt-4 space-y-2 text-sm leading-6">
        {pending.operation === 'decimate' ? <>
          <p>当前模型有 {pending.report.triangles.toLocaleString('zh-CN')} 个三角面，超过 150 万面的导入限制。</p>
          <p>减面可能导致模型细节丢失、轮廓变化，以及已有贴图拉伸或错位。</p>
          <p>如果不希望出现这些影响，请取消导入，自行手动减面至 150 万个三角面以内，确认模型和贴图效果后重新上传。</p>
        </> : <><p>检测到：{[
          pending.report.outside && `${pending.report.outside} 个面 UV 超出 0–1`,
          pending.report.degenerate && `${pending.report.degenerate} 个面 UV 压成线或点`,
          pending.report.missing && `${pending.report.missing} 个面缺少 UV`,
          pending.report.invalid && `${pending.report.invalid} 个面 UV 数值无效`,
        ].filter(Boolean).join('；')}。</p>
        <p>同意后将上传模型，先按距离合并近距离顶点，再重新展开、排布 UV，并按需内缩。网格连接和原 UV 布局会改变，已有贴图可能错位。</p>
        </>}
        <p>{pending.operation === 'decimate' ? '原文件不会被覆盖。取消或处理失败，本次模型不会导入。' : '原文件不会被覆盖。取消或修复失败，本次模型不会导入。'}</p>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button autoFocus className="rounded-lg border border-white/25 px-4 py-2 text-sm" onClick={() => finish(false)}>取消导入</button>
        <button className="rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-semibold" onClick={() => finish(true)}>{pending.operation === 'decimate' ? '同意减面并继续' : '同意修改 UV 并导入'}</button>
      </div>
    </dialog>, document.body) : null;
  return { confirm, dialog };
}
