import {
  ArrowRight,
  Box,
  Boxes,
  Clock3,
  Download,
  Flame,
  Map as MapIcon,
  Network,
  Palette,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { UserMenu } from '@/components/auth/UserMenu';
import { BrandMark } from '@/components/common/BrandMark';
import { downloadLocalTextureRuntimeInstaller } from '@/services/localTextureRuntimeClient';
import {
  trackHomeModuleEntry,
  trackModuleAction,
  type HomeTelemetryModule,
} from '@/services/telemetryClient';

type ModuleCardProps = {
  eyebrow: string;
  title: string;
  description: string;
  detail: string;
  icon: LucideIcon;
  accent: 'violet' | 'orange' | 'cyan' | 'blue' | 'emerald';
  visual: 'paint' | 'bake' | 'tools' | 'retopo' | 'uv';
  badge: string;
  hoverAction?: string;
  telemetryModule: HomeTelemetryModule;
  onClick?: () => void;
  disabled?: boolean;
  layout?: 'standard' | 'featured' | 'compact';
  className?: string;
};

const accents = {
  violet: {
    border: 'hover:border-fuchsia-300/45',
    glow: 'from-fuchsia-500/18 via-violet-500/6 to-transparent',
    line: 'from-fuchsia-400 to-violet-500',
    action: 'text-fuchsia-100',
    shadow: 'hover:shadow-[0_28px_90px_rgba(197,70,213,0.22)]',
  },
  orange: {
    border: 'hover:border-orange-300/45',
    glow: 'from-orange-400/16 via-amber-500/5 to-transparent',
    line: 'from-orange-300 to-rose-500',
    action: 'text-orange-100',
    shadow: 'hover:shadow-[0_28px_90px_rgba(251,146,60,0.18)]',
  },
  cyan: {
    border: 'hover:border-cyan-300/40',
    glow: 'from-cyan-400/14 via-blue-500/5 to-transparent',
    line: 'from-cyan-300 to-blue-500',
    action: 'text-cyan-100',
    shadow: 'hover:shadow-[0_28px_90px_rgba(34,211,238,0.15)]',
  },
  blue: {
    border: 'hover:border-blue-300/40',
    glow: 'from-blue-400/14 via-indigo-500/5 to-transparent',
    line: 'from-blue-300 to-indigo-500',
    action: 'text-blue-100',
    shadow: 'hover:shadow-[0_28px_90px_rgba(59,130,246,0.16)]',
  },
  emerald: {
    border: 'hover:border-emerald-300/40',
    glow: 'from-emerald-400/14 via-teal-500/5 to-transparent',
    line: 'from-emerald-300 to-teal-500',
    action: 'text-emerald-100',
    shadow: 'hover:shadow-[0_28px_90px_rgba(16,185,129,0.15)]',
  },
} as const;

function PaintVisual({ icon: Icon, heightClass, featured }: { icon: LucideIcon; heightClass: string; featured: boolean }) {
  return (
    <div className={`relative ${heightClass} shrink-0 overflow-hidden border-b border-white/[0.065] bg-[radial-gradient(circle_at_42%_38%,rgba(192,92,255,0.18),transparent_38%),linear-gradient(135deg,rgba(35,20,60,0.9),rgba(10,12,25,0.75))]`}>
      <div className="absolute inset-0 opacity-[0.13] [background-image:linear-gradient(rgba(255,255,255,.12)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.12)_1px,transparent_1px)] [background-size:28px_28px]" />
      <div className={`absolute left-[27%] top-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_34%_28%,#f8d9ff_0%,#b665e8_28%,#5940bc_62%,#18152f_100%)] shadow-[0_28px_65px_rgba(176,85,235,0.34)] transition duration-500 group-hover:scale-105 group-hover:rotate-3 ${featured ? 'h-28 w-28 xl:h-40 xl:w-40' : 'h-28 w-28'}`} />
      <div className={`absolute left-[21%] top-1/2 -translate-y-1/2 -rotate-12 rounded-[50%] border border-fuchsia-100/28 transition duration-500 group-hover:-rotate-6 ${featured ? 'h-16 w-40 xl:h-24 xl:w-60' : 'h-16 w-40'}`} />
      <div className={`absolute left-[23%] top-[22%] rotate-[18deg] rounded-[50%] border border-violet-200/14 ${featured ? 'h-24 w-36 xl:h-36 xl:w-52' : 'h-24 w-36'}`} />
      <div className="absolute right-6 top-7 flex flex-col gap-2">
        {['bg-fuchsia-300', 'bg-violet-400', 'bg-cyan-300', 'bg-orange-200'].map((color, index) => (
          <span
            key={color}
            className={`h-3 w-3 rounded-full ${color} ${index === 0 ? 'shadow-[0_0_18px_rgba(240,171,252,0.7)]' : 'opacity-60'}`}
          />
        ))}
      </div>
      <span className="absolute bottom-5 right-6 grid h-10 w-10 place-items-center rounded-xl border border-fuchsia-200/18 bg-fuchsia-300/[0.09] text-fuchsia-100/76 backdrop-blur-sm transition duration-300 group-hover:-translate-y-1 group-hover:rotate-6">
        <Icon className="h-5 w-5" />
      </span>
    </div>
  );
}

function BakeVisual({ icon: Icon, heightClass }: { icon: LucideIcon; heightClass: string }) {
  return (
    <div className={`relative ${heightClass} shrink-0 overflow-hidden border-b border-white/[0.065] bg-[radial-gradient(circle_at_60%_42%,rgba(251,146,60,0.16),transparent_38%),linear-gradient(135deg,rgba(43,24,20,0.9),rgba(10,12,25,0.78))]`}>
      <div className="absolute inset-0 opacity-[0.11] [background-image:linear-gradient(30deg,rgba(255,255,255,.12)_1px,transparent_1px),linear-gradient(150deg,rgba(255,255,255,.1)_1px,transparent_1px)] [background-size:34px_58px]" />
      <div className="absolute left-[16%] top-1/2 -translate-y-1/2 text-orange-100/46 transition duration-500 group-hover:-translate-x-1 group-hover:-translate-y-1/2">
        <Boxes className="h-20 w-20 stroke-[0.9]" />
      </div>
      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 text-orange-200/44">
        <span className="h-px w-5 bg-gradient-to-r from-transparent to-orange-200/55" />
        <ArrowRight className="h-4 w-4" />
      </div>
      <div className="absolute right-[17%] top-1/2 grid h-[74px] w-[74px] -translate-y-1/2 place-items-center rounded-2xl border border-orange-200/22 bg-orange-300/[0.08] text-orange-100/78 shadow-[0_22px_55px_rgba(251,146,60,0.18)] transition duration-500 group-hover:translate-x-1 group-hover:-translate-y-1/2 group-hover:scale-105">
        <Box className="h-10 w-10 stroke-[1.1]" />
      </div>
      <div className="absolute bottom-4 right-5 flex gap-1.5">
        {['BC', 'N', 'AO'].map((map) => (
          <span
            key={map}
            className="grid h-7 min-w-7 place-items-center rounded-md border border-white/[0.09] bg-black/24 px-1.5 text-[8px] font-medium text-white/38 backdrop-blur-sm"
          >
            {map}
          </span>
        ))}
      </div>
      <span className="absolute left-5 top-5 grid h-9 w-9 place-items-center rounded-xl border border-orange-200/16 bg-orange-300/[0.08] text-orange-100/72 backdrop-blur-sm">
        <Icon className="h-[18px] w-[18px]" />
      </span>
    </div>
  );
}

function ToolsVisual({ icon: Icon, heightClass }: { icon: LucideIcon; heightClass: string }) {
  return (
    <div className={`relative ${heightClass} shrink-0 overflow-hidden border-b border-white/[0.065] bg-[radial-gradient(circle_at_50%_48%,rgba(34,211,238,0.14),transparent_36%),linear-gradient(135deg,rgba(13,37,48,0.9),rgba(10,12,25,0.78))]`}>
      <div className="absolute inset-0 opacity-[0.12] [background-image:linear-gradient(rgba(255,255,255,.11)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.11)_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className="absolute left-1/2 top-1/2 grid h-[72px] w-[72px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[22px] border border-cyan-200/24 bg-cyan-300/[0.1] text-cyan-100 shadow-[0_20px_55px_rgba(34,211,238,0.16)] transition duration-500 group-hover:scale-110 group-hover:-rotate-3">
        <Icon className="h-7 w-7" />
      </div>
      <span className="absolute left-[15%] top-[21%] rounded-lg border border-white/[0.1] bg-black/24 px-3 py-2 text-[10px] font-semibold tracking-wider text-cyan-50/56 backdrop-blur-sm transition duration-500 group-hover:-translate-x-1 group-hover:-translate-y-1">
        MAX
      </span>
      <span className="absolute right-[15%] top-[21%] rounded-lg border border-white/[0.1] bg-black/24 px-3 py-2 text-[10px] font-semibold tracking-wider text-violet-50/56 backdrop-blur-sm transition duration-500 group-hover:translate-x-1 group-hover:-translate-y-1">
        BL
      </span>
      <span className="absolute bottom-[15%] left-1/2 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-xl border border-white/[0.09] bg-black/22 text-white/42 backdrop-blur-sm transition duration-500 group-hover:translate-y-1">
        <Box className="h-4 w-4" />
      </span>
      <span className="absolute left-[26%] top-[39%] h-px w-[17%] rotate-[18deg] bg-gradient-to-r from-cyan-200/20 to-cyan-200/45" />
      <span className="absolute right-[26%] top-[39%] h-px w-[17%] -rotate-[18deg] bg-gradient-to-l from-violet-200/20 to-cyan-200/45" />
    </div>
  );
}

function RetopoVisual({ heightClass }: { heightClass: string }) {
  return (
    <div className={`relative ${heightClass} shrink-0 overflow-hidden border-b border-white/[0.065] bg-[radial-gradient(circle_at_50%_48%,rgba(59,130,246,.2),transparent_42%),linear-gradient(135deg,#101d37,#0b0d19)]`}>
      <div className="absolute inset-0 opacity-[0.11] [background-image:radial-gradient(circle,rgba(147,197,253,.72)_1px,transparent_1px)] [background-size:26px_26px]" />
      <div className="absolute left-1/2 top-1/2 h-28 w-36 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-400/[0.07] blur-2xl" />
      <svg
        viewBox="0 0 160 120"
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 h-[118px] w-[156px] -translate-x-1/2 -translate-y-1/2 overflow-visible text-blue-100/72 drop-shadow-[0_16px_34px_rgba(37,99,235,.25)] transition duration-500 group-hover:scale-105"
      >
        <g fill="rgba(59,130,246,0.055)" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <path d="M80 9 126 32 137 76 105 108 56 111 22 79 31 34Z" strokeWidth="1.5" />
          <path d="m80 9-9 34 9 28 25 37M31 34l40 9 34-10 32 43M22 79l58-8 57 5M56 111l24-40 46-39M31 34l49 37 57 5M22 79l49-36 55-11M56 111l-34-32M105 108l32-32" strokeWidth="1.05" opacity=".78" />
          <path d="m71 43 34-10-25 38Z" fill="rgba(96,165,250,0.12)" strokeWidth="1.2" />
        </g>
        {[[80, 9], [126, 32], [137, 76], [105, 108], [56, 111], [22, 79], [31, 34], [71, 43], [80, 71]].map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.7" fill="#bfdbfe" opacity=".82" />
        ))}
      </svg>
      <span className="absolute bottom-4 right-5 text-[8px] font-semibold tracking-[0.18em] text-blue-100/30">MESH FLOW</span>
    </div>
  );
}

function UvVisual({ heightClass }: { heightClass: string }) {
  return (
    <div className={`relative ${heightClass} shrink-0 overflow-hidden border-b border-white/[0.065] bg-[radial-gradient(circle_at_50%_48%,rgba(16,185,129,.18),transparent_42%),linear-gradient(135deg,#0c2924,#0b0d19)]`}>
      <div className="absolute inset-0 opacity-[0.11] [background-image:linear-gradient(rgba(167,243,208,.24)_1px,transparent_1px),linear-gradient(90deg,rgba(167,243,208,.24)_1px,transparent_1px)] [background-size:28px_28px]" />
      <div className="absolute left-1/2 top-1/2 h-28 w-36 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400/[0.06] blur-2xl" />
      <svg
        viewBox="0 0 160 120"
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 h-[118px] w-[156px] -translate-x-1/2 -translate-y-1/2 overflow-visible text-emerald-100/72 drop-shadow-[0_16px_34px_rgba(5,150,105,.24)] transition duration-500 group-hover:scale-105"
      >
        <rect x="17" y="10" width="126" height="100" rx="7" fill="rgba(16,185,129,0.025)" stroke="currentColor" strokeWidth="1.15" opacity=".5" />
        <path d="M31 25h98M31 95h98M42 18v84M118 18v84" fill="none" stroke="currentColor" strokeWidth=".7" opacity=".18" />
        <path d="M38 34c13-12 31-9 35 2 4 10-5 15-3 25 2 9 13 15 4 25-10 10-31 7-39-5-7-11 1-19-1-28-1-7-3-12 4-19Z" fill="rgba(16,185,129,0.09)" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M94 29c13-7 30-3 33 8 2 8-7 13-5 22 2 8 12 13 7 22-6 10-24 14-33 7-8-7-1-18-5-25-4-8-10-8-8-18 1-7 5-13 11-16Z" fill="rgba(110,231,183,0.075)" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M48 43c7 6 13 14 15 25M101 40c9 9 14 21 15 34" fill="none" stroke="currentColor" strokeDasharray="3 4" strokeWidth=".9" opacity=".55" />
      </svg>
      <span className="absolute bottom-4 right-5 text-[8px] font-semibold tracking-[0.18em] text-emerald-100/30">UV ISLANDS</span>
    </div>
  );
}

function ModuleVisual({ visual, icon, layout }: Pick<ModuleCardProps, 'visual' | 'icon' | 'layout'>) {
  const heightClass = layout === 'featured' ? 'h-[172px] xl:h-[310px]' : layout === 'compact' ? 'h-[172px] xl:h-[132px]' : 'h-[172px]';
  if (visual === 'paint') return <PaintVisual icon={icon} heightClass={heightClass} featured={layout === 'featured'} />;
  if (visual === 'bake') return <BakeVisual icon={icon} heightClass={heightClass} />;
  if (visual === 'tools') return <ToolsVisual icon={icon} heightClass={heightClass} />;
  if (visual === 'retopo') return <RetopoVisual heightClass={heightClass} />;
  return <UvVisual heightClass={heightClass} />;
}

function ModuleCard({
  eyebrow,
  title,
  description,
  detail,
  icon,
  accent,
  visual,
  badge,
  hoverAction,
  telemetryModule,
  onClick,
  disabled = false,
  layout = 'standard',
  className = '',
}: ModuleCardProps) {
  const style = accents[accent];
  const cardSize = layout === 'featured' ? 'min-h-[360px] xl:h-[620px]' : layout === 'compact' ? 'min-h-[360px] xl:h-[300px] xl:min-h-[300px]' : 'min-h-[360px]';
  const bodySize = layout === 'featured' ? 'min-h-[188px] xl:min-h-0 xl:flex-1 xl:p-7' : layout === 'compact' ? 'min-h-[188px] xl:min-h-0 xl:flex-1 xl:p-5' : 'min-h-[188px]';

  return (
    <button
      type="button"
      onClick={() => {
        trackHomeModuleEntry(telemetryModule);
        onClick?.();
      }}
      disabled={disabled}
      className={`group relative overflow-hidden rounded-2xl border border-white/10 bg-[#111321]/92 text-left shadow-[0_24px_70px_rgba(0,0,0,0.28)] outline-none transition duration-300 focus-visible:ring-2 focus-visible:ring-white/55 ${cardSize} ${disabled ? 'cursor-default' : `hover:-translate-y-1.5 hover:bg-[#17192b] active:translate-y-0 active:scale-[0.995] ${style.border} ${style.shadow}`} ${className}`}
    >
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${style.glow} opacity-75 transition duration-300 group-hover:opacity-100`} />
      <div className="relative flex h-full flex-col">
        <ModuleVisual visual={visual} icon={icon} layout={layout} />
        <span className="absolute right-4 top-4 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-[10px] font-medium tracking-wide text-white/58 backdrop-blur-md">
          {badge}
        </span>

        <div className={`flex flex-col p-6 ${bodySize}`}>
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/34">{eyebrow}</div>
          <div className="mt-2 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[27px] font-semibold tracking-[-0.03em] text-white transition-transform duration-300 group-hover:translate-x-1">
                {title}
              </h2>
              <p className="mt-2 max-w-xs text-sm leading-6 text-white/46">{description}</p>
            </div>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/12 bg-white/[0.055] text-white/68 transition duration-300 group-hover:scale-110 group-hover:border-white/30 group-hover:bg-white/14 group-hover:text-white">
              {disabled ? <Clock3 className="h-4 w-4 text-white/38" /> : <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
            </span>
          </div>

          <div className="mt-auto pt-4 text-[11px]">
            <span className={`text-white/27 transition duration-300 ${disabled ? '' : 'group-hover:opacity-0'}`}>{detail}</span>
            {!disabled && hoverAction && (
              <span
                className={`absolute bottom-6 left-6 translate-y-2 font-semibold opacity-0 transition duration-300 group-hover:translate-y-0 group-hover:opacity-100 ${style.action}`}
              >
                {hoverAction}
              </span>
            )}
          </div>
        </div>
      </div>

      {!disabled && <div className={`absolute inset-x-0 bottom-0 h-[2px] origin-left scale-x-0 bg-gradient-to-r ${style.line} transition-transform duration-300 group-hover:scale-x-100`} />}
    </button>
  );
}

export function HomePage({
  onOpenTexture,
  onOpenBake,
  onOpenToolbox,
  onOpenRetopology,
  onOpenUv,
  onLogout,
}: {
  onOpenTexture: () => void;
  onOpenBake: () => void;
  onOpenToolbox: () => void;
  onOpenRetopology: () => void;
  onOpenUv: () => void;
  onLogout: () => void;
}) {
  const [downloadingLocalComponent, setDownloadingLocalComponent] = useState(false);

  async function downloadLocalComponent() {
    if (downloadingLocalComponent) return;
    setDownloadingLocalComponent(true);
    try {
      await downloadLocalTextureRuntimeInstaller();
      trackModuleAction('local_component', 'download');
    } catch (error) {
      console.warn('[Li3D] Local component download failed.', error);
    } finally {
      setDownloadingLocalComponent(false);
    }
  }

  return (
    <main className="li3d-home-surface relative min-h-screen overflow-hidden text-white">
      <div className="pointer-events-none absolute left-[8%] top-36 h-72 w-72 rounded-full bg-fuchsia-500/[0.075] blur-[90px]" />
      <div className="pointer-events-none absolute right-[7%] top-12 h-96 w-96 rounded-full bg-violet-500/[0.08] blur-[110px]" />

      <header className="relative z-10 flex h-16 items-center justify-between border-b border-white/[0.055] px-5 sm:px-8">
        <BrandMark />
        <UserMenu onLogout={onLogout} />
      </header>

      <section className="relative z-[1] mx-auto w-full max-w-[1320px] px-5 pb-16 pt-14 sm:px-8 lg:pt-16">
        <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-violet-300/14 bg-violet-400/[0.075] px-3 py-1.5 text-xs font-medium text-violet-100/72">
              <Sparkles className="h-3.5 w-3.5" />
              LI3D CREATION SUITE
            </div>
            <h1 className="mt-5 text-4xl font-semibold tracking-[-0.045em] text-white sm:text-5xl">选择工作模块</h1>
            <p className="mt-3 text-base text-white/44">一个入口，连接云端生产服务与本地贴图能力。</p>
          </div>

          <div className="flex items-center gap-5 text-xs text-white/36">
            <span className="inline-flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />云端服务在线
            </span>
            <span className="hidden h-3 w-px bg-white/12 sm:block" />
            <span className="hidden items-center gap-2 sm:inline-flex">
              <Boxes className="h-3.5 w-3.5" />5 个工作模块
            </span>
          </div>
        </div>

        <div className="mt-9 grid gap-5 md:grid-cols-2 xl:grid-cols-3 xl:grid-rows-[300px_300px]">
          <div className="relative xl:row-span-2">
            <ModuleCard
              eyebrow="TEXTURE PAINTING"
              title="贴图绘制"
              description="浏览器本机运行绘制，局部重绘连接云端 ComfyUI。"
              detail="本机绘制 · 云端 AI · 本地保存"
              icon={Palette}
              accent="violet"
              visual="paint"
              badge="本机运行"
              hoverAction="进入贴图工作台"
              telemetryModule="texture_painting"
              onClick={onOpenTexture}
              layout="featured"
              className="h-full w-full"
            />
            <button
              type="button"
              disabled={downloadingLocalComponent}
              onClick={() => void downloadLocalComponent()}
              className="absolute bottom-5 right-5 z-20 inline-flex h-9 items-center gap-2 rounded-xl border border-fuchsia-200/20 bg-fuchsia-300/[0.09] px-3 text-[11px] font-semibold text-fuchsia-50/78 shadow-[0_10px_28px_rgba(168,85,247,0.12)] backdrop-blur-md transition hover:border-fuchsia-200/40 hover:bg-fuchsia-300/16 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-200/60"
              aria-label="下载最新的贴图绘制本地组件安装包"
            >
              <Download className="h-3.5 w-3.5" />
              {downloadingLocalComponent ? '正在下载…' : '下载最新安装包'}
            </button>
          </div>
          <ModuleCard
            eyebrow="AUTO RETOPOLOGY"
            title="自动拓扑"
            description="高模转生产级低模，优化结构与边流。"
            detail="低模生成 · 边流优化"
            icon={Network}
            accent="blue"
            visual="retopo"
            badge="云端测试"
            hoverAction="进入自动拓扑"
            telemetryModule="auto_retopology"
            onClick={onOpenRetopology}
            layout="compact"
          />
          <ModuleCard
            eyebrow="AUTO UV"
            title="自动展 UV"
            description="自动切缝、展开并完成 UV 排布。"
            detail="自动切缝 · UV Pack"
            icon={MapIcon}
            accent="emerald"
            visual="uv"
            badge="云端服务"
            hoverAction="进入自动展 UV"
            telemetryModule="auto_uv"
            onClick={onOpenUv}
            layout="compact"
          />
          <ModuleCard
            eyebrow="MODEL BAKING"
            title="模型烘焙"
            description="完成高低模烘焙与 PBR 贴图输出。"
            detail="高低模 · PBR · 检查"
            icon={Flame}
            accent="orange"
            visual="bake"
            badge="云端服务"
            hoverAction="进入烘焙工作台"
            telemetryModule="model_baking"
            onClick={onOpenBake}
            layout="compact"
          />
          <ModuleCard
            eyebrow="PRODUCTION TOOLS"
            title="工具箱"
            description="使用建模与生产辅助工具。"
            detail="3ds Max · Blender · 独立工具"
            icon={Wrench}
            accent="cyan"
            visual="tools"
            badge="云端服务"
            hoverAction="打开工具箱"
            telemetryModule="toolbox"
            onClick={onOpenToolbox}
            layout="compact"
          />
        </div>
        <p className="mt-4 text-center text-[11px] leading-5 text-white/28">
          使用统计仅记录模块入口和次数，不上传作品、提示词或文件路径。
        </p>
      </section>
    </main>
  );
}
