import { ShieldCheck } from 'lucide-react';
import { PerformanceRecordsDialog } from '@/features/performanceLab/PerformanceLabCloudBridge';

export function PerformanceLabAdminPage({ onBack }: { onBack: () => void }) {
  return (
    <main className="liclick-surface relative flex min-h-screen items-center justify-center overflow-hidden bg-[#070710] text-white">
      <div className="pointer-events-none absolute left-6 top-5 flex items-center gap-2 text-xs text-white/45">
        <ShieldCheck size={15} className="text-liclick-pink" />
        飞书维护人员专用 · 服务器强制鉴权
      </div>
      <PerformanceRecordsDialog adminOnly onClose={onBack} />
    </main>
  );
}
