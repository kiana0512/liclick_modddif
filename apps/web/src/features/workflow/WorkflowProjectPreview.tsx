import { Box, ScanLine } from 'lucide-react';
import type { Project } from '@/types/project';

export function WorkflowProjectPreview({
  project,
  caption,
}: {
  project?: Project;
  caption: string;
}) {
  const hasThumbnail = Boolean(project?.thumbnail && !project.thumbnail.includes('placeholder'));

  return (
    <div className="workflow-preview-grid relative min-h-0 flex-1 overflow-hidden rounded-xl border border-white/10 bg-[#080914]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(139,92,246,0.13),transparent_42%)]" />
      <div className="absolute left-4 top-4 flex items-center gap-2 rounded-md border border-white/10 bg-black/42 px-2.5 py-1.5 text-[11px] text-white/58 backdrop-blur">
        <ScanLine className="h-3.5 w-3.5 text-liclick-orange" />
        {caption}
      </div>
      <div className="relative grid h-full min-h-[360px] place-items-center p-12">
        {hasThumbnail ? (
          <img
            src={project?.thumbnail}
            alt={`${project?.name ?? '项目'}预览`}
            className="max-h-full max-w-full object-contain drop-shadow-[0_32px_54px_rgba(0,0,0,0.5)]"
            loading="eager"
            decoding="async"
          />
        ) : (
          <div className="grid place-items-center text-center">
            <div className="grid h-28 w-28 place-items-center rounded-[28px] border border-liclick-purple/30 bg-liclick-purple/10 shadow-glow">
              <Box className="h-14 w-14 text-white/72" strokeWidth={1.25} />
            </div>
            <p className="mt-5 text-sm font-medium text-white/72">等待项目预览</p>
            <p className="mt-1 max-w-xs text-xs leading-5 text-white/36">
              返回模块 1 保存项目缩略图后，这里将自动显示同一资产。
            </p>
          </div>
        )}
      </div>
      <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between text-[11px] text-white/38">
        <span>{project?.objects.length ?? 0} 个场景对象</span>
        <span>轻量预览 · 未加载 3D 引擎</span>
      </div>
    </div>
  );
}
