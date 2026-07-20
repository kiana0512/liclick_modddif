import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  Box,
  Check,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleHelp,
  Clock3,
  Download,
  FileUp,
  Flame,
  Hand,
  Layers3,
  PackageCheck,
  RotateCcw,
  ScanLine,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react';
import {
  bakeEngineProfiles,
  defaultBakeDraftSettings,
  type BakeEngineId,
  type BakeMatchMode,
  type BakeProjectionMode,
} from '@liclick/core';
import { cn } from '@/components/common/cn';
import { Button } from '@/components/ui/Button';
import { useBakeModelAnalysis, type BakeModelFileInput } from '@/features/bake/useBakeModelAnalysis';
import { BakeSceneOverlay, type BakeViewportMode } from '@/features/bake/BakeSceneOverlay';
import { WorkflowShell } from '@/features/workflow/WorkflowShell';
import { ModuleOneReadonlyViewport } from '@/features/workflow/ModuleOneReadonlyViewport';
import { useWorkflowProject } from '@/features/workflow/useWorkflowProject';
import { focusCameraOrbitOnObjectId, setCameraToObjectView, type ObjectViewPreset } from '@/engine/scene/transformActions';
import {
  bakeOutputUrl,
  downloadBakeOutput,
  getNormalBakeJob,
  submitNormalBake,
  type BakeChannelId,
  type NormalBakeJob,
} from '@/services/bakeApiClient';
import { saveBlobAsset, saveProject } from '@/services/workspaceApiClient';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { shortcutMatches } from '@/stores/shortcutStore';
import type { ModelBoundingBox, SceneObject } from '@/types/model';
import type { BakeDraftSettings, Project, ProjectBakeSetState } from '@/types/project';

type BakeStage = 'assets' | 'alignment' | 'bake' | 'check' | 'pbr' | 'publish';
type ChannelId = 'baseColor' | 'ambientOcclusion' | 'normal';
type QualityPreset = 'preview' | 'production';

const stages: Array<{
  id: BakeStage;
  index: string;
  label: string;
  short: string;
  icon: LucideIcon;
}> = [
  { id: 'assets', index: '01', label: '资产', short: '高模、低模与颜色', icon: PackageCheck },
  { id: 'alignment', index: '02', label: '匹配', short: '位置、比例与 UV', icon: ScanLine },
  { id: 'bake', index: '03', label: '烘焙', short: '生成基础贴图', icon: Flame },
  { id: 'check', index: '04', label: '检查', short: '漏烘与接缝', icon: Search },
  { id: 'pbr', index: '05', label: 'PBR 处理', short: 'Roughness · Metallic', icon: Box },
  { id: 'publish', index: '06', label: '发布', short: '进入交付', icon: Send },
];

const channelLabels: Record<ChannelId, string> = {
  baseColor: 'Base Color',
  ambientOcclusion: 'AO',
  normal: 'Normal',
};

const resultChannelOrder: BakeChannelId[] = ['baseColor', 'ambientOcclusion', 'normal'];
const channelFileSuffix: Record<BakeChannelId, string> = {
  baseColor: 'BaseColor',
  ambientOcclusion: 'AO',
  normal: 'Normal',
};

function getBakeOutput(job: NormalBakeJob | undefined, channel: BakeChannelId) {
  if (!job) return undefined;
  return job.outputs?.[channel] ?? (channel === 'normal' ? job.output : undefined);
}

const MAX_BAKE_SIZE_DELTA_RATIO = 0.05;
// Bounding-box centers naturally differ when the low-poly silhouette is a
// simplified approximation of the high-poly mesh. Treat only >5% as a real
// alignment blocker; the projection envelope handles smaller shape deltas.
const MAX_BAKE_CENTER_DELTA_RATIO = 0.05;

function maxDimension(box?: ModelBoundingBox) {
  return box ? Math.max(...box.size) : undefined;
}

function centerDistance(a?: ModelBoundingBox, b?: ModelBoundingBox) {
  if (!a || !b) return undefined;
  return Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1], a.center[2] - b.center[2]);
}

function percent(value?: number) {
  return value === undefined || !Number.isFinite(value) ? '待计算' : `${(value * 100).toFixed(1)}%`;
}

function fileStem(value: string) {
  return value.replace(/\.[^.]+$/, '').toLowerCase().replace(/(?:_low|_high|_cage|low|high|cage)$/g, '');
}

function isLowOrCageName(value: string) {
  const stem = value.replace(/\.[^.]+$/, '').toLowerCase();
  return /(?:^|[_\-.])(low|cage)(?:$|[_\-.])/.test(stem) || /(?:low|cage)$/.test(stem);
}

function assignFilesToObjects(
  files: File[],
  objects: SceneObject[],
  preferredId: string | undefined,
  previous: Record<string, File>,
) {
  const next = { ...previous };
  if (files.length === 1 && preferredId) {
    next[preferredId] = files[0];
    return next;
  }
  const unused = [...objects];
  files.forEach((file) => {
    const stem = fileStem(file.name);
    const matched = unused.find((object) => {
      const objectStem = fileStem(object.name);
      return objectStem.includes(stem) || stem.includes(objectStem);
    });
    const target = matched ?? unused[0];
    if (!target) return;
    next[target.id] = file;
    unused.splice(unused.indexOf(target), 1);
  });
  return next;
}

export function BakeWorkspacePage({
  projectId,
  onBack,
  onOpenTexture,
  onOpenDelivery,
}: {
  projectId: string;
  onBack: () => void;
  onOpenTexture: () => void;
  onOpenDelivery: () => void;
}) {
  const lowInputRef = useRef<HTMLInputElement>(null);
  const cageInputRef = useRef<HTMLInputElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const fileTargetIdRef = useRef<string>();
  const hydratedProjectRef = useRef('');
  const applyingSettingsRef = useRef(false);
  const settingsSignatureRef = useRef('');
  const restoredJobRef = useRef('');
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const autoLowPairRef = useRef(new Set<string>());
  const { project, isLoading, error } = useWorkflowProject(projectId);
  const replaceCurrentProject = useProjectStore((state) => state.replaceCurrentProject);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const liveSceneObjects = useSceneStore((state) => state.objects);
  const liveImportedModels = useSceneStore((state) => state.importedModels);
  const workspaceObjects = useMemo(() => {
    const persistedObjects = project?.objects ?? [];
    if (currentProjectId !== projectId || liveSceneObjects.length === 0) return persistedObjects;
    const persistedIds = new Set(persistedObjects.map((object) => object.id));
    const additions = liveSceneObjects.filter((object) => !persistedIds.has(object.id));
    // Preserve the project's array identity when both stores already describe
    // the same objects. Rebuilding it here makes the readonly viewport write a
    // new scene array on every effect pass and causes an update-depth loop.
    return additions.length === 0 ? persistedObjects : [...persistedObjects, ...additions];
  }, [currentProjectId, liveSceneObjects, project?.objects, projectId]);
  const viewportProject = useMemo(
    () => project ? { ...project, objects: workspaceObjects } : undefined,
    [project, workspaceObjects],
  );
  const highObjects = useMemo(
    () => {
      const models = workspaceObjects.filter((object) => object.type === 'mesh' || object.type === 'group');
      const explicitHigh = models.filter((object) => !isLowOrCageName(object.name));
      return explicitHigh.length > 0 ? explicitHigh : models;
    },
    [workspaceObjects],
  );
  const [selectedObjectId, setSelectedObjectId] = useState('');
  const [activeStage, setActiveStage] = useState<BakeStage>('assets');
  const [viewportMode, setViewportMode] = useState<BakeViewportMode>('high');
  const [viewportResetKey, setViewportResetKey] = useState(0);
  const [lowFiles, setLowFiles] = useState<Record<string, File>>({});
  const [cageFiles, setCageFiles] = useState<Record<string, File>>({});
  const [colorFiles, setColorFiles] = useState<Record<string, File>>({});
  const [engine, setEngine] = useState<BakeEngineId>(defaultBakeDraftSettings.engine);
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>('production');
  const [resolution, setResolution] = useState(4096);
  const [frontalDistance, setFrontalDistance] = useState(0.1);
  const [rearDistance, setRearDistance] = useState(0.1);
  const [projectionMode, setProjectionMode] = useState<BakeProjectionMode>('distance');
  const [cageInflation, setCageInflation] = useState(0.03);
  const [matchMode, setMatchMode] = useState<BakeMatchMode>('always');
  const [sampling, setSampling] = useState('4x4');
  const [padding, setPadding] = useState(16);
  const [normalOrientation, setNormalOrientation] = useState<'directx' | 'opengl'>('directx');
  const [device, setDevice] = useState<'gpu' | 'cpu'>('gpu');
  const [udim, setUdim] = useState(1001);
  const [hitStrategy, setHitStrategy] = useState<'inward' | 'closest-from-source'>('inward');
  const [ignoreBackfaces, setIgnoreBackfaces] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [preflightRan, setPreflightRan] = useState(false);
  const [roughnessSource, setRoughnessSource] = useState<'manual' | 'comfy'>('manual');
  const [cleanBaseColor, setCleanBaseColor] = useState(false);
  const [enabledChannels, setEnabledChannels] = useState<Set<ChannelId>>(() => new Set(['normal']));
  const [bakeJob, setBakeJob] = useState<NormalBakeJob>();
  const [bakeSubmitting, setBakeSubmitting] = useState(false);
  const [bakeError, setBakeError] = useState<string>();
  const [assetSaveState, setAssetSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [selectedResultChannel, setSelectedResultChannel] = useState<BakeChannelId>('normal');
  const [resultLightboxOpen, setResultLightboxOpen] = useState(false);
  const [downloadingResult, setDownloadingResult] = useState(false);
  const lowInputs = useMemo<BakeModelFileInput[]>(
    () => Object.entries(lowFiles).map(([objectId, file]) => ({ objectId, file })),
    [lowFiles],
  );
  const cageInputs = useMemo<BakeModelFileInput[]>(
    () => Object.entries(cageFiles).map(([objectId, file]) => ({ objectId, file })),
    [cageFiles],
  );
  const alignmentInfo = useBakeModelAnalysis(lowInputs, cageInputs);

  useEffect(() => {
    if (!project || currentProjectId !== projectId || workspaceObjects === project.objects) return;
    replaceCurrentProject({ ...project, objects: workspaceObjects, dirty: true });
  }, [currentProjectId, project, projectId, replaceCurrentProject, workspaceObjects]);

  const persistProjectUpdate = useCallback((update: (current: Project) => Project) => {
    saveQueueRef.current = saveQueueRef.current.catch(() => undefined).then(async () => {
      const current = useProjectStore.getState().projects.find((item) => item.id === projectId);
      if (!current) return;
      const next = update(current);
      replaceCurrentProject(next);
      const result = await saveProject(next);
      replaceCurrentProject(result.project);
    });
    return saveQueueRef.current;
  }, [projectId, replaceCurrentProject]);

  const persistImportedFiles = useCallback(async (
    kind: 'low' | 'cage' | 'color',
    assigned: Record<string, File>,
  ) => {
    if (Object.keys(assigned).length === 0) return;
    setAssetSaveState('saving');
    try {
      const uploaded = await Promise.all(Object.entries(assigned).map(async ([objectId, file]) => {
        const result = await saveBlobAsset({
          projectId,
          category: kind === 'color' ? 'references' : 'models',
          blob: file,
          filename: `bake-${objectId}-${kind}-${file.name}`,
        });
        return [objectId, {
          name: file.name,
          url: result.asset.url,
          relativePath: result.asset.relativePath,
          mimeType: file.type,
        }] as const;
      }));
      await persistProjectUpdate((current) => {
        const bakeSets = { ...(current.bakeWorkspace?.bakeSets ?? {}) };
        const assetManifest = { ...(current.assetManifest ?? { models: [], references: [], generations: [], layers: [], baked: [] }) };
        uploaded.forEach(([objectId, asset]) => {
          const previous = bakeSets[objectId] ?? { objectId };
          bakeSets[objectId] = { ...previous, [kind]: asset };
          const category = kind === 'color' ? 'references' : 'models';
          assetManifest[category] = Array.from(new Set([...(assetManifest[category] ?? []), asset.relativePath ?? asset.url]));
        });
        return {
          ...current,
          assetManifest,
          bakeWorkspace: {
            version: 1,
            activeStage,
            selectedObjectId: fileTargetIdRef.current ?? selectedObjectId,
            bakeSets,
          },
        };
      });
      setAssetSaveState('saved');
    } catch (reason) {
      setAssetSaveState('error');
      setBakeError(reason instanceof Error ? `资产自动保存失败：${reason.message}` : '资产自动保存失败');
    }
  }, [activeStage, persistProjectUpdate, projectId, selectedObjectId]);

  useEffect(() => {
    if (!project || highObjects.length === 0) return;
    const lowObjects = workspaceObjects.filter((object) => isLowOrCageName(object.name) && /(?:^|[_\-.])low(?:$|[_\-.])|low$/i.test(object.name.replace(/\.[^.]+$/, '')));
    const pending = highObjects.flatMap((high) => {
      if (lowFiles[high.id]) return [];
      const low = lowObjects.find((candidate) => fileStem(candidate.name) === fileStem(high.name));
      if (!low) return [];
      const pairKey = `${high.id}:${low.id}`;
      if (autoLowPairRef.current.has(pairKey)) return [];
      const liveModel = liveImportedModels.find((model) => model.objectId === low.id);
      const source = liveModel?.objectUrl ?? low.sourcePath;
      if (!source || !/^(https?:|blob:|data:)/.test(source)) return [];
      autoLowPairRef.current.add(pairKey);
      return [{ highId: high.id, low, source }];
    });
    if (pending.length === 0) return;
    let cancelled = false;
    void Promise.all(pending.map(async ({ highId, low, source }) => {
      const response = await fetch(source, { credentials: 'include' });
      if (!response.ok) throw new Error(`${low.name} 读取失败（${response.status}）`);
      const blob = await response.blob();
      return [highId, new File([blob], low.name, { type: blob.type || 'application/octet-stream' })] as const;
    })).then((entries) => {
      if (cancelled) return;
      const assigned = Object.fromEntries(entries);
      setLowFiles((current) => ({ ...current, ...assigned }));
      setActiveStage('alignment');
      setViewportMode('overlay');
      void persistImportedFiles('low', assigned);
    }).catch((reason: unknown) => {
      if (!cancelled) setBakeError(reason instanceof Error ? `模块 1 低模接入失败：${reason.message}` : '模块 1 低模接入失败');
    });
    return () => { cancelled = true; };
  }, [highObjects, liveImportedModels, lowFiles, persistImportedFiles, project, workspaceObjects]);

  useEffect(() => {
    const workspace = project?.bakeWorkspace;
    if (!project || !workspace || hydratedProjectRef.current === project.id) return;
    hydratedProjectRef.current = project.id;
    if (workspace.selectedObjectId) setSelectedObjectId(workspace.selectedObjectId);
    if (workspace.activeStage) setActiveStage(workspace.activeStage);
    let cancelled = false;
    const restoreKind = async (kind: 'low' | 'cage' | 'color') => {
      const entries = await Promise.all(Object.entries(workspace.bakeSets).map(async ([objectId, set]) => {
        const asset = set[kind];
        if (!asset?.url) return undefined;
        const response = await fetch(asset.url, { credentials: 'include' });
        if (!response.ok) throw new Error(`${asset.name} 读取失败（${response.status}）`);
        const blob = await response.blob();
        return [objectId, new File([blob], asset.name, { type: asset.mimeType || blob.type })] as const;
      }));
      return Object.fromEntries(entries.filter((entry): entry is readonly [string, File] => Boolean(entry)));
    };
    void Promise.all([restoreKind('low'), restoreKind('cage'), restoreKind('color')])
      .then(([low, cage, color]) => {
        if (cancelled) return;
        setLowFiles(low);
        setCageFiles(cage);
        setColorFiles(color);
        setAssetSaveState('saved');
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setAssetSaveState('error');
          setBakeError(reason instanceof Error ? `烘焙资产恢复失败：${reason.message}` : '烘焙资产恢复失败');
        }
      });
    return () => { cancelled = true; };
  }, [project]);

  useEffect(() => {
    if (!selectedObjectId && highObjects[0]) setSelectedObjectId(project?.activeObjectId ?? highObjects[0].id);
  }, [highObjects, project?.activeObjectId, selectedObjectId]);

  useEffect(() => {
    if (!bakeJob || bakeJob.status === 'succeeded' || bakeJob.status === 'failed') return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getNormalBakeJob(bakeJob.id).then((next) => {
        if (cancelled) return;
        setBakeJob(next);
      }).catch((reason: unknown) => {
        if (!cancelled) setBakeError(reason instanceof Error ? reason.message : '烘焙状态读取失败');
      });
    }, 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bakeJob]);

  useEffect(() => {
    if (bakeJob?.status !== 'succeeded') return;
    if (getBakeOutput(bakeJob, selectedResultChannel)) return;
    const firstAvailable = resultChannelOrder.find((channel) => getBakeOutput(bakeJob, channel));
    if (firstAvailable) setSelectedResultChannel(firstAvailable);
  }, [bakeJob, selectedResultChannel]);

  const selectedHigh = highObjects.find((object) => object.id === selectedObjectId) ?? highObjects[0];
  const projectColorForObject = useCallback(
    (objectId: string) => {
      const baked = [...(project?.bakedTextures ?? [])]
        .reverse()
        .find((item) => item.objectId === objectId && Boolean(item.imageUrl));
      if (baked) return { name: '模块 1 已烘焙 Base Color', imageUrl: baked.imageUrl };
      const layer = project?.layers.find(
        (item) => item.objectId === objectId && item.visible && Boolean(item.imageUrl),
      );
      if (layer) return { name: layer.name, imageUrl: layer.imageUrl };
      if (highObjects.length === 1) {
        const fallback = project?.layers.find((item) => item.visible && Boolean(item.imageUrl));
        if (fallback) return { name: fallback.name, imageUrl: fallback.imageUrl };
      }
      return undefined;
    },
    [highObjects.length, project?.bakedTextures, project?.layers],
  );

  const selectedLow = selectedHigh ? lowFiles[selectedHigh.id] : undefined;
  const selectedCage = selectedHigh ? cageFiles[selectedHigh.id] : undefined;
  const selectedColor = selectedHigh ? colorFiles[selectedHigh.id] : undefined;
  const selectedProjectColor = selectedHigh ? projectColorForObject(selectedHigh.id) : undefined;
  const selectedColorName = selectedColor?.name ?? selectedProjectColor?.name;
  const selectedLowInfo = selectedHigh ? alignmentInfo.low[selectedHigh.id] : undefined;
  const currentDraftSettings = useMemo<BakeDraftSettings>(() => ({
    engine,
    qualityPreset,
    resolution,
    frontalDistance,
    rearDistance,
    projectionMode,
    cageInflation,
    matchMode,
    sampling,
    padding,
    normalOrientation,
    device,
    udim,
    hitStrategy,
    ignoreBackfaces,
    enabledChannels: Array.from(enabledChannels),
  }), [
    cageInflation, device, enabledChannels, engine, frontalDistance, hitStrategy,
    ignoreBackfaces, matchMode, normalOrientation, padding, projectionMode,
    qualityPreset, rearDistance, resolution, sampling, udim,
  ]);

  useEffect(() => {
    if (!selectedHigh) return;
    const saved = project?.bakeWorkspace?.bakeSets[selectedHigh.id]?.settings;
    if (!saved) {
      settingsSignatureRef.current = '';
      return;
    }
    applyingSettingsRef.current = true;
    setEngine(saved.engine);
    setQualityPreset(saved.qualityPreset);
    setResolution(saved.resolution);
    setFrontalDistance(saved.frontalDistance);
    setRearDistance(saved.rearDistance);
    setProjectionMode(saved.projectionMode);
    setCageInflation(saved.cageInflation);
    setMatchMode(saved.matchMode);
    setSampling(saved.sampling);
    setPadding(saved.padding);
    setNormalOrientation(saved.normalOrientation);
    setDevice(saved.device);
    setUdim(saved.udim);
    setHitStrategy(saved.hitStrategy);
    setIgnoreBackfaces(saved.ignoreBackfaces);
    setEnabledChannels(new Set(saved.enabledChannels));
    settingsSignatureRef.current = `${selectedHigh.id}:${project?.bakeWorkspace?.activeStage ?? activeStage}:${project?.bakeWorkspace?.bakeSets[selectedHigh.id]?.lastJobId ?? ''}:${JSON.stringify(saved)}`;
    window.setTimeout(() => { applyingSettingsRef.current = false; }, 0);
  }, [activeStage, project?.bakeWorkspace, selectedHigh]);

  useEffect(() => {
    if (!selectedHigh) return;
    const jobId = project?.bakeWorkspace?.bakeSets[selectedHigh.id]?.lastJobId;
    if (!jobId || restoredJobRef.current === jobId || bakeJob?.id === jobId) return;
    restoredJobRef.current = jobId;
    void getNormalBakeJob(jobId).then(setBakeJob).catch(() => undefined);
  }, [bakeJob?.id, project?.bakeWorkspace, selectedHigh]);

  useEffect(() => {
    if (!selectedHigh || applyingSettingsRef.current) return;
    const signature = `${selectedHigh.id}:${activeStage}:${bakeJob?.id ?? ''}:${JSON.stringify(currentDraftSettings)}`;
    if (signature === settingsSignatureRef.current) return;
    const timer = window.setTimeout(() => {
      settingsSignatureRef.current = signature;
      setAssetSaveState('saving');
      void persistProjectUpdate((current) => {
        const bakeSets = { ...(current.bakeWorkspace?.bakeSets ?? {}) };
        const previous: ProjectBakeSetState = bakeSets[selectedHigh.id] ?? { objectId: selectedHigh.id };
        bakeSets[selectedHigh.id] = { ...previous, settings: currentDraftSettings, lastJobId: bakeJob?.id };
        return {
          ...current,
          bakeWorkspace: { version: 1, activeStage, selectedObjectId: selectedHigh.id, bakeSets },
        };
      }).then(() => setAssetSaveState('saved')).catch((reason: unknown) => {
        setAssetSaveState('error');
        setBakeError(reason instanceof Error ? `烘焙设置保存失败：${reason.message}` : '烘焙设置保存失败');
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [activeStage, bakeJob?.id, currentDraftSettings, persistProjectUpdate, selectedHigh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const viewShortcuts: Array<[Parameters<typeof shortcutMatches>[1], ObjectViewPreset]> = [
        ['view.front', 'front'], ['view.back', 'back'], ['view.right', 'right'],
        ['view.left', 'left'], ['view.top', 'top'], ['view.bottom', 'bottom'],
      ];
      const view = viewShortcuts.find(([action]) => shortcutMatches(event, action));
      if (view) {
        event.preventDefault();
        setCameraToObjectView(selectedHigh?.id, view[1]);
        return;
      }
      if (shortcutMatches(event, 'view.toggleProjection')) {
        event.preventDefault();
        const scene = useSceneStore.getState();
        scene.setProjectionMode(scene.projectionMode === 'perspective' ? 'orthographic' : 'perspective');
        return;
      }
      if (shortcutMatches(event, 'view.focus')) {
        event.preventDefault();
        focusCameraOrbitOnObjectId(selectedHigh?.id);
        return;
      }
      if (shortcutMatches(event, 'project.save') && selectedHigh) {
        event.preventDefault();
        setAssetSaveState('saving');
        void persistProjectUpdate((current) => {
          const bakeSets = { ...(current.bakeWorkspace?.bakeSets ?? {}) };
          bakeSets[selectedHigh.id] = {
            ...(bakeSets[selectedHigh.id] ?? { objectId: selectedHigh.id }),
            settings: currentDraftSettings,
            lastJobId: bakeJob?.id,
          };
          return { ...current, bakeWorkspace: { version: 1, activeStage, selectedObjectId: selectedHigh.id, bakeSets } };
        }).then(() => setAssetSaveState('saved')).catch(() => setAssetSaveState('error'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeStage, bakeJob?.id, currentDraftSettings, persistProjectUpdate, selectedHigh]);
  const highBox = selectedHigh?.originalBoundingBox ?? selectedHigh?.boundingBox;
  const lowBox = selectedLowInfo?.boundingBox;
  const highSize = maxDimension(highBox);
  const lowSize = maxDimension(lowBox);
  const sizeDelta = highSize && lowSize ? Math.abs(highSize - lowSize) / highSize : undefined;
  const rawCenterDistance = centerDistance(highBox, lowBox);
  const positionDelta = highSize && rawCenterDistance !== undefined ? rawCenterDistance / highSize : undefined;
  const hasUv0 = selectedLowInfo?.uvSets.includes('UV0') ?? false;
  const requiresColor = enabledChannels.has('baseColor');
  const selectedReady = Boolean(selectedHigh && selectedLow && (!requiresColor || selectedColorName));
  const allRequiredAssetsReady = highObjects.length > 0 && highObjects.every((object) =>
    Boolean(lowFiles[object.id] && (!requiresColor || colorFiles[object.id] || projectColorForObject(object.id)?.imageUrl)),
  );
  const alignmentReady = Boolean(
    selectedReady && hasUv0 && sizeDelta !== undefined && sizeDelta < MAX_BAKE_SIZE_DELTA_RATIO && positionDelta !== undefined && positionDelta < MAX_BAKE_CENTER_DELTA_RATIO,
  );
  const cageReady = Boolean(selectedLow && (projectionMode === 'distance' || selectedCage || engine === 'marmoset-toolbag'));
  const channelReady = enabledChannels.size > 0;
  const preflightPassed = alignmentReady && cageReady && channelReady;
  const preflightIssues = useMemo(() => {
    const issues: Array<{ id: string; title: string; detail: string; action?: 'low' | 'cage' | 'color' }> = [];
    if (!channelReady) {
      issues.push({ id: 'channels', title: '尚未选择输出贴图', detail: '请至少选择 Base Color、AO 或 Normal 中的一项。' });
    }
    if (!selectedLow) {
      issues.push({ id: 'low', title: '尚未选择低模', detail: '请选择带 UV0 的低模文件。', action: 'low' });
      return issues;
    }
    if (requiresColor && !selectedColorName) {
      issues.push({ id: 'color', title: 'Base Color 缺少颜色贴图', detail: '选择高模颜色贴图，或取消 Base Color；只烘焙 Normal / AO 不需要颜色贴图。', action: 'color' });
    }
    if (!hasUv0) {
      issues.push({ id: 'uv0', title: '低模缺少 UV0', detail: '当前低模不能承接烘焙贴图，请在 DCC 中展开 UV0 后重新导入。', action: 'low' });
    }
    if (sizeDelta === undefined) {
      issues.push({ id: 'size-pending', title: '尺寸尚未计算', detail: '模型仍在解析，请稍后重新运行预检。' });
    } else if (sizeDelta >= MAX_BAKE_SIZE_DELTA_RATIO) {
      issues.push({ id: 'size', title: `高低模尺寸差 ${percent(sizeDelta)}`, detail: '允许值小于 5%，请统一单位和缩放后重新导入低模。', action: 'low' });
    }
    if (positionDelta === undefined) {
      issues.push({ id: 'position-pending', title: '中心偏移尚未计算', detail: '模型仍在解析，请稍后重新运行预检。' });
    } else if (positionDelta >= MAX_BAKE_CENTER_DELTA_RATIO) {
      issues.push({ id: 'position', title: `高低模包围盒中心差 ${percent(positionDelta)}`, detail: '允许值小于 5%。这通常表示世界位置或原点未对齐，请在 DCC 中应用变换后重新导入低模；调整 Cage 不能修复坐标错位。', action: 'low' });
    }
    if (!cageReady) {
      issues.push({ id: 'cage', title: '缺少 Cage 包裹框', detail: '当前选择了 Cage 投射，请导入匹配的 Cage 文件。', action: 'cage' });
    }
    return issues;
  }, [cageReady, channelReady, hasUv0, positionDelta, requiresColor, selectedColorName, selectedLow, sizeDelta]);

  function chooseFiles(kind: 'low' | 'cage' | 'color', objectId?: string) {
    fileTargetIdRef.current = objectId ?? selectedHigh?.id;
    if (kind === 'low') lowInputRef.current?.click();
    if (kind === 'cage') cageInputRef.current?.click();
    if (kind === 'color') colorInputRef.current?.click();
  }

  function openStage(stage: BakeStage) {
    setActiveStage(stage);
    if (stage === 'alignment' && selectedLow) setViewportMode('overlay');
    if (stage !== 'alignment') setViewportMode('high');
  }

  function selectObject(objectId: string) {
    setSelectedObjectId(objectId);
    setViewportResetKey((value) => value + 1);
  }

  function selectPreset(preset: QualityPreset) {
    setQualityPreset(preset);
    setResolution(preset === 'preview' ? 2048 : 4096);
    setSampling(preset === 'preview' ? '2x2' : '4x4');
  }

  function updateAutoCageInflation(value: number) {
    setCageInflation(value);
    if (projectionMode === 'distance') {
      setFrontalDistance(value);
      setRearDistance(value);
    }
    setViewportMode('cage');
  }

  function toggleChannel(channel: ChannelId) {
    setEnabledChannels((current) => {
      const next = new Set(current);
      if (next.has(channel)) next.delete(channel);
      else next.add(channel);
      return next;
    });
  }

  async function createHighFile() {
    const liveModel = liveImportedModels.find((model) => model.objectId === selectedHigh?.id);
    const source = liveModel?.objectUrl ?? selectedHigh?.sourcePath;
    if (!source) throw new Error('高模源文件路径不可用，请重新导入高模。');
    const response = await fetch(source, { credentials: 'include' });
    if (!response.ok) throw new Error(`读取高模失败（${response.status}）。`);
    const blob = await response.blob();
    return new File([blob], selectedHigh.name, { type: blob.type || 'application/octet-stream' });
  }

  async function createColorFile() {
    if (selectedColor) return selectedColor;
    if (!selectedProjectColor?.imageUrl) throw new Error('Base Color 烘焙需要高模颜色贴图。');
    const response = await fetch(selectedProjectColor.imageUrl, { credentials: 'include' });
    if (!response.ok) throw new Error(`读取高模颜色贴图失败（${response.status}）。`);
    const blob = await response.blob();
    return new File([blob], `${fileStem(selectedHigh?.name ?? 'high')}_BaseColor.png`, { type: blob.type || 'image/png' });
  }

  async function handleCreateBakeJob() {
    if (!project || !selectedHigh || !selectedLow) return;
    if (engine !== 'substance-designer') {
      setBakeError('Marmoset 真实适配器尚未接入；请选择 Substance。');
      return;
    }
    setBakeSubmitting(true);
    setBakeError(undefined);
    try {
      const high = await createHighFile();
      const color = enabledChannels.has('baseColor') ? await createColorFile() : undefined;
      const job = await submitNormalBake({
        projectId: project.id,
        objectId: selectedHigh.id,
        high,
        low: selectedLow,
        cage: projectionMode === 'cage' ? selectedCage : undefined,
        color,
        settings: {
          resolution: resolution as 1024 | 2048 | 4096 | 8192,
          padding,
          sampling: sampling as '1x1' | '2x2' | '4x4' | '8x8',
          normalOrientation,
          device,
          udim,
          frontalDistance,
          rearDistance,
          matchMode,
          projectionMode,
          hitStrategy,
          ignoreBackfaces,
          channels: Array.from(enabledChannels),
        },
      });
      setBakeJob(job);
    } catch (reason) {
      setBakeError(reason instanceof Error ? reason.message : '创建烘焙任务失败');
    } finally {
      setBakeSubmitting(false);
    }
  }

  function handlePrimaryAction() {
    if (activeStage === 'assets') return openStage('alignment');
    if (activeStage === 'alignment') {
      setPreflightRan(true);
      if (preflightPassed) openStage('bake');
      return;
    }
    if (activeStage === 'bake') {
      if (bakeJob?.status === 'succeeded') return openStage('check');
      setPreflightRan(true);
      if (preflightPassed) void handleCreateBakeJob();
      return;
    }
    if (activeStage === 'check') return openStage('pbr');
    if (activeStage === 'pbr') return openStage('publish');
    onOpenDelivery();
  }

  const primaryLabel: Record<BakeStage, string> = {
    assets: '进入模型匹配',
    alignment: '继续：烘焙设置',
    bake: '创建烘焙任务',
    check: '进入 PBR 处理',
    pbr: '保存 PBR 版本',
    publish: '进入交付模块',
  };
  const primaryActionLabel = activeStage === 'alignment' && preflightRan && !preflightPassed
    ? `重新预检（${preflightIssues.length} 项待修复）`
    : activeStage === 'bake' && bakeSubmitting
      ? '正在上传模型…'
      : activeStage === 'bake' && (bakeJob?.status === 'queued' || bakeJob?.status === 'running')
        ? `贴图烘焙中 ${bakeJob.progress}%`
        : activeStage === 'bake' && bakeJob?.status === 'succeeded'
          ? '查看烘焙结果'
        : primaryLabel[activeStage];
  const selectedResultOutput = getBakeOutput(bakeJob, selectedResultChannel);
  const selectedResultUrl = bakeJob ? bakeOutputUrl(bakeJob, selectedResultChannel) : undefined;
  const selectedResultFilename = `${fileStem(selectedHigh?.name ?? 'bake')}_${channelFileSuffix[selectedResultChannel]}`;

  const stageState = (stage: BakeStage) => {
    if (stage === activeStage) return 'active';
    if (stage === 'assets' && allRequiredAssetsReady) return 'done';
    if (stage === 'alignment' && alignmentReady) return 'done';
    return 'pending';
  };

  const selectedSetProgress = selectedHigh
    ? Number(Boolean(selectedHigh)) + Number(Boolean(selectedLow)) + Number(Boolean(requiresColor && selectedColorName))
    : 0;
  const selectedSetRequirementCount = requiresColor ? 3 : 2;
  const selectedObjectIndex = Math.max(0, highObjects.findIndex((object) => object.id === selectedHigh?.id));

  function selectAdjacentObject(offset: number) {
    if (highObjects.length === 0) return;
    const nextIndex = (selectedObjectIndex + offset + highObjects.length) % highObjects.length;
    selectObject(highObjects[nextIndex].id);
  }

  return (
    <WorkflowShell
      projectName={project?.name ?? (isLoading ? '正在载入项目…' : '未找到项目')}
      eyebrow="MODULE 2 · PROFESSIONAL BAKE"
      onBack={onBack}
      connected={!error}
      navigation={{ activeModule: 'bake', onOpenTexture, onOpenBake: () => undefined, onOpenDelivery }}
    >
      <input
        ref={lowInputRef}
        className="hidden"
        type="file"
        multiple
        accept=".fbx,.obj,.glb,.gltf"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          const assigned = assignFilesToObjects(files, highObjects, fileTargetIdRef.current, {});
          setLowFiles((current) => ({ ...current, ...assigned }));
          void persistImportedFiles('low', assigned);
          setActiveStage('alignment');
          setViewportMode('overlay');
          event.target.value = '';
        }}
      />
      {resultLightboxOpen && selectedResultUrl ? (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/86 p-8 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`${channelLabels[selectedResultChannel]} 全尺寸预览`} onClick={() => setResultLightboxOpen(false)}>
          <div className="max-h-full max-w-full overflow-hidden rounded-lg border border-white/15 bg-[#0b0d19] shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <img src={selectedResultUrl} alt={`${channelLabels[selectedResultChannel]} 全尺寸贴图`} className="max-h-[86vh] max-w-[86vw] object-contain" />
          </div>
        </div>
      ) : null}
      <input
        ref={cageInputRef}
        className="hidden"
        type="file"
        multiple
        accept=".fbx,.obj,.glb,.gltf"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          const assigned = assignFilesToObjects(files, highObjects, fileTargetIdRef.current, {});
          setCageFiles((current) => ({ ...current, ...assigned }));
          void persistImportedFiles('cage', assigned);
          setProjectionMode('cage');
          setViewportMode('cage');
          event.target.value = '';
        }}
      />
      <input
        ref={colorInputRef}
        className="hidden"
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,.tga"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          const assigned = assignFilesToObjects(files, highObjects, fileTargetIdRef.current, {});
          setColorFiles((current) => ({ ...current, ...assigned }));
          void persistImportedFiles('color', assigned);
          event.target.value = '';
        }}
      />

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_92px] gap-2.5 bg-[#090b16] px-3 pb-3 pt-[82px] text-[13px]">
        <div className="grid min-h-0 gap-2.5 xl:grid-cols-[334px_minmax(0,1fr)_408px]">
          <aside className="flex min-h-0 flex-col gap-3">
            <ConceptPanel className="shrink-0">
              <ConceptHeader
                title="资产"
                description={`当前 Bake Set · ${selectedObjectIndex + 1}/${Math.max(highObjects.length, 1)}`}
                help
                actions={highObjects.length > 1 ? (
                  <div className="flex gap-1">
                    <ConceptIconButton label="上一组" onClick={() => selectAdjacentObject(-1)}><ChevronLeft className="h-4 w-4" /></ConceptIconButton>
                    <ConceptIconButton label="下一组" onClick={() => selectAdjacentObject(1)}><ChevronRight className="h-4 w-4" /></ConceptIconButton>
                  </div>
                ) : undefined}
              />
              <div className="space-y-2 p-3">
                <ConceptAssetRow label="高模 (High)" value={selectedHigh?.name ?? '未找到高模'} ready={Boolean(selectedHigh)} thumbnail={project?.thumbnail} />
                <ConceptAssetRow label="低模 (Low)" value={selectedLow?.name ?? '选择带 UV0 的低模'} ready={Boolean(selectedLow)} warning={Boolean(selectedLow && !hasUv0)} onClick={() => chooseFiles('low')} wire />
                <ConceptAssetRow label="高模颜色 (High Color) · 可选" value={selectedColorName ?? '仅烘焙 Base Color 时需要'} ready={Boolean(selectedColorName)} thumbnail={project?.thumbnail} onClick={() => chooseFiles('color')} />
              </div>
            </ConceptPanel>

            <ConceptPanel className="min-h-0 flex-1">
              <ConceptHeader title="烘焙工作流" description={`${highObjects.length} 个 Bake Set · 每组独立保留状态`} />
              <nav className="space-y-1 p-2" aria-label="PBR 烘焙流程">
                {stages.map((stage) => (
                  <ConceptStageRow key={stage.id} stage={stage} state={stageState(stage.id)} onClick={() => openStage(stage.id)} />
                ))}
              </nav>
            </ConceptPanel>
          </aside>

          <section className="relative min-h-[520px] min-w-0 overflow-hidden rounded-lg border border-white/10 bg-[#0d0f1c] xl:min-h-0">
            {preflightRan && !preflightPassed ? (
              <div className="absolute inset-x-4 top-4 z-30 flex min-h-16 items-center justify-between gap-4 rounded-lg border border-amber-300/25 bg-[#201a18]/94 px-4 py-3 shadow-2xl backdrop-blur-md" role="alert">
                <div className="flex min-w-0 items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-amber-50">预检未通过：{preflightIssues[0]?.title ?? '模型匹配需要检查'}</p>
                    <p className="mt-1 truncate text-xs text-amber-100/58">{preflightIssues[0]?.detail}</p>
                    {preflightIssues.length > 1 ? <p className="mt-1 text-[11px] text-amber-200/42">另有 {preflightIssues.length - 1} 项问题，请查看右侧完整列表。</p> : null}
                  </div>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded-md border border-amber-200/25 bg-amber-100/8 px-3 py-2 text-xs font-medium text-amber-50 hover:bg-amber-100/14"
                  onClick={() => {
                    const action = preflightIssues[0]?.action;
                    if (action) chooseFiles(action);
                    else setPreflightRan(false);
                  }}
                >
                  {preflightIssues[0]?.action === 'low' ? '重新选择低模' : preflightIssues[0]?.action === 'cage' ? '选择 Cage' : preflightIssues[0]?.action === 'color' ? '选择颜色贴图' : '重新检测'}
                </button>
              </div>
            ) : null}
            <div className="absolute left-4 top-4 z-20 flex items-center rounded-lg border border-white/[0.08] bg-[#111321]/88 p-1 shadow-xl backdrop-blur">
              <ViewportTool label="旋转" icon={<RotateCcw className="h-4 w-4" />} active />
              <ViewportTool label="平移" icon={<Hand className="h-4 w-4" />} />
              <ViewportTool label="缩放" icon={<ZoomIn className="h-4 w-4" />} />
              <ViewportTool label="框选" icon={<ScanLine className="h-4 w-4" />} />
            </div>
            <div className="absolute right-4 top-4 z-20 flex items-center gap-1.5">
              <div className="flex h-10 items-center rounded-lg border border-white/12 bg-[#0c0d18]/92 p-1 shadow-xl">
                <ViewportModeButton label="高模" active={viewportMode === 'high'} onClick={() => setViewportMode('high')} icon={<Sparkles className="h-3.5 w-3.5" />} />
                <ViewportModeButton label="叠加" active={viewportMode === 'overlay'} onClick={() => setViewportMode('overlay')} icon={<Layers3 className="h-3.5 w-3.5" />} />
                <ViewportModeButton label="Cage" active={viewportMode === 'cage'} onClick={() => setViewportMode('cage')} icon={<ScanLine className="h-3.5 w-3.5" />} />
              </div>
              <button
                type="button"
                className="flex h-10 items-center gap-2 rounded-lg border border-white/12 bg-[#0c0d18]/92 px-3 text-sm text-white/64 shadow-xl hover:text-white"
                onClick={() => setViewportResetKey((value) => value + 1)}
              >
                <RotateCcw className="h-4 w-4" />重置视图
              </button>
            </div>

            {viewportProject && selectedHigh ? (
              <ModuleOneReadonlyViewport
                key={`${selectedHigh.id}:${viewportResetKey}`}
                project={viewportProject}
                object={selectedHigh}
                sceneOverlay={(
                  <BakeSceneOverlay
                    highObject={selectedHigh}
                    lowFile={selectedLow}
                    cageFile={selectedCage}
                    mode={viewportMode}
                    cageInflation={cageInflation}
                  />
                )}
              />
            ) : (
              <div className="grid h-full place-items-center text-xs text-white/36">等待模块 1 模型视图…</div>
            )}

          </section>

          <aside className="workflow-scrollbar flex min-h-0 flex-col overflow-y-auto rounded-lg border border-white/10 bg-black/35 backdrop-blur-xl">
            <ConceptHeader
              title={`${stages.find((stage) => stage.id === activeStage)?.label ?? '匹配'}设置`}
              description={selectedHigh?.name ?? '当前 Bake Set'}
              help
              actions={<SaveState state={assetSaveState} />}
            />
            <div className="flex-1 p-3.5">
              {activeStage === 'assets' ? (
                <div className="space-y-5">
                  <InspectorSection title="当前 Bake Set" caption={`${selectedSetProgress}/${selectedSetRequirementCount}`}>
                    <AssetLine label="高模" value={selectedHigh?.name ?? '未选择'} ready={Boolean(selectedHigh)} />
                    <AssetLine label="低模 · UV0" value={selectedLow?.name ?? '选择文件'} ready={Boolean(selectedLow)} onClick={() => chooseFiles('low')} />
                    <AssetLine label="高模颜色 · 可选" value={selectedColorName ?? '仅 Base Color 需要'} ready={Boolean(selectedColorName) || !requiresColor} onClick={() => chooseFiles('color')} />
                  </InspectorSection>
                  <p className="text-xs leading-5 text-white/34">可以一次选择多个文件；系统优先按高低模文件名自动组成 Bake Set，未匹配项保留待处理状态。</p>
                </div>
              ) : null}

              {activeStage === 'alignment' ? (
                <div className="space-y-4">
                  <Field label="烘焙器">
                    <Segmented value={engine} options={[{ value: 'substance-designer', label: 'Substance' }, { value: 'marmoset-toolbag', label: 'Marmoset' }]} onChange={setEngine} />
                  </Field>
                  <Field label="质量">
                    <Segmented value={qualityPreset} options={[{ value: 'preview', label: '快速' }, { value: 'production', label: '正式' }]} onChange={selectPreset} />
                  </Field>
                  <Field label="分辨率">
                    <Select value={String(resolution)} options={['1024', '2048', '4096', '8192']} onChange={(value) => setResolution(Number(value))} />
                  </Field>
                  <InspectorSection title="Cage 包围" caption={projectionMode === 'cage' ? '外部模型' : '实时可编辑'}>
                    <div className="space-y-3 py-3">
                      <Segmented value={projectionMode} options={[{ value: 'distance', label: '自动包围' }, { value: 'cage', label: '外部 Cage' }]} onChange={(value) => {
                        setProjectionMode(value);
                        setViewportMode('cage');
                      }} />
                      {projectionMode === 'distance' ? (
                        <>
                          <Field label="包围膨胀" hint={`${(cageInflation * 100).toFixed(1)}%`}>
                            <input aria-label="Cage 包围膨胀" className="bake-range w-full" type="range" min="0" max="0.2" step="0.005" value={cageInflation} onChange={(event) => {
                              updateAutoCageInflation(Number(event.target.value));
                            }} />
                          </Field>
                          <div className="grid grid-cols-2 gap-2">
                            <NumberField label="前方距离" value={frontalDistance} onChange={setFrontalDistance} step={0.01} />
                            <NumberField label="后方距离" value={rearDistance} onChange={setRearDistance} step={0.01} />
                          </div>
                          <p className="text-[11px] leading-4 text-white/36">拖动即在模块 1 视口中更新包围圈，提交时同步为 Substance 前后投射距离。</p>
                        </>
                      ) : (
                        <button type="button" className="compact-button w-full justify-center" onClick={() => chooseFiles('cage')}>
                          <FileUp className="h-3.5 w-3.5" />{selectedCage ? `替换 · ${selectedCage.name}` : '选择外部 Cage'}
                        </button>
                      )}
                    </div>
                  </InspectorSection>
                  <InspectorSection title="输出贴图">
                    {(Object.keys(channelLabels) as ChannelId[]).map((channel) => (
                      <CheckLine key={channel} label={channelLabels[channel]} checked={enabledChannels.has(channel)} onClick={() => toggleChannel(channel)} />
                    ))}
                  </InspectorSection>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center justify-between border-t border-white/10 pt-2 text-[13px] font-medium text-white/56 hover:text-white"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen((value) => !value)}
                  >
                    <span className="flex items-center gap-2"><Settings2 className="h-3.5 w-3.5" />高级设置</span>
                    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', advancedOpen && 'rotate-180')} />
                  </button>
                  {advancedOpen ? (
                    <div className="space-y-4 border-l border-white/10 pl-3">
                      <Field label="名称匹配"><Segmented value={matchMode} options={[{ value: 'always', label: '全部' }, { value: 'by-name', label: '按名称' }]} onChange={setMatchMode} /></Field>
                      <Field label="命中策略"><Segmented value={hitStrategy} options={[{ value: 'inward', label: 'Inward cast' }, { value: 'closest-from-source', label: 'Closest' }]} onChange={setHitStrategy} /></Field>
                      <CheckLine label="忽略背面" checked={ignoreBackfaces} onClick={() => setIgnoreBackfaces((value) => !value)} />
                      <Field label="抗锯齿"><Select value={sampling} options={['1x1', '2x2', '4x4', '8x8']} onChange={setSampling} /></Field>
                      <NumberField label="Padding" value={padding} onChange={setPadding} step={1} />
                      <Field label="法线方向"><Segmented value={normalOrientation} options={[{ value: 'directx', label: 'DirectX' }, { value: 'opengl', label: 'OpenGL' }]} onChange={setNormalOrientation} /></Field>
                      <Field label="计算设备"><Segmented value={device} options={[{ value: 'gpu', label: 'GPU' }, { value: 'cpu', label: 'CPU' }]} onChange={setDevice} /></Field>
                      <NumberField label="UDIM" value={udim} onChange={setUdim} step={1} />
                    </div>
                  ) : null}
                  <div className="space-y-1.5 border-t border-white/8 pt-3">
                    {preflightRan && !preflightPassed ? (
                      <div className="mb-3 space-y-2 rounded-lg border border-amber-300/16 bg-amber-300/[0.035] p-3">
                        <p className="flex items-center gap-2 text-xs font-semibold text-amber-100"><AlertTriangle className="h-3.5 w-3.5" />需要先修复以下问题</p>
                        {preflightIssues.map((issue) => (
                          <div key={issue.id} className="border-t border-amber-100/10 pt-2">
                            <p className="text-xs text-amber-50/86">{issue.title}</p>
                            <p className="mt-1 text-[11px] leading-4 text-amber-100/44">{issue.detail}</p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <StatusLine label="低模 UV0" value={selectedLow ? (hasUv0 ? '正常' : '缺失') : '待选择'} ready={hasUv0} />
                    <StatusLine label="尺寸差" value={percent(sizeDelta)} ready={sizeDelta !== undefined && sizeDelta < MAX_BAKE_SIZE_DELTA_RATIO} />
                    <StatusLine label="包围盒中心差" value={percent(positionDelta)} ready={positionDelta !== undefined && positionDelta < MAX_BAKE_CENTER_DELTA_RATIO} />
                  </div>
                  <p className="rounded-md border border-white/8 bg-black/20 px-2.5 py-2 text-[10px] text-white/30">快捷键：F 聚焦 · Num 1/3/7 视图 · Num 5 正交 · Ctrl+S 保存</p>
                </div>
              ) : null}

              {activeStage === 'bake' ? (
                <div className="space-y-5">
                  <InspectorSection title="任务摘要" caption={selectedHigh?.name}>
                    <SummaryLine label="烘焙器" value={bakeEngineProfiles[engine].shortName} />
                    <SummaryLine label="输出" value={`${resolution} · ${sampling} · ${padding}px`} />
                    <SummaryLine label="通道" value={Array.from(enabledChannels).map((id) => channelLabels[id]).join(' · ')} />
                  </InspectorSection>
                  <p className="text-xs leading-5 text-white/38">每个 Bake Set 独立提交和记录；失败对象不会阻塞其他对象。</p>
                  {engine !== 'substance-designer' ? <p className="rounded-lg border border-amber-300/20 bg-amber-950/20 p-3 text-xs text-amber-100">Marmoset 当前仅保留界面配置，真实执行请切换 Substance。</p> : null}
                  {bakeJob ? (
                    <BakeProgressPanel job={bakeJob} />
                  ) : null}
                  {bakeError || bakeJob?.error ? <p className="rounded-lg border border-rose-300/20 bg-rose-950/28 p-3 text-xs leading-5 text-rose-100">{bakeError ?? bakeJob?.error}</p> : null}
                </div>
              ) : null}

              {activeStage === 'check' ? (
                <div className="space-y-5">
                  <InspectorSection title="结果检查">
                    {resultChannelOrder.map((channel) => {
                      const output = getBakeOutput(bakeJob, channel);
                      const requested = bakeJob?.settings.channels?.includes(channel) ?? channel === 'normal';
                      return <AssetLine key={channel} label={channelLabels[channel]} value={output ? `${output.width} × ${output.height} · 点击查看` : requested ? '待烘焙' : '本次未选择'} ready={Boolean(output)} active={selectedResultChannel === channel && Boolean(output)} onClick={output ? () => setSelectedResultChannel(channel) : undefined} />;
                    })}
                  </InspectorSection>
                  {bakeJob?.status === 'succeeded' && selectedResultOutput && selectedResultUrl ? (
                    <div className="overflow-hidden rounded-lg border border-white/10 bg-black/25">
                      <button type="button" className="block w-full cursor-zoom-in" title="点击查看全尺寸" onClick={() => setResultLightboxOpen(true)}>
                        <img src={selectedResultUrl} alt={`${channelLabels[selectedResultChannel]} 烘焙贴图`} className={cn('aspect-square w-full object-contain', selectedResultChannel === 'normal' ? 'bg-[#777f]' : 'bg-black/30')} />
                      </button>
                      <div className="flex items-center justify-between border-t border-white/10 px-3 py-2.5">
                        <div>
                          <p className="text-[12px] font-medium text-white/76">{selectedResultFilename}.png</p>
                          <p className="mt-0.5 text-[10px] text-white/34">{channelLabels[selectedResultChannel]} · PNG · {selectedResultOutput.width} × {selectedResultOutput.height}</p>
                        </div>
                        <button
                          type="button"
                          disabled={downloadingResult}
                          className="inline-flex min-w-[128px] cursor-pointer items-center justify-center gap-2 rounded-lg border border-white/14 bg-white/[0.055] px-3 py-2 text-[12px] font-medium text-white/72 transition-colors hover:border-[#c454d2]/45 hover:bg-[#9c43bd]/14 hover:text-white disabled:cursor-wait disabled:opacity-55"
                          onClick={async (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setDownloadingResult(true);
                            setBakeError(undefined);
                            try {
                              await downloadBakeOutput(bakeJob, selectedResultChannel, selectedResultFilename);
                            } catch (reason) {
                              setBakeError(reason instanceof Error ? reason.message : '下载贴图失败');
                            } finally {
                              setDownloadingResult(false);
                            }
                          }}
                        ><Download className="h-3.5 w-3.5" />{downloadingResult ? '正在下载…' : '下载贴图'}</button>
                      </div>
                    </div>
                  ) : null}
                  <p className="text-xs leading-5 text-white/38">这里只检查漏烘、接缝、Padding 和通道有效性。</p>
                </div>
              ) : null}

              {activeStage === 'pbr' ? (
                <div className="space-y-5">
                  <InspectorSection title="PBR 通道">
                    <SummaryLine label="Base Color" value="烘焙结果" />
                    <SummaryLine label="AO" value="烘焙结果" />
                    <SummaryLine label="Normal" value={normalOrientation === 'directx' ? 'DirectX' : 'OpenGL'} />
                    <SummaryLine label="Roughness" value={roughnessSource === 'comfy' ? 'ComfyUI' : '手工贴图'} />
                    <SummaryLine label="Metallic" value="手工贴图" />
                  </InspectorSection>
                  <Field label="粗糙度来源"><Segmented value={roughnessSource} options={[{ value: 'manual', label: '手工' }, { value: 'comfy', label: 'ComfyUI' }]} onChange={setRoughnessSource} /></Field>
                  <ToggleLine label="净化 Base Color" checked={cleanBaseColor} onChange={setCleanBaseColor} />
                  <p className="text-xs leading-5 text-white/38">ComfyUI 为可选远程步骤；断开时继续使用原始 Base Color 和手工 Roughness。</p>
                </div>
              ) : null}

              {activeStage === 'publish' ? (
                <div className="space-y-5">
                  <InspectorSection title="发布内容">
                    <SummaryLine label="Bake Sets" value={`${highObjects.length} 个`} />
                    <SummaryLine label="已就绪" value={`${Object.keys(lowFiles).length} 个低模`} />
                    <SummaryLine label="Normal" value={normalOrientation === 'directx' ? 'DirectX' : 'OpenGL'} />
                    <SummaryLine label="记录" value="Manifest + Job 日志" />
                  </InspectorSection>
                  <p className="text-xs leading-5 text-white/38">发布后冻结模型、贴图、单位、法线方向与来源 Job ID，再进入模块 3。</p>
                </div>
              ) : null}
            </div>

          </aside>
        </div>

        <footer className="flex min-w-0 items-stretch gap-2.5 rounded-lg border border-white/10 bg-black/40 p-2.5 backdrop-blur-xl">
          <div className="flex min-w-[900px] flex-1 items-stretch gap-2">
            {stages.map((stage, index) => {
              const Icon = stage.icon;
              const state = stageState(stage.id);
              return (
                <div key={stage.id} className="flex min-w-0 flex-1 items-center">
                  <button
                    type="button"
                    className={cn(
                      'flex h-full min-w-0 flex-1 items-center gap-3 rounded-lg border px-4 text-left transition-colors',
                      state === 'active'
                        ? 'border-[#b64bd0]/70 bg-[#7e3999]/18 text-white shadow-[0_0_20px_rgba(166,69,195,0.12)]'
                        : 'border-white/8 bg-[#0d0f1b]/60 text-white/50 hover:border-white/15 hover:text-white/80',
                    )}
                    onClick={() => openStage(stage.id)}
                  >
                    <Icon className={cn('h-5 w-5 shrink-0', state === 'active' && 'text-[#db56d2]', state === 'done' && 'text-emerald-300')} />
                    <span className="min-w-0">
                      <strong className="block truncate text-[13px] font-medium">{stage.label}</strong>
                      <small className="mt-0.5 block truncate text-[10px] text-white/32">{stage.short}</small>
                    </span>
                  </button>
                  {index < stages.length - 1 ? <ChevronRight className="mx-1 h-4 w-4 shrink-0 text-white/24" /> : null}
                </div>
              );
            })}
          </div>
          <div className="w-px bg-white/10" />
          <Button
            variant="primary"
            className="h-full min-w-[276px] rounded-lg px-6 text-sm"
            onClick={handlePrimaryAction}
            disabled={activeStage === 'bake' && (engine !== 'substance-designer' || !preflightPassed || bakeSubmitting || bakeJob?.status === 'queued' || bakeJob?.status === 'running')}
            icon={activeStage === 'alignment' ? <ShieldCheck className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          >
            {primaryActionLabel}
          </Button>
        </footer>
      </div>
    </WorkflowShell>
  );
}

function ConceptPanel({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn('overflow-hidden rounded-lg border border-white/10 bg-black/35 backdrop-blur-xl', className)}>{children}</section>;
}

function ConceptHeader({
  title,
  description,
  actions,
  help,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  help?: boolean;
}) {
  return (
    <header className="flex min-h-[62px] items-center justify-between gap-3 border-b border-white/10 px-3.5 py-2.5">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 truncate text-[13px] font-semibold text-white/86">{title}{help ? <CircleHelp className="h-3.5 w-3.5 text-white/34" /> : null}</h2>
        <p className="mt-1 truncate text-[11px] font-normal text-white/40">{description}</p>
      </div>
      {actions}
    </header>
  );
}

function ConceptIconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} className="grid h-8 w-8 place-items-center rounded-md border border-white/10 text-white/48 hover:bg-white/6 hover:text-white" onClick={onClick}>
      {children}
    </button>
  );
}

function ConceptAssetRow({
  label,
  value,
  ready,
  warning,
  thumbnail,
  wire,
  onClick,
}: {
  label: string;
  value: string;
  ready: boolean;
  warning?: boolean;
  thumbnail?: string;
  wire?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/[0.08] bg-[#0c0e1a]">
        {thumbnail ? <img src={thumbnail} alt="" className="h-full w-full object-cover" /> : wire ? <Box className="h-7 w-7 text-[#d88943]" /> : <Box className="h-7 w-7 text-white/30" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13px] font-medium text-white/84">
          <span className={cn('h-2.5 w-2.5 rounded-full', ready ? 'bg-emerald-300' : warning ? 'bg-amber-300' : 'bg-white/22')} />
          {label}
        </span>
        <span className="mt-1 block truncate text-[12px] font-normal text-white/42" title={value}>{value}</span>
        {warning ? <span className="mt-1.5 block text-[11px] text-[#e8973d]">UV0 或拓扑需要检查</span> : null}
      </span>
      {onClick ? <FileUp className="h-4 w-4 shrink-0 text-white/34" /> : null}
    </>
  );
  const className = "flex min-h-[74px] w-full items-center gap-3 rounded-lg border border-white/[0.08] bg-[#0c0e1a]/56 p-2.5 text-left transition-colors hover:border-white/16 hover:bg-white/[0.03]";
  return onClick ? <button type="button" className={className} onClick={onClick}>{content}</button> : <div className={className}>{content}</div>;
}

function ConceptStageRow({
  stage,
  state,
  onClick,
}: {
  stage: (typeof stages)[number];
  state: 'done' | 'active' | 'pending';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-11 w-full items-center gap-3 rounded-lg border px-3 text-left transition-colors',
        state === 'active' ? 'border-[#8858c7]/65 bg-[#674490]/18 text-white' : 'border-transparent text-white/56 hover:bg-white/[0.045] hover:text-white',
      )}
      onClick={onClick}
    >
      <span className={cn('grid h-7 w-7 place-items-center rounded-md border text-[11px] font-medium', state === 'active' ? 'border-[#9564d7] bg-[#7450a4]/24 text-[#cba4ff]' : state === 'done' ? 'border-emerald-300/50 text-emerald-300' : 'border-white/16 text-white/46')}>
        {state === 'done' ? <Check className="h-4 w-4" /> : stage.index}
      </span>
      <span className="flex-1 text-[13px] font-medium">{stage.label}</span>
      {state === 'active' ? <Circle className="h-4 w-4 text-white/70" /> : state === 'done' ? <Check className="h-4 w-4 text-emerald-300" /> : <Circle className="h-4 w-4 text-white/24" />}
    </button>
  );
}

function ViewportTool({ label, icon, active, onClick }: { label: string; icon: ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" title={label} className={cn('flex h-10 min-w-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[10px] font-medium text-white/52 hover:bg-white/[0.055] hover:text-white', active && 'bg-[#72519a]/18 text-[#c794f5]')} onClick={onClick}>
      {icon}<span>{label}</span>
    </button>
  );
}

function ViewportModeButton({ label, icon, active, onClick }: { label: string; icon: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn('flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] text-white/48 hover:text-white', active && 'bg-[#72519a]/28 text-[#d6a8ff]')}
      onClick={onClick}
    >
      {icon}{label}
    </button>
  );
}

function InspectorSection({ title, caption, children }: { title: string; caption?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[12px] font-semibold text-white/64">{title}</h3>
        {caption ? <span className="max-w-36 truncate text-[11px] text-white/28">{caption}</span> : null}
      </div>
      <div className="divide-y divide-white/8 rounded-lg border border-white/10 bg-[#0c0e1a]/56 px-3">{children}</div>
    </section>
  );
}

function SaveState({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  const labels = { idle: '自动保存', saving: '保存中…', saved: '已保存', error: '保存失败' } as const;
  return (
    <span title="Ctrl+S 保存烘焙工作区" className={cn(
      'flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[10px]',
      state === 'error' ? 'border-rose-300/18 text-rose-200/70' : 'border-white/8 text-white/34',
    )}>
      <span className={cn('h-1.5 w-1.5 rounded-full', state === 'saving' ? 'animate-pulse bg-[#dd50cc]' : state === 'error' ? 'bg-rose-300' : 'bg-emerald-300')} />
      {labels[state]}
    </span>
  );
}

const bakeStageOrder: NormalBakeJob['stage'][] = ['waiting-for-worker', 'baking-maps', 'verifying-file', 'finished'];
const bakeStageLabels: Record<NormalBakeJob['stage'], string> = {
  'waiting-for-worker': '准备文件',
  'baking-maps': 'Substance 烘焙',
  'verifying-file': '验证输出',
  finished: '完成',
};

function formatBakeDuration(job: NormalBakeJob) {
  const start = new Date(job.startedAt ?? job.createdAt).getTime();
  const end = new Date(job.finishedAt ?? job.updatedAt).getTime();
  const seconds = Math.max(0, (end - start) / 1000);
  return seconds < 60 ? `${seconds.toFixed(1)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

function BakeProgressPanel({ job }: { job: NormalBakeJob }) {
  const currentIndex = bakeStageOrder.indexOf(job.stage);
  const statusLabel = job.status === 'queued'
    ? '等待执行'
    : job.status === 'running'
      ? '正在烘焙'
      : job.status === 'succeeded'
        ? '烘焙完成'
        : '烘焙失败';
  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-[#0c0e1a]/60">
      <div className="flex items-start justify-between border-b border-white/8 px-3 py-3">
        <div>
          <p className="text-[12px] font-semibold text-white/78">{statusLabel}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[10px] text-white/34"><Clock3 className="h-3 w-3" />{formatBakeDuration(job)} · {job.id.slice(-8)}</p>
        </div>
        <strong className={cn('text-xl font-semibold tabular-nums', job.status === 'failed' ? 'text-rose-300' : 'text-[#dc61d5]')}>{job.progress}%</strong>
      </div>
      <div className="px-3 py-3">
        <div className="h-1 overflow-hidden rounded-full bg-white/8">
          <div className="h-full rounded-full bg-gradient-to-r from-[#ec55cd] to-[#8b60ef] transition-[width] duration-500" style={{ width: `${job.progress}%` }} />
        </div>
        <div className="mt-3 grid grid-cols-4 gap-1">
          {bakeStageOrder.map((stage, index) => {
            const done = index < currentIndex || job.status === 'succeeded';
            const active = index === currentIndex && job.status !== 'succeeded';
            return (
              <div key={stage} className="min-w-0 text-center">
                <span className={cn(
                  'mx-auto grid h-5 w-5 place-items-center rounded-full border text-[9px]',
                  done ? 'border-emerald-300/50 bg-emerald-300/10 text-emerald-200' : active ? 'border-[#d85bce]/70 bg-[#d85bce]/12 text-[#ef9bea]' : 'border-white/10 text-white/28',
                )}>{done ? <Check className="h-3 w-3" /> : index + 1}</span>
                <span className={cn('mt-1 block truncate text-[9px]', active ? 'text-white/64' : 'text-white/28')}>{bakeStageLabels[stage]}</span>
              </div>
            );
          })}
        </div>
      </div>
      {job.logs.length ? (
        <details className="border-t border-white/8 px-3 py-2">
          <summary className="cursor-pointer select-none text-[10px] text-white/34 hover:text-white/58">技术日志 · {job.logs.length} 条</summary>
          <div className="workflow-scrollbar mt-2 max-h-28 overflow-y-auto rounded bg-black/25 p-2">
            {job.logs.map((line, index) => <p key={`${index}-${line}`} className="break-all py-0.5 font-mono text-[9px] leading-3.5 text-white/28">{line}</p>)}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function AssetLine({ label, value, ready, active = false, onClick }: { label: string; value: string; ready: boolean; active?: boolean; onClick?: () => void }) {
  const content = (
    <>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[13px] text-white/68', active && 'text-white')}>{label}</span>
        <span className="mt-0.5 block truncate text-[11px] text-white/30" title={value}>{value}</span>
      </span>
      {ready ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : onClick ? <FileUp className="h-3.5 w-3.5 text-white/34" /> : <Circle className="h-3.5 w-3.5 text-white/24" />}
    </>
  );
  return onClick ? <button type="button" className={cn('flex w-full items-center gap-3 rounded px-1 py-2.5 text-left transition-colors hover:bg-white/[0.035]', active && 'bg-[#9c43bd]/10')} onClick={onClick}>{content}</button> : <div className="flex items-center gap-3 py-2.5">{content}</div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label className="text-[13px] font-medium text-white/70">{label}</label>
        {hint ? <span className="text-xs text-white/30">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function CheckLine({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
  return (
    <button type="button" className="flex w-full items-center gap-2.5 py-2 text-left" onClick={onClick}>
      <span className={cn('grid h-4 w-4 place-items-center rounded-[3px] border border-white/18', checked && 'border-[#bd4cce] bg-[#9c43bd]')}>
        {checked ? <Check className="h-3 w-3" /> : null}
      </span>
      <span className="text-[13px] text-white/68">{label}</span>
    </button>
  );
}

function StatusLine({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return <div className="flex items-center justify-between text-[11px]"><span className="text-white/32">{label}</span><span className={ready ? 'text-emerald-300/80' : 'text-white/42'}>{value}</span></div>;
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-4 py-2.5 text-[12px]"><span className="text-white/36">{label}</span><span className="max-w-[190px] truncate text-right text-white/64" title={value}>{value}</span></div>;
}

function ToggleLine({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between border-y border-white/8 py-2.5">
      <span className="text-[12px] text-white/58">{label}</span>
      <input className="peer sr-only" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="relative h-[18px] w-8 rounded-full bg-white/10 peer-checked:bg-[#8d42b0] after:absolute after:left-0.5 after:top-0.5 after:h-3.5 after:w-3.5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-3.5" />
    </label>
  );
}

function NumberField({ label, value, onChange, step }: { label: string; value: number; onChange: (value: number) => void; step: number }) {
  return <Field label={label}><input aria-label={label} className="compact-input w-full" type="number" min="0" step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></Field>;
}

function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <select value={value} className="compact-input w-full" onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option}>{option}</option>)}
    </select>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn('h-11 rounded-lg border border-white/[0.08] bg-[#0d0f1b] px-3 text-[13px] font-medium text-white/48 hover:border-white/16 hover:text-white/80', value === option.value && 'border-[#865cc5]/70 bg-[#69438d]/14 text-white shadow-[inset_0_0_0_1px_rgba(134,92,197,0.1)]')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
