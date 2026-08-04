import {
  ArrowLeft,
  BookOpen,
  Box,
  Boxes,
  Check,
  Download,
  ExternalLink,
  Layers3,
  MonitorDown,
  Network,
  Palette,
  ScanLine,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { UserMenu } from '@/components/auth/UserMenu';
import { BrandMark } from '@/components/common/BrandMark';
import { downloadBlob } from '@/engine/export/exportUtils';
import { trackModuleAction } from '@/services/telemetryClient';

type ToolItem = {
  name: string;
  description: string;
  icon: LucideIcon;
};

type ToolCategory = {
  eyebrow: string;
  title: string;
  description: string;
  accent: 'orange' | 'violet' | 'cyan';
  tools: ToolItem[];
};

const toolboxRoot = `${import.meta.env.BASE_URL}toolbox/`;

const categories: ToolCategory[] = [
  {
    eyebrow: '3DS MAX',
    title: 'Max 工具箱',
    description: '安装到 3ds Max 顶部“我的工具”工具栏。',
    accent: 'orange',
    tools: [
      { name: '模型批量整理', description: '批量整理、检查与导出模型', icon: Boxes },
      { name: 'UV 辅助工具', description: 'UV 精度调整与 Rizom UV 桥接', icon: ScanLine },
      { name: 'LiClick 批量图生 3D', description: '选图生成模型并自动导入场景', icon: Sparkles },
      { name: 'Max 桥接 Maya / Blender', description: '模型与场景跨 DCC 保真传递', icon: Network },
      { name: '面加权法线', description: '优化硬表面棱角与法线效果', icon: Box },
    ],
  },
  {
    eyebrow: 'BLENDER',
    title: 'Blender 工具箱',
    description: '安装到 Blender 插件目录，按需启用。',
    accent: 'violet',
    tools: [
      { name: 'Blender 批量图生 3D', description: '批量生成并自动导入 Blender', icon: Sparkles },
      { name: 'Blender 桥接 Max', description: '带材质发送模型或场景到 Max', icon: Network },
    ],
  },
  {
    eyebrow: 'STANDALONE',
    title: '独立工具',
    description: '无需进入 DCC，安装后从桌面直接使用。',
    accent: 'cyan',
    tools: [
      { name: '贴图通道工具', description: '贴图通道混合、打包与分离', icon: Palette },
      { name: 'DCC 降版本工具', description: 'Max、Maya、Blender 文件降版本', icon: Layers3 },
    ],
  },
];

const accentStyles = {
  orange: {
    icon: 'border-orange-300/22 bg-orange-400/10 text-orange-100',
    dot: 'bg-orange-300',
  },
  violet: {
    icon: 'border-violet-300/22 bg-violet-400/10 text-violet-100',
    dot: 'bg-violet-300',
  },
  cyan: {
    icon: 'border-cyan-300/22 bg-cyan-400/10 text-cyan-100',
    dot: 'bg-cyan-300',
  },
} as const;

function CategoryCard({ category }: { category: ToolCategory }) {
  const style = accentStyles[category.accent];

  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.085] bg-[#111321]/88 shadow-[0_18px_55px_rgba(0,0,0,0.2)]">
      <div className="border-b border-white/[0.065] px-5 py-5">
        <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.18em] text-white/34">
          <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
          {category.eyebrow}
        </div>
        <h2 className="mt-3 text-xl font-semibold tracking-[-0.02em] text-white">
          {category.title}
        </h2>
        <p className="mt-2 text-xs leading-5 text-white/38">{category.description}</p>
      </div>

      <div className="divide-y divide-white/[0.055] px-3">
        {category.tools.map(({ name, description, icon: Icon }) => (
          <div
            key={name}
            className="group flex items-center gap-3 rounded-lg px-2 py-3.5 transition hover:bg-white/[0.035]"
          >
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${style.icon}`}
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-white/80 transition group-hover:text-white">
                {name}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-white/30">{description}</span>
            </span>
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300/64" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ModelingToolboxPage({
  onBack,
  onLogout,
}: {
  onBack: () => void;
  onLogout: () => void;
}) {
  const [downloadingInstaller, setDownloadingInstaller] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();

  async function downloadInstaller() {
    if (downloadingInstaller) return;
    setDownloadingInstaller(true);
    setDownloadError(undefined);
    try {
      const response = await fetch(`${toolboxRoot}modeling-toolbox-v2.0.1.exe`);
      if (!response.ok) throw new Error(`下载安装包失败（${response.status}）。`);
      downloadBlob(await response.blob(), '建模工具箱-v2.0.1.exe');
      trackModuleAction('toolbox', 'download');
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : '下载安装包失败。');
    } finally {
      setDownloadingInstaller(false);
    }
  }

  return (
    <main className="li3d-home-surface relative min-h-screen overflow-hidden text-white">
      <div className="pointer-events-none absolute right-[10%] top-8 h-96 w-96 rounded-full bg-cyan-400/[0.055] blur-[110px]" />
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

        <section className="mt-7 grid overflow-hidden rounded-2xl border border-white/[0.09] bg-[#111321]/90 shadow-[0_28px_90px_rgba(0,0,0,0.3)] lg:grid-cols-[1.45fr_0.8fr]">
          <div className="relative overflow-hidden p-7 sm:p-10">
            <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full border border-white/[0.055]" />
            <div className="pointer-events-none absolute right-8 top-8 h-36 w-36 rounded-full border border-white/[0.04]" />

            <div className="relative flex flex-col items-start gap-6 sm:flex-row sm:items-center">
              <img
                src={`${toolboxRoot}modeling-toolbox-icon.png`}
                alt="建模工具箱"
                className="h-24 w-24 shrink-0 rounded-[24px] object-cover shadow-[0_20px_45px_rgba(9,23,48,0.48)]"
              />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-cyan-300/16 bg-cyan-400/[0.075] px-3 py-1 text-[11px] font-medium text-cyan-100/72">
                    PRODUCTION TOOLBOX
                  </span>
                  <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[11px] text-white/48">
                    v2.0.1
                  </span>
                </div>
                <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
                  建模工具箱
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-white/48">
                  面向 3ds Max 与 Blender 的生产工具集合。一个安装器集中管理 9
                  项工具，并支持后续自动更新。
                </p>
              </div>
            </div>

            <div className="relative mt-8 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={downloadingInstaller}
                onClick={() => void downloadInstaller()}
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-violet-500 px-5 text-sm font-semibold text-white shadow-[0_12px_32px_rgba(72,112,220,0.28)] transition hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 disabled:cursor-wait disabled:opacity-60"
              >
                <Download className="h-4 w-4" />
                {downloadingInstaller ? '正在下载…' : '下载 Windows 安装器'}
              </button>
              <a
                href={`${toolboxRoot}manual_max.html`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-white/12 bg-white/[0.045] px-5 text-sm font-semibold text-white/72 transition hover:border-white/22 hover:bg-white/[0.085] hover:text-white"
              >
                <BookOpen className="h-4 w-4" />
                查看使用说明
                <ExternalLink className="h-3.5 w-3.5 text-white/38" />
              </a>
            </div>
            {downloadError ? (
              <p className="relative mt-3 text-xs text-rose-200/70">{downloadError}</p>
            ) : null}
          </div>

          <aside className="border-t border-white/[0.07] bg-black/18 p-7 lg:border-l lg:border-t-0 lg:p-9">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white/32">
              PACKAGE INFO
            </div>
            <div className="mt-6 space-y-4">
              {[
                ['版本', '2.0.1'],
                ['平台', 'Windows'],
                ['安装包', '11.0 MB'],
                ['包含工具', '9 项'],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between border-b border-white/[0.055] pb-3 text-sm"
                >
                  <span className="text-white/34">{label}</span>
                  <span className="font-medium text-white/72">{value}</span>
                </div>
              ))}
            </div>
            <div className="mt-6 flex items-start gap-3 rounded-xl border border-emerald-300/12 bg-emerald-400/[0.055] p-4">
              <MonitorDown className="mt-0.5 h-4 w-4 shrink-0 text-emerald-200/72" />
              <p className="text-xs leading-5 text-emerald-50/52">
                安装器与说明书已上传到 Li3D，可直接从本页获取。
              </p>
            </div>
          </aside>
        </section>

        <div className="mt-12 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white/30">
              INCLUDED TOOLS
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">工具清单</h2>
          </div>
          <span className="text-xs text-white/30">5 Max · 2 Blender · 2 独立工具</span>
        </div>

        <div className="mt-5 grid items-start gap-5 lg:grid-cols-3">
          {categories.map((category) => (
            <CategoryCard key={category.eyebrow} category={category} />
          ))}
        </div>

        <div className="mt-8 flex flex-col justify-between gap-3 border-t border-white/[0.055] pt-5 text-xs text-white/28 sm:flex-row sm:items-center">
          <span className="inline-flex items-center gap-2">
            <Wrench className="h-3.5 w-3.5" />
            建模工具箱资源已接入 Li3D
          </span>
          <a
            href="https://gitlab.lilithgame.com/rd_center/ai_art/3d-tools"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 transition hover:text-white/58"
          >
            查看 GitLab 源码 <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </section>
    </main>
  );
}
