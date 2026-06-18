import type { ReactNode } from 'react';
import { FolderOpen, Grid2X2, Images, Settings } from 'lucide-react';
import { BrandMark } from '@/components/common/BrandMark';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <main className="liclick-surface min-h-screen text-white">
      <aside className="fixed inset-y-0 left-0 z-10 flex w-16 flex-col items-center gap-3 border-r border-white/10 bg-ink/86 py-4 backdrop-blur">
        {[Grid2X2, FolderOpen, Images, Settings].map((Icon, index) => (
          <button
            key={index}
            type="button"
            className="grid h-10 w-10 place-items-center rounded-md text-white/58 transition hover:bg-white/10 hover:text-white"
            title={Icon.name}
          >
            <Icon className="h-5 w-5" />
          </button>
        ))}
      </aside>
      <div className="pl-16">
        <header className="flex h-16 items-center justify-between border-b border-white/10 px-6">
          <BrandMark />
          <div className="text-xs text-white/45">Web AI 3D Texture Studio</div>
        </header>
        {children}
      </div>
    </main>
  );
}
