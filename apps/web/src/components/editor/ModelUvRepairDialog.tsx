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
          <p>简化会改变网格，可能损失细节或影响已有纹理。若简化后的 UV 存在问题，会再次询问是否重新展开 UV；重新展开会改变 UV 布局，可能导致原纹理与模型不匹配。</p>
          <p>您也可以取消导入，先自行简化模型并检查纹理，再导入 Li3D。</p>
        </> : <><p>检测到：{[
          pending.report.outside && `${pending.report.outside} 个面 UV 超出 0–1`,
          pending.report.degenerate && `${pending.report.degenerate} 个面 UV 压成线或点`,
          pending.report.missing && `${pending.report.missing} 个面缺少 UV`,
          pending.report.invalid && `${pending.report.invalid} 个面 UV 数值无效`,
        ].filter(Boolean).join('；')}。</p>
        <p>同意后将上传模型，由服务器 Blender 重新展开、排布 UV，并按需内缩。原 UV 布局会改变，已有贴图可能错位。</p>
        </>}
        <p>原文件不会被覆盖。取消或修复失败，本次模型不会导入。</p>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button autoFocus className="rounded-lg border border-white/25 px-4 py-2 text-sm" onClick={() => finish(false)}>取消导入</button>
        <button className="rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-semibold" onClick={() => finish(true)}>{pending.operation === 'decimate' ? '同意减面并继续' : '同意修改 UV 并导入'}</button>
      </div>
    </dialog>, document.body) : null;
  return { confirm, dialog };
}
