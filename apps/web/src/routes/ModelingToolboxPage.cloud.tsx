import { ArrowLeft, Cloud } from 'lucide-react';
import { BrandMark } from '@/components/common/BrandMark';

export function ModelingToolboxPage({ onBack }: { onBack: () => void; onLogout: () => void }) {
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
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl items-center px-6 py-16">
        <div className="w-full rounded-2xl border border-violet-200/15 bg-white/[0.035] p-8 text-center">
          <Cloud className="mx-auto h-8 w-8 text-violet-200" />
          <h1 className="mt-5 text-2xl font-semibold">Cloud Build 不提供主机扩展下载</h1>
          <p className="mt-3 text-sm leading-6 text-white/48">
            莉刻核心贴图流程全部在浏览器运行；Photoshop、DCC 和独立建模工具属于可选的桌面产品线。
          </p>
        </div>
      </section>
    </main>
  );
}
