import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Copy,
  Cuboid,
  FileImage,
  History,
  PackageCheck,
  PlugZap,
  RefreshCw,
  Send,
  Settings2,
} from 'lucide-react';
import { cn } from '@/components/common/cn';
import { Button } from '@/components/ui/Button';
import { WorkflowPanel } from '@/features/workflow/WorkflowPanel';
import { WorkflowProjectPreview } from '@/features/workflow/WorkflowProjectPreview';
import { WorkflowShell } from '@/features/workflow/WorkflowShell';
import { useWorkflowProject } from '@/features/workflow/useWorkflowProject';

type DccTarget = 'blender' | '3dsmax' | 'maya';

const targets: Array<{
  id: DccTarget;
  name: string;
  subtitle: string;
  initials: string;
}> = [
  { id: 'blender', name: 'Blender', subtitle: '首批闭环目标', initials: 'Bl' },
  { id: '3dsmax', name: '3ds Max', subtitle: '连接器待接入', initials: 'Mx' },
  { id: 'maya', name: 'Maya', subtitle: '规划目标', initials: 'My' },
];

const targetProfiles: Record<
  DccTarget,
  { normal: 'OpenGL' | 'DirectX'; unit: string; material: string }
> = {
  blender: { normal: 'OpenGL', unit: '米', material: 'Principled BSDF' },
  '3dsmax': { normal: 'DirectX', unit: '厘米', material: 'Physical Material' },
  maya: { normal: 'OpenGL', unit: '厘米', material: 'Standard Surface' },
};

export function DeliveryWorkspacePage({
  projectId,
  onBack,
  onOpenTexture,
  onOpenBake,
}: {
  projectId: string;
  onBack: () => void;
  onOpenTexture: () => void;
  onOpenBake: () => void;
}) {
  const { project, isLoading, error, retry } = useWorkflowProject(projectId);
  const [target, setTarget] = useState<DccTarget>('blender');
  const [replaceExisting, setReplaceExisting] = useState(true);
  const [openAfterImport, setOpenAfterImport] = useState(true);
  const [packTextures, setPackTextures] = useState(false);
  const [copied, setCopied] = useState(false);
  const profile = targetProfiles[target];

  const availableMaps = useMemo(() => {
    const maps = project?.bakedTextures ?? [];
    return maps.map((map, index) => ({
      id: map.id,
      name: `Base Color ${index + 1} · ${map.width}×${map.height}`,
    }));
  }, [project]);
  const hasReleaseCandidate = Boolean(project && project.objects.length > 0 && availableMaps.length > 0);

  function copyProfile() {
    const text = `${targets.find((item) => item.id === target)?.name}: ${profile.normal}, ${profile.unit}, ${profile.material}`;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  }

  return (
    <WorkflowShell
      projectName={project?.name ?? (isLoading ? '正在载入项目…' : '未找到项目')}
      eyebrow="MODULE 3 · DCC DELIVERY"
      onBack={onBack}
      connected={!error}
      navigation={{
        activeModule: 'delivery',
        onOpenTexture,
        onOpenBake,
        onOpenDelivery: () => undefined,
      }}
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 xl:grid-cols-[300px_minmax(560px,1fr)_350px] 2xl:grid-cols-[320px_minmax(680px,1fr)_380px] xl:overflow-hidden">
        <aside className="workflow-scrollbar space-y-3 overflow-y-auto pr-0.5">
          <WorkflowPanel title="目标软件" description="选择后自动应用对应转换配置">
            <div className="p-2">
              {targets.map((item) => {
                const selected = target === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-3.5 py-3.5 text-left transition-colors',
                      selected ? 'bg-white/10' : 'hover:bg-white/5',
                    )}
                    onClick={() => setTarget(item.id)}
                  >
                    <span
                      className={cn(
                        'grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-black/24 text-sm font-bold text-white/54',
                        selected && 'border-liclick-purple/50 bg-liclick-purple/16 text-white',
                      )}
                    >
                      {item.initials}
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block text-sm text-white/86">{item.name}</strong>
                      <small className="mt-1 block text-xs text-white/40">{item.subtitle}</small>
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 text-white/28" />
                  </button>
                );
              })}
            </div>
          </WorkflowPanel>

          <WorkflowPanel title="交付记录" description="发送任务与 DCC 回执将在这里保留">
            <div className="grid min-h-40 place-items-center px-6 py-8 text-center">
              <div>
                <History className="mx-auto h-7 w-7 text-white/24" />
                <p className="mt-3 text-sm font-semibold text-white/58">暂无交付记录</p>
                <p className="mt-1 text-xs leading-5 text-white/36">首个真实连接器完成后启用任务追踪。</p>
              </div>
            </div>
          </WorkflowPanel>

          {error ? (
            <div className="rounded-xl border border-amber-300/18 bg-amber-300/8 p-4 text-sm text-amber-100/82">
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4" />项目服务未连接
              </div>
              <p className="mt-1.5 leading-5 text-amber-100/58">{error}</p>
              <Button className="mt-3 w-full" onClick={() => void retry()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
                重新连接
              </Button>
            </div>
          ) : null}
        </aside>

        <section className="workflow-scrollbar flex min-h-[620px] min-w-0 flex-col gap-3 overflow-y-auto xl:min-h-0">
          <WorkflowPanel
            title="交付版本"
            description="只发送已发布结果；草稿和失败任务不会进入 DCC"
            action={
              <span
                className={cn(
                  'rounded-md border px-2.5 py-1.5 text-xs font-semibold',
                  hasReleaseCandidate
                    ? 'border-emerald-300/20 bg-emerald-300/8 text-emerald-200'
                    : 'border-amber-300/18 bg-amber-300/8 text-amber-200',
                )}
              >
                {hasReleaseCandidate ? '候选资产已就绪' : '等待模块 2 发布'}
              </span>
            }
          >
            <div className="grid gap-3 p-3 md:grid-cols-[minmax(260px,0.9fr)_1.1fr]">
              <div className="min-h-64">
                <WorkflowProjectPreview project={project} caption="交付资产预览" />
              </div>
              <div className="space-y-3 rounded-xl border border-white/8 bg-black/18 p-4">
                <SummaryRow label="项目" value={project?.name ?? '—'} />
                <SummaryRow label="模型" value={project?.objects[0]?.name ?? '未找到模型'} />
                <SummaryRow label="贴图" value={availableMaps.length ? `${availableMaps.length} 张已烘焙贴图` : '尚未发布 PBR 贴图'} />
                <SummaryRow label="目标" value={targets.find((item) => item.id === target)?.name ?? target} />
                <div className="border-t border-white/8 pt-3">
                  <div className="flex items-start gap-2 rounded-lg bg-black/22 px-3 py-2.5">
                    <PackageCheck className="mt-0.5 h-4 w-4 text-liclick-orange" />
                    <p className="text-xs leading-5 text-white/48">
                      Release Manifest 将锁定模型、贴图、法线方向、单位和来源 Job ID，保证重复发送可追踪。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </WorkflowPanel>

          <div className="grid gap-3 md:grid-cols-2">
            <WorkflowPanel title="目标转换" description="按 DCC 配置自动转换，不覆盖源 Release">
              <div className="space-y-3 p-4">
                <SummaryRow label="Normal" value={profile.normal} accent />
                <SummaryRow label="场景单位" value={profile.unit} />
                <SummaryRow label="材质模板" value={profile.material} />
                <SummaryRow label="模型格式" value="FBX + GLB fallback" />
                <Button className="mt-1 w-full" onClick={copyProfile} icon={<Copy className="h-3.5 w-3.5" />}>
                  {copied ? '配置已复制' : '复制转换摘要'}
                </Button>
              </div>
            </WorkflowPanel>

            <WorkflowPanel title="导入策略" description="重复发送采用确定性的对象命名">
              <div className="divide-y divide-white/8 p-2">
                <ToggleRow label="更新同名对象" checked={replaceExisting} onChange={setReplaceExisting} />
                <ToggleRow label="导入后定位对象" checked={openAfterImport} onChange={setOpenAfterImport} />
                <ToggleRow label="打包贴图到工程" checked={packTextures} onChange={setPackTextures} />
              </div>
            </WorkflowPanel>
          </div>

          <WorkflowPanel title="贴图清单" description="来自当前项目已保存的烘焙结果">
            {availableMaps.length ? (
              <div className="grid gap-2 p-3 sm:grid-cols-2">
                {availableMaps.map((map) => (
                  <div key={map.id} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2.5">
                    <FileImage className="h-4 w-4 text-white/34" />
                    <span className="min-w-0 flex-1 truncate text-sm text-white/68">{map.name}</span>
                    <Check className="h-3.5 w-3.5 text-emerald-300" />
                  </div>
                ))}
              </div>
            ) : (
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-5 text-left hover:bg-white/4"
                onClick={onOpenBake}
              >
                <FlamePlaceholder />
                <span className="flex-1">
                  <strong className="block text-sm text-white/70">尚无可交付贴图</strong>
                  <small className="mt-1 block text-xs text-white/40">返回模块 2 完成烘焙、检查和发布。</small>
                </span>
                <ChevronRight className="h-4 w-4 text-white/30" />
              </button>
            )}
          </WorkflowPanel>
        </section>

        <aside className="workflow-scrollbar space-y-3 overflow-y-auto pr-0.5">
          <WorkflowPanel title={`${targets.find((item) => item.id === target)?.name} 连接器`} description="运行状态由桌面启动器统一管理">
            <div className="p-4">
              <div className="flex items-start gap-3 rounded-xl border border-white/8 bg-black/22 p-3">
                <div className="grid h-10 w-10 place-items-center rounded-lg bg-liclick-purple/16 text-liclick-purple">
                  <PlugZap className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <strong className="text-sm text-white/82">尚未检测</strong>
                    <Circle className="h-2.5 w-2.5 fill-amber-300 text-amber-300" />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-white/42">连接器状态 API 将在启动器升级阶段接入。</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button icon={<RefreshCw className="h-3.5 w-3.5" />}>重新检测</Button>
                <Button icon={<Settings2 className="h-3.5 w-3.5" />}>连接设置</Button>
              </div>
            </div>
          </WorkflowPanel>

          <WorkflowPanel title="发送确认" description="发送前再次锁定 Release 与目标配置">
            <div className="space-y-3 p-4">
              <div className="space-y-2.5 rounded-lg border border-white/8 bg-black/18 p-3 text-sm">
                <ConfirmRow label="Release" ready={hasReleaseCandidate} />
                <ConfirmRow label="连接器在线" ready={false} />
                <ConfirmRow label="目标配置完整" ready />
              </div>
              <Button
                variant="primary"
                className="h-11 w-full"
                disabled
                icon={<Send className="h-4 w-4" />}
                title="等待首个真实 DCC 连接器接入"
              >
                发送到 {targets.find((item) => item.id === target)?.name}
              </Button>
              <p className="text-center text-xs leading-5 text-white/36">当前不会启动或修改任何外部 DCC 软件。</p>
            </div>
          </WorkflowPanel>

          <WorkflowPanel title="交付队列" description="任务、重试、取消和回执共用同一 Job ID">
            <div className="grid min-h-36 place-items-center p-5 text-center">
              <div>
                <Clock3 className="mx-auto h-6 w-6 text-white/22" />
                <p className="mt-2 text-xs text-white/42">当前没有运行中的交付任务</p>
              </div>
            </div>
          </WorkflowPanel>
        </aside>
      </div>
    </WorkflowShell>
  );
}

function SummaryRow({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-white/38">{label}</span>
      <span className={cn('truncate text-right font-medium text-white/72', accent && 'text-liclick-orange')}>{value}</span>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-3 hover:bg-white/4">
      <span className="text-sm text-white/68">{label}</span>
      <input
        className="peer sr-only"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="relative h-5 w-9 rounded-full bg-white/12 transition-colors peer-checked:bg-liclick-purple after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />
    </label>
  );
}

function ConfirmRow({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-white/48">{label}</span>
      {ready ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Circle className="h-3.5 w-3.5 text-white/22" />}
    </div>
  );
}

function FlamePlaceholder() {
  return (
    <div className="grid h-9 w-9 place-items-center rounded-lg border border-white/8 bg-white/4">
      <Cuboid className="h-4 w-4 text-white/34" />
    </div>
  );
}
