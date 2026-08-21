import {
  ArrowLeft,
  Box,
  Boxes,
  CheckCircle2,
  Cloud,
  Layers3,
  Map as MapIcon,
  Network,
  Palette,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { UserMenu } from '@/components/auth/UserMenu';
import { BrandMark } from '@/components/common/BrandMark';

type MigrationState = 'engine-ready' | 'browser-planned' | 'cloud-planned' | 'deferred';

type PreservedTool = {
  name: string;
  description: string;
  destination: string;
  state: MigrationState;
  icon: LucideIcon;
};

const statePresentation: Record<MigrationState, { label: string; className: string }> = {
  'engine-ready': {
    label: '引擎能力已具备',
    className: 'border-emerald-300/18 bg-emerald-400/[0.07] text-emerald-100/76',
  },
  'browser-planned': {
    label: '浏览器迁移',
    className: 'border-cyan-300/18 bg-cyan-400/[0.07] text-cyan-100/76',
  },
  'cloud-planned': {
    label: '云端迁移',
    className: 'border-blue-300/18 bg-blue-400/[0.07] text-blue-100/76',
  },
  deferred: {
    label: 'PS/DCC 暂缓',
    className: 'border-amber-300/18 bg-amber-400/[0.07] text-amber-100/72',
  },
};

const preservedTools: PreservedTool[] = [
  {
    name: '模型批量整理',
    description: '批量检查模型、命名、材质和导出规则。',
    destination: '迁移为云端批处理任务，结果以标准文件返回浏览器。',
    state: 'cloud-planned',
    icon: Boxes,
  },
  {
    name: 'UV 辅助工具',
    description: '自动切缝、展开、排布与 UV 质量检查。',
    destination: '复用当前浏览器 xatlas WASM 与 UV Pack 引擎。',
    state: 'engine-ready',
    icon: ScanLine,
  },
  {
    name: 'LiClick 批量图生 3D',
    description: '批量提交参考图并下载云端生成模型。',
    destination: '迁移为用户会话隔离的云端队列，不自动注入 DCC。',
    state: 'cloud-planned',
    icon: Sparkles,
  },
  {
    name: '面加权法线',
    description: '检查并优化硬表面法线与棱角效果。',
    destination: '规划为浏览器 WASM/Worker 工具。',
    state: 'browser-planned',
    icon: Box,
  },
  {
    name: '贴图通道工具',
    description: '贴图通道混合、打包、分离与格式转换。',
    destination: '规划为浏览器本地像素与 GPU 工具。',
    state: 'browser-planned',
    icon: Palette,
  },
  {
    name: 'Max 桥接 Maya / Blender',
    description: '跨 DCC 发送模型、材质和场景。',
    destination: 'DEFERRED_PS_DCC_BRIDGE；仅保留标准文件导入导出边界。',
    state: 'deferred',
    icon: Network,
  },
  {
    name: 'Blender 批量图生 3D',
    description: '生成模型并自动导入 Blender。',
    destination: '云端生成为保留能力；自动注入 Blender 暂缓。',
    state: 'deferred',
    icon: Sparkles,
  },
  {
    name: 'Blender 桥接 Max',
    description: '带材质在 Blender 与 Max 间传递模型。',
    destination: 'DEFERRED_PS_DCC_BRIDGE；不在浏览器中伪造启动能力。',
    state: 'deferred',
    icon: Network,
  },
  {
    name: 'DCC 降版本工具',
    description: 'Max、Maya、Blender 工程文件降版本。',
    destination: '依赖专有 DCC 运行时，随 PS/DCC 集成一并暂缓。',
    state: 'deferred',
    icon: Layers3,
  },
];

function ToolCard({ tool }: { tool: PreservedTool }) {
  const state = statePresentation[tool.state];
  const Icon = tool.icon;
  return (
    <article className="rounded-2xl border border-white/[0.08] bg-[#111321]/86 p-5 shadow-[0_18px_55px_rgba(0,0,0,0.18)]">
      <div className="flex items-start justify-between gap-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-cyan-200/15 bg-cyan-300/[0.07] text-cyan-100/72">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span
          className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${state.className}`}
        >
          {state.label}
        </span>
      </div>
      <h2 className="mt-4 text-base font-semibold text-white/88">{tool.name}</h2>
      <p className="mt-2 text-xs leading-5 text-white/42">{tool.description}</p>
      <p className="mt-4 border-t border-white/[0.06] pt-3 text-[11px] leading-5 text-white/30">
        {tool.destination}
      </p>
    </article>
  );
}

export function ModelingToolboxPage({
  onBack,
  onLogout,
}: {
  onBack: () => void;
  onLogout: () => void;
}) {
  return (
    <main className="li3d-home-surface relative min-h-screen overflow-hidden text-white">
      <div className="pointer-events-none absolute right-[8%] top-24 h-96 w-96 rounded-full bg-cyan-400/[0.055] blur-[110px]" />
      <header className="relative z-10 flex h-16 items-center justify-between border-b border-white/[0.055] px-5 sm:px-8">
        <BrandMark />
        <UserMenu onLogout={onLogout} />
      </header>

      <section className="relative z-[1] mx-auto w-full max-w-[1240px] px-5 pb-20 pt-8 sm:px-8">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm text-white/44 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          返回功能首页
        </button>

        <div className="mt-7 grid gap-5 lg:grid-cols-[1.45fr_0.8fr]">
          <section className="rounded-2xl border border-white/[0.09] bg-[#111321]/90 p-7 shadow-[0_28px_90px_rgba(0,0,0,0.3)] sm:p-9">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/16 bg-cyan-400/[0.075] px-3 py-1.5 text-[11px] font-medium text-cyan-100/72">
              <Wrench className="h-3.5 w-3.5" />
              PRODUCTION TOOLBOX
            </div>
            <h1 className="mt-5 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              工具箱能力保留
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-white/48">
              原有 9 项生产工具全部登记保留。浏览器适合的能力迁移到 WASM、Worker 或
              GPU，批处理能力迁移到云端任务；依赖主机进程的 PS/DCC 桥接暂缓。
            </p>
          </section>

          <aside className="rounded-2xl border border-emerald-300/12 bg-emerald-400/[0.045] p-7">
            <ShieldCheck className="h-7 w-7 text-emerald-200/76" />
            <h2 className="mt-4 text-lg font-semibold">零安装边界不变</h2>
            <ul className="mt-4 space-y-3 text-xs leading-5 text-white/46">
              <li className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-200/70" />
                不下载 EXE、插件或本地守护进程
              </li>
              <li className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-200/70" />
                浏览器工具调用用户 CPU/GPU
              </li>
              <li className="flex gap-2">
                <Cloud className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-200/70" />
                云端工具提交任务并返回标准产物
              </li>
            </ul>
          </aside>
        </div>

        <div className="mt-10 flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white/30">
              PRESERVED INVENTORY
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">原工具清单 · 9/9</h2>
          </div>
          <span className="inline-flex items-center gap-2 text-xs text-white/30">
            <MapIcon className="h-3.5 w-3.5" />
            迁移状态透明展示，无不可用假按钮
          </span>
        </div>

        <div className="mt-5 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {preservedTools.map((tool) => (
            <ToolCard key={tool.name} tool={tool} />
          ))}
        </div>
      </section>
    </main>
  );
}
