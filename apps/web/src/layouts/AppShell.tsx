import type { ReactNode } from 'react';
import { FolderOpen, Grid2X2, Images, Settings } from 'lucide-react';
import { BrandMark } from '@/components/common/BrandMark';
import { cn } from '@/components/common/cn';
import { useT, type TranslationKey } from '@/stores/i18nStore';

export type AppSection = 'projects' | 'folders' | 'assets' | 'settings';

const sidebarItems: Array<{ icon: typeof Grid2X2; labelKey: TranslationKey; section: AppSection }> = [
  { icon: Grid2X2, labelKey: 'projects', section: 'projects' },
  { icon: FolderOpen, labelKey: 'folders', section: 'folders' },
  { icon: Images, labelKey: 'assets', section: 'assets' },
  { icon: Settings, labelKey: 'settings', section: 'settings' },
];

export function AppShell({
  children,
  activeSection = 'projects',
  onNavigate,
}: {
  children: ReactNode;
  activeSection?: AppSection;
  onNavigate?: (section: AppSection) => void;
}) {
  const t = useT();

  return (
    <main className="liclick-surface min-h-screen text-white">
      <aside className="fixed inset-y-0 left-0 z-10 flex w-16 flex-col items-center gap-3 border-r border-white/10 bg-ink/86 py-4 backdrop-blur">
        {sidebarItems.map(({ icon: Icon, labelKey, section }) => (
          <button
            key={section}
            type="button"
            onClick={() => onNavigate?.(section)}
            className={cn(
              'grid h-10 w-10 place-items-center rounded-md text-white/58 transition hover:bg-white/10 hover:text-white',
              activeSection === section && 'bg-white/12 text-white shadow-glow',
            )}
            title={t(labelKey)}
          >
            <Icon className="h-5 w-5" />
          </button>
        ))}
      </aside>
      <div className="pl-16">
        <header className="flex h-16 items-center justify-between border-b border-white/10 px-6">
          <BrandMark />
          <div className="text-xs text-white/45">{t('appTagline')}</div>
        </header>
        {children}
      </div>
    </main>
  );
}
