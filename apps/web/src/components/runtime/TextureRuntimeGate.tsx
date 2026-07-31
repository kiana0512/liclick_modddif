import {
  ArrowLeft,
  Check,
  Cloud,
  Download,
  FolderOpen,
  LoaderCircle,
  MonitorCog,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/common/BrandMark';
import type { LocalTextureRuntimeState } from '@/services/localTextureRuntimeClient';
import { getLocalTextureRuntimeDownloadUrl } from '@/services/localTextureRuntimeClient';

function RuntimeStatus({
  state,
  onRetry,
}: {
  state: LocalTextureRuntimeState;
  onRetry: () => void;
}) {
  if (state.status === 'checking') {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-violet-300/15 bg-violet-400/[0.07] px-4 py-3 text-sm text-violet-100/78">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        正在检测 Li3D 本地贴图组件…
      </div>
    );
  }

  if (state.status === 'ready') {
    return (
      <div className="flex items-center justify-between gap-4 rounded-xl border border-emerald-300/18 bg-emerald-400/[0.07] px-4 py-3">
        <span className="inline-flex items-center gap-3 text-sm text-emerald-100/82">
          <Check className="h-4 w-4" />
          本地组件已就绪
        </span>
        <span className="text-xs text-white/36">v{state.health.runtimeVersion}</span>
      </div>
    );
  }

  const outdated = state.status === 'outdated';
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-300/16 bg-amber-300/[0.06] px-4 py-3">
        <div className="text-sm font-medium text-amber-100/88">
          {outdated ? '本地组件需要更新' : '尚未检测到本地贴图组件'}
        </div>
        <p className="mt-1 text-xs leading-5 text-white/42">
          {outdated
            ? `当前版本 ${state.health.runtimeVersion}，需要 ${state.requiredVersion} 或更高版本。`
            : state.reason ?? '安装后即可在当前网址中使用贴图绘制。'}
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <a
          href={getLocalTextureRuntimeDownloadUrl()}
          download="LIclick 3D Texture Local Component Setup.exe"
          className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-fuchsia-500 to-violet-500 px-5 text-sm font-semibold text-white shadow-[0_14px_36px_rgba(139,92,246,0.28)] transition hover:brightness-110"
        >
          <Download className="h-4 w-4" />
          {outdated ? '下载最新版本' : '下载本地组件'}
        </a>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/[0.045] px-5 text-sm font-medium text-white/72 transition hover:bg-white/[0.09] hover:text-white"
        >
          <RefreshCw className="h-4 w-4" />
          安装完成，重新检测
        </button>
      </div>
    </div>
  );
}

export function TextureRuntimeGate({
  state,
  onRetry,
  onBack,
  children,
}: {
  state: LocalTextureRuntimeState;
  onRetry: () => void;
  onBack: () => void;
  children: ReactNode;
}) {
  if (state.status === 'ready') return <>{children}</>;

  return (
    <main className="li3d-home-surface min-h-screen text-white">
      <header className="flex h-16 items-center justify-between border-b border-white/[0.055] px-5 sm:px-8">
        <BrandMark />
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-3 text-sm text-white/64 transition hover:bg-white/[0.08] hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          返回工作台
        </button>
      </header>

      <section className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-[1120px] items-center px-5 py-12 sm:px-8">
        <div className="grid w-full gap-8 lg:grid-cols-[1.02fr_.98fr] lg:items-center">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-fuchsia-300/15 bg-fuchsia-400/[0.07] px-3 py-1.5 text-xs font-medium text-fuchsia-100/76">
              <MonitorCog className="h-3.5 w-3.5" />
              TEXTURE PAINTING · LOCAL COMPUTE
            </div>
            <h1 className="mt-5 max-w-xl text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
              贴图绘制在你的电脑上运行
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-white/46">
              模型视口、笔刷、图层与 UV 合成使用本机 CPU/GPU；只有局部重绘等 AI 任务会连接云端计算服务。
            </p>

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {[
                { icon: MonitorCog, title: '本机交互', detail: '绘制与预览不排队' },
                { icon: Cloud, title: '云端 AI', detail: '按需提交局部重绘' },
                { icon: FolderOpen, title: '本地文件', detail: '项目和贴图留在电脑' },
              ].map(({ icon: Icon, title, detail }) => (
                <div key={title} className="rounded-xl border border-white/[0.075] bg-white/[0.025] p-4">
                  <Icon className="h-5 w-5 text-violet-200/76" />
                  <div className="mt-3 text-sm font-medium text-white/84">{title}</div>
                  <div className="mt-1 text-xs text-white/36">{detail}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#111321]/92 p-6 shadow-[0_28px_90px_rgba(0,0,0,0.34)] sm:p-8">
            <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-violet-500/15 blur-[80px]" />
            <div className="relative">
              <div className="flex items-start justify-between gap-6">
                <div>
                  <div className="text-xs font-semibold tracking-[0.18em] text-white/34">LI3D LOCAL COMPONENT</div>
                  <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">启用贴图绘制</h2>
                </div>
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-violet-200/15 bg-violet-300/[0.08] text-violet-100">
                  <ShieldCheck className="h-5 w-5" />
                </span>
              </div>
              <p className="mt-3 text-sm leading-6 text-white/43">
                本地组件只提供文件访问、贴图运行能力和 DCC 连接，不包含 ComfyUI 或 AI 模型。
              </p>
              <div className="my-6 h-px bg-white/[0.07]" />
              <RuntimeStatus state={state} onRetry={onRetry} />
              <p className="mt-5 text-xs leading-5 text-white/28">
                安装程序仅需运行一次。安装完成后保持当前页面，点击“重新检测”即可进入。
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
