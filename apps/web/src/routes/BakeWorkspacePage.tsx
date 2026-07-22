import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
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
  Settings2,
  ShieldCheck,
  Sparkles,
  ZoomIn,
  X,
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
import {
  useBakeModelAnalysis,
  type BakeModelFileInput,
} from '@/features/bake/useBakeModelAnalysis';
import { BakeSceneOverlay, type BakeViewportMode } from '@/features/bake/BakeSceneOverlay';
import { WorkflowShell } from '@/features/workflow/WorkflowShell';
import { ModuleOneReadonlyViewport } from '@/features/workflow/ModuleOneReadonlyViewport';
import { useWorkflowProject } from '@/features/workflow/useWorkflowProject';
import {
  focusCameraOrbitOnObjectId,
  setCameraToObjectView,
  type ObjectViewPreset,
} from '@/engine/scene/transformActions';
import { loadModelFromFile } from '@/engine/loaders/loadModelFromFile';
import {
  bakeOutputUrl,
  downloadAllBakeOutputs,
  downloadBakeOutput,
  getNormalBakeJob,
  getSubstanceBakerStatus,
  submitNormalBake,
  type BakeChannelId,
  type NormalBakeJob,
  type SubstanceBakerStatus,
} from '@/services/bakeApiClient';
import { saveBlobAsset, saveProject } from '@/services/workspaceApiClient';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { shortcutMatches } from '@/stores/shortcutStore';
import type { ModelBoundingBox, SceneObject } from '@/types/model';
import type { BakeDraftSettings, Project, ProjectBakeSetState } from '@/types/project';

type BakeStage = 'assets' | 'alignment' | 'bake' | 'check' | 'pbr';
type ChannelId =
  | 'baseColor'
  | 'normal'
  | 'ambientOcclusion'
  | 'curvature'
  | 'worldNormal'
  | 'thickness'
  | 'position'
  | 'roughness'
  | 'metallic';
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
];

const channelLabels: Record<ChannelId, string> = {
  baseColor: 'Base Color',
  normal: 'Normal',
  ambientOcclusion: 'AO',
  curvature: 'Curvature',
  worldNormal: 'World Normal',
  thickness: 'Thickness',
  position: 'Position',
  roughness: 'Roughness',
  metallic: 'Metallic',
};

const channelShortLabels: Record<ChannelId, string> = {
  baseColor: '颜色',
  normal: '法线',
  ambientOcclusion: 'AO',
  curvature: '曲率',
  worldNormal: '世界法线',
  thickness: '厚度',
  position: 'Position',
  roughness: '粗糙度',
  metallic: '金属度',
};

const resultChannelOrder: BakeChannelId[] = [
  'baseColor',
  'normal',
  'roughness',
  'metallic',
  'ambientOcclusion',
  'curvature',
  'worldNormal',
  'thickness',
  'position',
];
const defaultOneClickChannels: ChannelId[] = ['baseColor', 'normal'];
const channelFileSuffix: Record<BakeChannelId, string> = {
  baseColor: 'BaseColor',
  normal: 'Normal',
  ambientOcclusion: 'AO',
  curvature: 'Curvature',
  worldNormal: 'WorldNormal',
  thickness: 'Thickness',
  position: 'Position',
  roughness: 'Roughness',
  metallic: 'Metallic',
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
// A uniform scale can hide that two imports are completely different meshes.
// Compare their normalized axis proportions as a cheap silhouette preflight.
const MAX_BAKE_SHAPE_DELTA_RATIO = 0.12;

function maxDimension(box?: ModelBoundingBox) {
  return box ? Math.max(...box.size) : undefined;
}

function centerDistance(a?: ModelBoundingBox, b?: ModelBoundingBox) {
  if (!a || !b) return undefined;
  return Math.hypot(
    a.center[0] - b.center[0],
    a.center[1] - b.center[1],
    a.center[2] - b.center[2],
  );
}

function shapeDeltaRatio(a?: ModelBoundingBox, b?: ModelBoundingBox) {
  if (!a || !b) return undefined;
  const aMax = Math.max(...a.size);
  const bMax = Math.max(...b.size);
  if (!aMax || !bMax) return undefined;
  return Math.max(...a.size.map((value, index) => Math.abs(value / aMax - b.size[index] / bMax)));
}

function percent(value?: number) {
  return value === undefined || !Number.isFinite(value) ? '待计算' : `${(value * 100).toFixed(1)}%`;
}

function fileStem(value: string) {
  return value
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/(?:_low|_high|_cage|low|high|cage)$/g, '');
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
}: {
  projectId: string;
  onBack: () => void;
  onOpenTexture: () => void;
}) {
  const highInputRef = useRef<HTMLInputElement>(null);
  const lowInputRef = useRef<HTMLInputElement>(null);
  const cageInputRef = useRef<HTMLInputElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const roughnessInputRef = useRef<HTMLInputElement>(null);
  const metallicInputRef = useRef<HTMLInputElement>(null);
  const fileTargetIdRef = useRef<string>();
  const hydratedProjectRef = useRef('');
  const applyingSettingsRef = useRef(false);
  const hydratedSettingsObjectRef = useRef('');
  const settingsSignatureRef = useRef('');
  const restoredJobRef = useRef('');
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const autoLowPairRef = useRef(new Set<string>());
  const { project, isLoading, error } = useWorkflowProject(projectId);
  const replaceCurrentProject = useProjectStore((state) => state.replaceCurrentProject);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const liveSceneObjects = useSceneStore((state) => state.objects);
  const liveImportedModels = useSceneStore((state) => state.importedModels);
  const setImportedModel = useSceneStore((state) => state.setImportedModel);
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
    () => (project ? { ...project, objects: workspaceObjects } : undefined),
    [project, workspaceObjects],
  );
  const highObjects = useMemo(() => {
    const models = workspaceObjects.filter(
      (object) => object.type === 'mesh' || object.type === 'group',
    );
    const explicitHigh = models.filter((object) => !isLowOrCageName(object.name));
    return explicitHigh.length > 0 ? explicitHigh : models;
  }, [workspaceObjects]);
  const [selectedObjectId, setSelectedObjectId] = useState('');
  const [activeStage, setActiveStage] = useState<BakeStage>('assets');
  const [viewportMode, setViewportMode] = useState<BakeViewportMode>('high');
  const [viewportResetKey, setViewportResetKey] = useState(0);
  const [lowFiles, setLowFiles] = useState<Record<string, File>>({});
  const [cageFiles, setCageFiles] = useState<Record<string, File>>({});
  const [colorFiles, setColorFiles] = useState<Record<string, File>>({});
  const [roughnessFiles, setRoughnessFiles] = useState<Record<string, File>>({});
  const [metallicFiles, setMetallicFiles] = useState<Record<string, File>>({});
  const [materialDialogOpen, setMaterialDialogOpen] = useState(false);
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
  const [enabledChannels, setEnabledChannels] = useState<Set<ChannelId>>(
    () => new Set(defaultOneClickChannels),
  );
  const [bakeJob, setBakeJob] = useState<NormalBakeJob>();
  const [bakeSubmitting, setBakeSubmitting] = useState(false);
  const [bakeError, setBakeError] = useState<string>();
  const [oneClickBakeAttempted, setOneClickBakeAttempted] = useState(false);
  const [highImporting, setHighImporting] = useState(false);
  const [assetSaveState, setAssetSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  );
  const [selectedResultChannel, setSelectedResultChannel] = useState<BakeChannelId>('normal');
  const [resultLightboxOpen, setResultLightboxOpen] = useState(false);
  const [downloadingResult, setDownloadingResult] = useState(false);
  const [downloadingAllResults, setDownloadingAllResults] = useState(false);
  const [bakerStatus, setBakerStatus] = useState<SubstanceBakerStatus>();
  const [bakerStatusChecking, setBakerStatusChecking] = useState(true);
  const lowInputs = useMemo<BakeModelFileInput[]>(
    () => Object.entries(lowFiles).map(([objectId, file]) => ({ objectId, file })),
    [lowFiles],
  );
  const cageInputs = useMemo<BakeModelFileInput[]>(
    () => Object.entries(cageFiles).map(([objectId, file]) => ({ objectId, file })),
    [cageFiles],
  );
  const alignmentInfo = useBakeModelAnalysis(lowInputs, cageInputs);

  const refreshBakerStatus = useCallback(async () => {
    setBakerStatusChecking(true);
    try {
      setBakerStatus(await getSubstanceBakerStatus());
    } catch {
      // Keep the last confirmed result when a recheck is interrupted.
    } finally {
      setBakerStatusChecking(false);
    }
  }, []);

  useEffect(() => {
    void refreshBakerStatus();
  }, [refreshBakerStatus]);

  useEffect(() => {
    if (!project || currentProjectId !== projectId || workspaceObjects === project.objects) return;
    replaceCurrentProject({ ...project, objects: workspaceObjects, dirty: true });
  }, [currentProjectId, project, projectId, replaceCurrentProject, workspaceObjects]);

  const persistProjectUpdate = useCallback(
    (update: (current: Project) => Project) => {
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const current = useProjectStore.getState().projects.find((item) => item.id === projectId);
          if (!current) return;
          const next = update(current);
          replaceCurrentProject(next);
          const result = await saveProject(next);
          replaceCurrentProject(result.project);
        });
      return saveQueueRef.current;
    },
    [projectId, replaceCurrentProject],
  );

  const persistImportedFiles = useCallback(
    async (
      kind: 'low' | 'cage' | 'color' | 'roughness' | 'metallic',
      assigned: Record<string, File>,
    ) => {
      if (Object.keys(assigned).length === 0) return;
      setAssetSaveState('saving');
      try {
        const uploaded = await Promise.all(
          Object.entries(assigned).map(async ([objectId, file]) => {
            const result = await saveBlobAsset({
              projectId,
              category:
                kind === 'color' || kind === 'roughness' || kind === 'metallic'
                  ? 'references'
                  : 'models',
              blob: file,
              filename: `bake-${objectId}-${kind}-${file.name}`,
            });
            return [
              objectId,
              {
                name: file.name,
                url: result.asset.url,
                relativePath: result.asset.relativePath,
                mimeType: file.type,
              },
            ] as const;
          }),
        );
        await persistProjectUpdate((current) => {
          const bakeSets = { ...(current.bakeWorkspace?.bakeSets ?? {}) };
          const assetManifest = {
            ...(current.assetManifest ?? {
              models: [],
              references: [],
              generations: [],
              layers: [],
              baked: [],
            }),
          };
          uploaded.forEach(([objectId, asset]) => {
            const previous = bakeSets[objectId] ?? { objectId };
            bakeSets[objectId] = { ...previous, [kind]: asset };
            const category =
              kind === 'color' || kind === 'roughness' || kind === 'metallic'
                ? 'references'
                : 'models';
            assetManifest[category] = Array.from(
              new Set([...(assetManifest[category] ?? []), asset.relativePath ?? asset.url]),
            );
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
        setBakeError(
          reason instanceof Error ? `资产自动保存失败：${reason.message}` : '资产自动保存失败',
        );
      }
    },
    [activeStage, persistProjectUpdate, projectId, selectedObjectId],
  );

  useEffect(() => {
    if (!project || highObjects.length === 0) return;
    const lowObjects = workspaceObjects.filter(
      (object) =>
        isLowOrCageName(object.name) &&
        /(?:^|[_\-.])low(?:$|[_\-.])|low$/i.test(object.name.replace(/\.[^.]+$/, '')),
    );
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
    void Promise.all(
      pending.map(async ({ highId, low, source }) => {
        const response = await fetch(source, { credentials: 'include' });
        if (!response.ok) throw new Error(`${low.name} 读取失败（${response.status}）`);
        const blob = await response.blob();
        return [
          highId,
          new File([blob], low.name, { type: blob.type || 'application/octet-stream' }),
        ] as const;
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        const assigned = Object.fromEntries(entries);
        setLowFiles((current) => ({ ...current, ...assigned }));
        setActiveStage('alignment');
        setViewportMode('overlay');
        void persistImportedFiles('low', assigned);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setBakeError(
            reason instanceof Error
              ? `模块 1 低模接入失败：${reason.message}`
              : '模块 1 低模接入失败',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [highObjects, liveImportedModels, lowFiles, persistImportedFiles, project, workspaceObjects]);

  useEffect(() => {
    const workspace = project?.bakeWorkspace;
    if (!project || !workspace || hydratedProjectRef.current === project.id) return;
    hydratedProjectRef.current = project.id;
    if (workspace.selectedObjectId) setSelectedObjectId(workspace.selectedObjectId);
    if (workspace.activeStage) {
      setActiveStage(workspace.activeStage === 'publish' ? 'pbr' : workspace.activeStage);
    }
    let cancelled = false;
    const restoreKind = async (kind: 'low' | 'cage' | 'color' | 'roughness' | 'metallic') => {
      const entries = await Promise.all(
        Object.entries(workspace.bakeSets).map(async ([objectId, set]) => {
          const asset = set[kind];
          if (!asset?.url) return undefined;
          const response = await fetch(asset.url, { credentials: 'include' });
          if (!response.ok) throw new Error(`${asset.name} 读取失败（${response.status}）`);
          const blob = await response.blob();
          return [
            objectId,
            new File([blob], asset.name, { type: asset.mimeType || blob.type }),
          ] as const;
        }),
      );
      return Object.fromEntries(
        entries.filter((entry): entry is readonly [string, File] => Boolean(entry)),
      );
    };
    void Promise.all([
      restoreKind('low'),
      restoreKind('cage'),
      restoreKind('color'),
      restoreKind('roughness'),
      restoreKind('metallic'),
    ])
      .then(([low, cage, color, roughness, metallic]) => {
        if (cancelled) return;
        setLowFiles(low);
        setCageFiles(cage);
        setColorFiles(color);
        setRoughnessFiles(roughness);
        setMetallicFiles(metallic);
        setAssetSaveState('saved');
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setAssetSaveState('error');
          setBakeError(
            reason instanceof Error ? `烘焙资产恢复失败：${reason.message}` : '烘焙资产恢复失败',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  useEffect(() => {
    if (!selectedObjectId && highObjects[0])
      setSelectedObjectId(project?.activeObjectId ?? highObjects[0].id);
  }, [highObjects, project?.activeObjectId, selectedObjectId]);

  useEffect(() => {
    if (!bakeJob || bakeJob.status === 'succeeded' || bakeJob.status === 'failed') return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getNormalBakeJob(bakeJob.id)
        .then((next) => {
          if (cancelled) return;
          setBakeJob(next);
        })
        .catch((reason: unknown) => {
          if (!cancelled)
            setBakeError(reason instanceof Error ? reason.message : '烘焙状态读取失败');
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

  const selectedHigh =
    highObjects.find((object) => object.id === selectedObjectId) ?? highObjects[0];
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
  const selectedRoughness = selectedHigh ? roughnessFiles[selectedHigh.id] : undefined;
  const selectedMetallic = selectedHigh ? metallicFiles[selectedHigh.id] : undefined;
  const selectedProjectColor = selectedHigh ? projectColorForObject(selectedHigh.id) : undefined;
  const selectedColorName = selectedColor?.name ?? selectedProjectColor?.name;
  const materialMapCount =
    Number(Boolean(selectedColorName)) +
    Number(Boolean(selectedRoughness)) +
    Number(Boolean(selectedMetallic));
  const selectedLowInfo = selectedHigh ? alignmentInfo.low[selectedHigh.id] : undefined;
  const currentDraftSettings = useMemo<BakeDraftSettings>(
    () => ({
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
    }),
    [
      cageInflation,
      device,
      enabledChannels,
      engine,
      frontalDistance,
      hitStrategy,
      ignoreBackfaces,
      matchMode,
      normalOrientation,
      padding,
      projectionMode,
      qualityPreset,
      rearDistance,
      resolution,
      sampling,
      udim,
    ],
  );

  useEffect(() => {
    if (!selectedHigh) return;
    const hydrationKey = `${project?.id ?? projectId}:${selectedHigh.id}`;
    if (hydratedSettingsObjectRef.current === hydrationKey) return;
    hydratedSettingsObjectRef.current = hydrationKey;
    const saved = project?.bakeWorkspace?.bakeSets[selectedHigh.id]?.settings;
    if (!saved) {
      settingsSignatureRef.current = '';
      setEnabledChannels(new Set(defaultOneClickChannels));
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
    setNormalOrientation(saved.normalOrientation ?? 'directx');
    setDevice(saved.device);
    setUdim(saved.udim);
    setHitStrategy(saved.hitStrategy);
    setIgnoreBackfaces(saved.ignoreBackfaces);
    // A one-click workspace opens with Base Color and Normal selected. Keep the
    // user's live selections stable while autosave updates the project object.
    setEnabledChannels(new Set(defaultOneClickChannels));
    settingsSignatureRef.current = `${selectedHigh.id}:${project?.bakeWorkspace?.activeStage ?? activeStage}:${project?.bakeWorkspace?.bakeSets[selectedHigh.id]?.lastJobId ?? ''}:${JSON.stringify(saved)}`;
    window.setTimeout(() => {
      applyingSettingsRef.current = false;
    }, 0);
  }, [activeStage, project?.bakeWorkspace, project?.id, projectId, selectedHigh]);

  useEffect(() => {
    if (!selectedHigh) return;
    const jobId = project?.bakeWorkspace?.bakeSets[selectedHigh.id]?.lastJobId;
    if (!jobId || restoredJobRef.current === jobId || bakeJob?.id === jobId) return;
    restoredJobRef.current = jobId;
    void getNormalBakeJob(jobId)
      .then(setBakeJob)
      .catch(() => undefined);
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
        const previous: ProjectBakeSetState = bakeSets[selectedHigh.id] ?? {
          objectId: selectedHigh.id,
        };
        bakeSets[selectedHigh.id] = {
          ...previous,
          settings: currentDraftSettings,
          lastJobId: bakeJob?.id,
        };
        return {
          ...current,
          bakeWorkspace: { version: 1, activeStage, selectedObjectId: selectedHigh.id, bakeSets },
        };
      })
        .then(() => setAssetSaveState('saved'))
        .catch((reason: unknown) => {
          setAssetSaveState('error');
          setBakeError(
            reason instanceof Error ? `烘焙设置保存失败：${reason.message}` : '烘焙设置保存失败',
          );
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [activeStage, bakeJob?.id, currentDraftSettings, persistProjectUpdate, selectedHigh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const viewShortcuts: Array<[Parameters<typeof shortcutMatches>[1], ObjectViewPreset]> = [
        ['view.front', 'front'],
        ['view.back', 'back'],
        ['view.right', 'right'],
        ['view.left', 'left'],
        ['view.top', 'top'],
        ['view.bottom', 'bottom'],
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
        scene.setProjectionMode(
          scene.projectionMode === 'perspective' ? 'orthographic' : 'perspective',
        );
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
          return {
            ...current,
            bakeWorkspace: { version: 1, activeStage, selectedObjectId: selectedHigh.id, bakeSets },
          };
        })
          .then(() => setAssetSaveState('saved'))
          .catch(() => setAssetSaveState('error'));
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
  const positionDelta =
    highSize && rawCenterDistance !== undefined ? rawCenterDistance / highSize : undefined;
  const shapeDelta = shapeDeltaRatio(highBox, lowBox);
  const hasUv0 = selectedLowInfo?.uvSets.includes('UV0') ?? false;
  const requiresColor = enabledChannels.has('baseColor');
  const requiresRoughness = enabledChannels.has('roughness');
  const requiresMetallic = enabledChannels.has('metallic');
  const selectedReady = Boolean(
    selectedHigh &&
    selectedLow &&
    (!requiresColor || selectedColorName) &&
    (!requiresRoughness || selectedRoughness) &&
    (!requiresMetallic || selectedMetallic),
  );
  const allRequiredAssetsReady =
    highObjects.length > 0 &&
    highObjects.every((object) =>
      Boolean(
        lowFiles[object.id] &&
        (!requiresColor || colorFiles[object.id] || projectColorForObject(object.id)?.imageUrl) &&
        (!requiresRoughness || roughnessFiles[object.id]) &&
        (!requiresMetallic || metallicFiles[object.id]),
      ),
    );
  const alignmentReady = Boolean(
    selectedReady &&
    hasUv0 &&
    sizeDelta !== undefined &&
    sizeDelta < MAX_BAKE_SIZE_DELTA_RATIO &&
    positionDelta !== undefined &&
    positionDelta < MAX_BAKE_CENTER_DELTA_RATIO &&
    shapeDelta !== undefined &&
    shapeDelta < MAX_BAKE_SHAPE_DELTA_RATIO,
  );
  const alignmentMismatch = Boolean(
    selectedLowInfo &&
    ((sizeDelta !== undefined && sizeDelta >= MAX_BAKE_SIZE_DELTA_RATIO) ||
      (positionDelta !== undefined && positionDelta >= MAX_BAKE_CENTER_DELTA_RATIO) ||
      (shapeDelta !== undefined && shapeDelta >= MAX_BAKE_SHAPE_DELTA_RATIO)),
  );
  const cageReady = Boolean(selectedLow && (projectionMode === 'distance' || selectedCage));
  const channelReady = enabledChannels.size > 0;
  const preflightPassed = alignmentReady && cageReady && channelReady;
  const preflightIssues = useMemo(() => {
    const issues: Array<{
      id: string;
      title: string;
      detail: string;
      action?: 'low' | 'cage' | 'color' | 'roughness' | 'metallic';
    }> = [];
    if (!channelReady) {
      issues.push({
        id: 'channels',
        title: '尚未选择输出贴图',
        detail: '请至少选择 Base Color、AO 或 Normal 中的一项。',
      });
    }
    if (!selectedLow) {
      issues.push({
        id: 'low',
        title: '尚未选择低模',
        detail: '请选择带 UV0 的低模文件。',
        action: 'low',
      });
      return issues;
    }
    if (requiresColor && !selectedColorName) {
      issues.push({
        id: 'color',
        title: 'Base Color 缺少颜色贴图',
        detail: '选择高模颜色贴图，或取消 Base Color；只烘焙 Normal / AO 不需要颜色贴图。',
        action: 'color',
      });
    }
    if (requiresRoughness && !selectedRoughness) {
      issues.push({
        id: 'roughness',
        title: 'Roughness 缺少源贴图',
        detail: '请在材质贴图窗口导入高模 Roughness 贴图，或取消粗糙度输出。',
        action: 'roughness',
      });
    }
    if (requiresMetallic && !selectedMetallic) {
      issues.push({
        id: 'metallic',
        title: 'Metallic 缺少源贴图',
        detail: '请在材质贴图窗口导入高模 Metallic 贴图，或取消金属度输出。',
        action: 'metallic',
      });
    }
    if (!hasUv0) {
      issues.push({
        id: 'uv0',
        title: '低模缺少 UV0',
        detail: '当前低模不能承接烘焙贴图，请在 DCC 中展开 UV0 后重新导入。',
        action: 'low',
      });
    }
    if (sizeDelta === undefined) {
      issues.push({
        id: 'size-pending',
        title: '尺寸尚未计算',
        detail: '模型仍在解析，请稍后重新运行预检。',
      });
    } else if (sizeDelta >= MAX_BAKE_SIZE_DELTA_RATIO) {
      issues.push({
        id: 'size',
        title: `高低模尺寸差 ${percent(sizeDelta)}`,
        detail: '允许值小于 5%，请统一单位和缩放后重新导入低模。',
        action: 'low',
      });
    }
    if (positionDelta === undefined) {
      issues.push({
        id: 'position-pending',
        title: '中心偏移尚未计算',
        detail: '模型仍在解析，请稍后重新运行预检。',
      });
    } else if (positionDelta >= MAX_BAKE_CENTER_DELTA_RATIO) {
      issues.push({
        id: 'position',
        title: `高低模包围盒中心差 ${percent(positionDelta)}`,
        detail:
          '允许值小于 5%。这通常表示世界位置或原点未对齐，请在 DCC 中应用变换后重新导入低模；调整 Cage 不能修复坐标错位。',
        action: 'low',
      });
    }
    if (shapeDelta === undefined) {
      issues.push({
        id: 'shape-pending',
        title: '轮廓比例尚未计算',
        detail: '模型仍在解析，请稍后重新运行预检。',
      });
    } else if (shapeDelta >= MAX_BAKE_SHAPE_DELTA_RATIO) {
      issues.push({
        id: 'shape',
        title: `高低模轮廓比例差 ${percent(shapeDelta)}`,
        detail: '两份文件可能不是同一个模型，或旋转没有应用。请替换为与高模对应的低模。',
        action: 'low',
      });
    }
    if (!cageReady) {
      issues.push({
        id: 'cage',
        title: '缺少 Cage 包裹框',
        detail: '当前选择了 Cage 投射，请导入匹配的 Cage 文件。',
        action: 'cage',
      });
    }
    return issues;
  }, [
    cageReady,
    channelReady,
    hasUv0,
    positionDelta,
    requiresColor,
    requiresMetallic,
    requiresRoughness,
    selectedColorName,
    selectedMetallic,
    selectedLow,
    selectedRoughness,
    shapeDelta,
    sizeDelta,
  ]);

  function chooseFiles(
    kind: 'high' | 'low' | 'cage' | 'color' | 'roughness' | 'metallic',
    objectId?: string,
  ) {
    fileTargetIdRef.current = objectId ?? selectedHigh?.id;
    if (kind === 'high') highInputRef.current?.click();
    if (kind === 'low') lowInputRef.current?.click();
    if (kind === 'cage') cageInputRef.current?.click();
    if (kind === 'color') colorInputRef.current?.click();
    if (kind === 'roughness') roughnessInputRef.current?.click();
    if (kind === 'metallic') metallicInputRef.current?.click();
  }

  function handleLowImport(files: File[]) {
    const modelFiles = files.filter((file) => /\.(fbx|obj|glb|gltf)$/i.test(file.name));
    if (modelFiles.length === 0) {
      setBakeError('低模仅支持 FBX、OBJ、GLB 或 GLTF 文件。');
      return;
    }
    if (!selectedHigh) {
      setBakeError('请先导入高模，再为它添加对应的低模。');
      return;
    }
    const assigned = assignFilesToObjects(modelFiles, highObjects, selectedHigh.id, {});
    setLowFiles((current) => ({ ...current, ...assigned }));
    setBakeJob(undefined);
    setOneClickBakeAttempted(false);
    setBakeError(undefined);
    void persistImportedFiles('low', assigned);
  }

  function handleColorImport(files: File[]) {
    const imageFiles = files.filter(
      (file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|tga)$/i.test(file.name),
    );
    if (imageFiles.length === 0) {
      setBakeError('颜色贴图仅支持 PNG、JPG、WEBP 或 TGA 图片。');
      return;
    }
    if (!selectedHigh) {
      setBakeError('请先导入高模，再添加对应的颜色贴图。');
      return;
    }
    const assigned = assignFilesToObjects(imageFiles, highObjects, selectedHigh.id, {});
    setColorFiles((current) => ({ ...current, ...assigned }));
    setBakeJob(undefined);
    setOneClickBakeAttempted(false);
    setBakeError(undefined);
    void persistImportedFiles('color', assigned);
  }

  function handleMaterialChannelImport(kind: 'roughness' | 'metallic', files: File[]) {
    const imageFiles = files.filter(
      (file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|tga)$/i.test(file.name),
    );
    if (imageFiles.length === 0) {
      setBakeError('材质贴图仅支持 PNG、JPG、WEBP 或 TGA 图片。');
      return;
    }
    if (!selectedHigh) {
      setBakeError('请先导入高模，再添加对应的材质贴图。');
      return;
    }
    const assigned = assignFilesToObjects(imageFiles, highObjects, selectedHigh.id, {});
    if (kind === 'roughness') {
      setRoughnessFiles((current) => ({ ...current, ...assigned }));
    } else {
      setMetallicFiles((current) => ({ ...current, ...assigned }));
    }
    setBakeJob(undefined);
    setOneClickBakeAttempted(false);
    setBakeError(undefined);
    void persistImportedFiles(kind, assigned);
  }

  function handleMaterialImport(files: File[]) {
    const imageFiles = files.filter(
      (file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|tga)$/i.test(file.name),
    );
    if (imageFiles.length === 0) {
      setBakeError('材质贴图仅支持 PNG、JPG、WEBP 或 TGA 图片。');
      return;
    }
    const roughness = imageFiles.filter((file) => /(?:roughness|rough)(?:\W|_|$)/i.test(file.name));
    const metallic = imageFiles.filter((file) =>
      /(?:metallic|metalness|metal)(?:\W|_|$)/i.test(file.name),
    );
    const classified = new Set([...roughness, ...metallic]);
    const color = imageFiles.filter((file) => !classified.has(file)).slice(0, 1);
    if (color.length > 0) handleColorImport(color);
    if (roughness.length > 0) handleMaterialChannelImport('roughness', roughness);
    if (metallic.length > 0) handleMaterialChannelImport('metallic', metallic);
    setMaterialDialogOpen(true);
  }

  async function handleHighImport(files: File[]) {
    const modelFile = files.find((file) => /\.(fbx|obj|glb|gltf)$/i.test(file.name));
    if (!modelFile) {
      setBakeError('请选择 FBX、OBJ、GLB 或 GLTF 高模文件。');
      return;
    }

    setHighImporting(true);
    setBakeError(undefined);
    setAssetSaveState('saving');
    try {
      const resourceFiles = files.filter((file) => file !== modelFile);
      const loaded = await loadModelFromFile(
        modelFile,
        { normalize: false, ground: false, targetMaxDimension: 3 },
        resourceFiles,
      );
      const objectId = selectedHigh?.id ?? loaded.object.id;
      const saved = await saveBlobAsset({
        projectId,
        category: 'models',
        blob: modelFile,
        filename: `bake-${objectId}-high-${modelFile.name}`,
      });

      loaded.root.name = modelFile.name;
      loaded.root.userData.liclickObjectId = objectId;
      loaded.root.traverse((child) => {
        child.userData.liclickObjectId = objectId;
      });

      const importedResult = {
        ...loaded.result,
        objectId,
        name: modelFile.name,
        sourceFileName: modelFile.name,
        objectUrl: saved.asset.url,
        group: loaded.root,
      };
      const importedObject: SceneObject = {
        ...loaded.object,
        id: objectId,
        name: modelFile.name,
        sourcePath: saved.asset.url,
        selected: true,
        visible: true,
      };

      setImportedModel(importedResult, importedObject);
      setSelectedObjectId(objectId);
      setBakeJob(undefined);
      setOneClickBakeAttempted(false);

      await persistProjectUpdate((current) => {
        const hasExistingObject = current.objects.some((object) => object.id === objectId);
        const objects = hasExistingObject
          ? current.objects.map((object) =>
              object.id === objectId ? importedObject : { ...object, selected: false },
            )
          : [...current.objects.map((object) => ({ ...object, selected: false })), importedObject];
        const assetManifest = {
          ...(current.assetManifest ?? {
            models: [],
            references: [],
            generations: [],
            layers: [],
            baked: [],
          }),
          models: Array.from(
            new Set([
              ...(current.assetManifest?.models ?? []),
              saved.asset.relativePath ?? saved.asset.url,
            ]),
          ),
        };
        return {
          ...current,
          objects,
          activeObjectId: objectId,
          assetManifest,
          bakeWorkspace: {
            version: 1,
            activeStage: 'assets',
            selectedObjectId: objectId,
            bakeSets: current.bakeWorkspace?.bakeSets ?? {},
          },
        };
      });
      setAssetSaveState('saved');
    } catch (reason) {
      setAssetSaveState('error');
      setBakeError(
        reason instanceof Error ? `高模导入失败：${reason.message}` : '高模导入失败，请重试。',
      );
    } finally {
      setHighImporting(false);
      if (highInputRef.current) highInputRef.current.value = '';
    }
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
    if (
      (channel === 'roughness' && !enabledChannels.has(channel) && !selectedRoughness) ||
      (channel === 'metallic' && !enabledChannels.has(channel) && !selectedMetallic)
    ) {
      setMaterialDialogOpen(true);
    }
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
    return new File([blob], `${fileStem(selectedHigh?.name ?? 'high')}_BaseColor.png`, {
      type: blob.type || 'image/png',
    });
  }

  function createRoughnessFile() {
    if (!selectedRoughness) throw new Error('Roughness 对烘需要高模粗糙度贴图。');
    return selectedRoughness;
  }

  function createMetallicFile() {
    if (!selectedMetallic) throw new Error('Metallic 对烘需要高模金属度贴图。');
    return selectedMetallic;
  }

  async function handleCreateBakeJob() {
    if (!project || !selectedHigh || !selectedLow) return;
    setBakeSubmitting(true);
    setBakeError(undefined);
    try {
      const high = await createHighFile();
      const color = requiresColor ? await createColorFile() : undefined;
      const roughness = requiresRoughness ? createRoughnessFile() : undefined;
      const metallic = requiresMetallic ? createMetallicFile() : undefined;
      const job = await submitNormalBake({
        projectId: project.id,
        objectId: selectedHigh.id,
        high,
        low: selectedLow,
        cage: undefined,
        color,
        roughness,
        metallic,
        settings: {
          resolution: resolution as 1024 | 2048 | 4096 | 8192,
          padding: 16,
          sampling: '2x2',
          normalOrientation,
          device: 'gpu',
          udim: 1001,
          frontalDistance: 0.1,
          rearDistance: 0.1,
          matchMode: 'always',
          projectionMode: 'distance',
          hitStrategy: 'inward',
          ignoreBackfaces: false,
          channels: resultChannelOrder.filter((channel) => enabledChannels.has(channel)),
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
    onBack();
  }

  const primaryLabel: Record<BakeStage, string> = {
    assets: '进入模型匹配',
    alignment: '继续：烘焙设置',
    bake: '创建烘焙任务',
    check: '进入 PBR 处理',
    pbr: '完成并返回首页',
  };
  const primaryActionLabel =
    activeStage === 'alignment' && preflightRan && !preflightPassed
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
  const selectedResultLabel =
    selectedResultChannel === 'normal' && bakeJob
      ? `Normal · ${bakeJob.settings.normalOrientation === 'directx' ? 'DX' : 'OP'}`
      : channelLabels[selectedResultChannel];
  const selectedResultFilename = `${fileStem(selectedHigh?.name ?? 'bake')}_${channelFileSuffix[selectedResultChannel]}`;
  const availableResultChannels =
    bakeJob?.status === 'succeeded'
      ? resultChannelOrder.filter((channel) => Boolean(getBakeOutput(bakeJob, channel)))
      : [];

  const stageState = (stage: BakeStage) => {
    if (stage === activeStage) return 'active';
    if (stage === 'assets' && allRequiredAssetsReady) return 'done';
    if (stage === 'alignment' && alignmentReady) return 'done';
    return 'pending';
  };

  const selectedSetProgress = selectedHigh
    ? Number(Boolean(selectedHigh)) +
      Number(Boolean(selectedLow)) +
      Number(Boolean(requiresColor && selectedColorName)) +
      Number(Boolean(requiresRoughness && selectedRoughness)) +
      Number(Boolean(requiresMetallic && selectedMetallic))
    : 0;
  const selectedSetRequirementCount =
    2 + Number(requiresColor) + Number(requiresRoughness) + Number(requiresMetallic);
  const selectedObjectIndex = Math.max(
    0,
    highObjects.findIndex((object) => object.id === selectedHigh?.id),
  );

  function selectAdjacentObject(offset: number) {
    if (highObjects.length === 0) return;
    const nextIndex = (selectedObjectIndex + offset + highObjects.length) % highObjects.length;
    selectObject(highObjects[nextIndex].id);
  }

  const oneClickRequiredAssetCount =
    2 + Number(requiresColor) + Number(requiresRoughness) + Number(requiresMetallic);
  const oneClickAssetCount =
    Number(Boolean(selectedHigh)) +
    Number(Boolean(selectedLow)) +
    Number(Boolean(requiresColor && selectedColorName)) +
    Number(Boolean(requiresRoughness && selectedRoughness)) +
    Number(Boolean(requiresMetallic && selectedMetallic));
  const oneClickAssetsReady = oneClickAssetCount === oneClickRequiredAssetCount;
  const oneClickReady = oneClickAssetsReady && alignmentReady && channelReady;
  const bakerMissing = bakerStatus?.available === false;
  const bakeBusy = bakeSubmitting || bakeJob?.status === 'queued' || bakeJob?.status === 'running';
  const oneClickActionLabel = bakerStatusChecking
    ? '正在检测烘焙组件'
    : bakerMissing
      ? '需要安装烘焙组件'
      : bakeBusy
        ? `正在烘焙 ${bakeJob?.progress ?? 0}%`
        : bakeJob?.status === 'succeeded'
          ? '重新一键烘焙'
          : oneClickAssetsReady && !alignmentReady
            ? '高低模未对齐'
            : oneClickReady
              ? '开始一键烘焙'
              : `继续准备 ${oneClickAssetCount}/${oneClickRequiredAssetCount}`;

  function handleOneClickBake() {
    setOneClickBakeAttempted(true);
    setBakeError(undefined);
    if (bakerMissing) {
      setBakeError('请先安装 Adobe Substance 3D Designer，再重新检测烘焙组件。');
      return;
    }
    if (!selectedHigh) {
      setBakeError('请先在贴图工作区导入高模。');
      return;
    }
    if (!selectedLow) {
      chooseFiles('low');
      return;
    }
    if (requiresColor && !selectedColorName) {
      setMaterialDialogOpen(true);
      return;
    }
    if (requiresRoughness && !selectedRoughness) {
      setMaterialDialogOpen(true);
      return;
    }
    if (requiresMetallic && !selectedMetallic) {
      setMaterialDialogOpen(true);
      return;
    }
    if (enabledChannels.size === 0) {
      setBakeError('请至少选择一张输出贴图。');
      return;
    }
    if (selectedLowInfo && !hasUv0) {
      setBakeError('低模缺少 UV0，请展开 UV 后重新导入。');
      return;
    }
    if (!selectedLowInfo) {
      setBakeError('正在检查低模 UV 和模型匹配，请稍后再试。');
      return;
    }
    if (alignmentMismatch || !alignmentReady) {
      const sizeMessage = sizeDelta === undefined ? '' : `尺寸差 ${percent(sizeDelta)}`;
      const centerMessage = positionDelta === undefined ? '' : `中心偏移 ${percent(positionDelta)}`;
      const shapeMessage = shapeDelta === undefined ? '' : `轮廓比例差 ${percent(shapeDelta)}`;
      setBakeError(
        `高低模不匹配${[sizeMessage, centerMessage, shapeMessage].filter(Boolean).length ? `：${[sizeMessage, centerMessage, shapeMessage].filter(Boolean).join('，')}` : ''}。当前文件可能不是同一个模型，请替换低模；若模型相同，请在 DCC 中应用缩放、位置和旋转后重新导出。`,
      );
      return;
    }
    void handleCreateBakeJob();
  }

  // Keep the former professional workspace available in source while this
  // simpler product direction is being validated. Every real project uses the
  // one-click layout below.
  if (projectId)
    return (
      <WorkflowShell
        projectName={project?.name ?? (isLoading ? '正在载入项目…' : '未找到项目')}
        eyebrow="MODULE 2 · ONE-CLICK BAKE"
        onBack={onBack}
        backLabel="返回功能首页"
        connected={!error}
        navigation={{
          activeModule: 'bake',
          onOpenTexture,
          onOpenBake: () => undefined,
        }}
      >
        <input
          ref={highInputRef}
          className="hidden"
          type="file"
          multiple
          accept=".fbx,.obj,.glb,.gltf,.bin,.mtl,image/*"
          onChange={(event) => void handleHighImport(Array.from(event.target.files ?? []))}
        />
        <input
          ref={lowInputRef}
          className="hidden"
          type="file"
          multiple
          accept=".fbx,.obj,.glb,.gltf"
          onChange={(event) => {
            handleLowImport(Array.from(event.target.files ?? []));
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
            handleColorImport(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <input
          ref={roughnessInputRef}
          className="hidden"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,.tga"
          onChange={(event) => {
            handleMaterialChannelImport('roughness', Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <input
          ref={metallicInputRef}
          className="hidden"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,.tga"
          onChange={(event) => {
            handleMaterialChannelImport('metallic', Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />

        {materialDialogOpen ? (
          <div
            className="fixed inset-0 z-[105] grid place-items-center bg-black/82 p-5 backdrop-blur-md"
            role="dialog"
            aria-modal="true"
            aria-label="材质贴图输入"
            onClick={() => setMaterialDialogOpen(false)}
          >
            <div
              className="w-full max-w-2xl overflow-hidden rounded-[28px] border border-white/12 bg-[#0d0f1e] shadow-[0_32px_100px_rgba(0,0,0,.62)]"
              onClick={(event) => event.stopPropagation()}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={(event) => {
                event.preventDefault();
                handleMaterialImport(Array.from(event.dataTransfer.files));
              }}
            >
              <div className="flex items-start justify-between border-b border-white/[0.08] px-6 py-5">
                <div>
                  <p className="text-lg font-semibold text-white">材质贴图</p>
                  <p className="mt-1 text-xs leading-5 text-white/42">
                    三张贴图共用高模 UV，通过 Texture Transfer 对烘到低模 UV。
                  </p>
                </div>
                <button
                  type="button"
                  className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-white/[0.035] text-white/48 transition-colors hover:bg-white/[0.08] hover:text-white"
                  aria-label="关闭材质贴图窗口"
                  onClick={() => setMaterialDialogOpen(false)}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid gap-3 p-5 sm:p-6">
                <MaterialMapSlot
                  label="Base Color"
                  description="颜色 / Albedo"
                  fileName={selectedColorName}
                  required={requiresColor}
                  onClick={() => chooseFiles('color')}
                />
                <MaterialMapSlot
                  label="Roughness"
                  description="黑色光滑，白色粗糙"
                  fileName={selectedRoughness?.name}
                  required={requiresRoughness}
                  onClick={() => chooseFiles('roughness')}
                />
                <MaterialMapSlot
                  label="Metallic"
                  description="黑色非金属，白色金属"
                  fileName={selectedMetallic?.name}
                  required={requiresMetallic}
                  onClick={() => chooseFiles('metallic')}
                />
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-3 text-center text-[11px] text-white/30">
                  也可以一次拖入多张贴图；文件名包含 Roughness / Metallic 时会自动归类。
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {resultLightboxOpen && selectedResultUrl ? (
          <div
            className="fixed inset-0 z-[100] grid place-items-center bg-black/88 p-8 backdrop-blur-md"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedResultLabel} 全尺寸预览`}
            onClick={() => setResultLightboxOpen(false)}
          >
            <div
              className="max-h-full max-w-full overflow-hidden rounded-2xl border border-white/15 bg-[#0b0d19] shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <img
                src={selectedResultUrl}
                alt={`${selectedResultLabel} 烘焙贴图`}
                className="max-h-[86vh] max-w-[86vw] object-contain"
              />
            </div>
          </div>
        ) : null}

        <div className="workflow-scrollbar relative min-h-0 flex-1 overflow-y-auto bg-[#080914] pt-[82px] text-white">
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute -left-40 top-8 h-[520px] w-[520px] rounded-full bg-[#6d32c8]/14 blur-[130px]" />
            <div className="absolute -right-40 top-32 h-[440px] w-[440px] rounded-full bg-[#1d8b9d]/10 blur-[130px]" />
            <div className="absolute inset-0 opacity-[0.035] [background-image:linear-gradient(rgba(255,255,255,.22)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.22)_1px,transparent_1px)] [background-size:48px_48px]" />
          </div>

          <main className="relative mx-auto flex min-h-full w-full max-w-[1180px] flex-col justify-center px-6 py-10 lg:px-10 lg:py-14">
            <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl">
                <div className="inline-flex items-center gap-2 rounded-full border border-violet-300/20 bg-violet-300/[0.07] px-3 py-1.5 text-[11px] font-semibold tracking-[0.14em] text-violet-100/80">
                  <Sparkles className="h-3.5 w-3.5" /> ONE-CLICK BAKE
                </div>
                <h1 className="mt-5 text-4xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">
                  一键模型烘焙
                </h1>
                <p className="mt-4 text-[15px] leading-7 text-white/48">
                  准备高模、带 UV 的低模和材质贴图，选择输出尺寸，剩下的交给 Li3D。
                </p>
              </div>
              <div className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.035] px-4 py-3 backdrop-blur-xl">
                <span className="relative flex h-2.5 w-2.5">
                  {!bakerMissing ? (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-45" />
                  ) : null}
                  <span
                    className={cn(
                      'relative inline-flex h-2.5 w-2.5 rounded-full',
                      bakerStatusChecking
                        ? 'bg-white/32'
                        : bakerMissing
                          ? 'bg-amber-300'
                          : 'bg-emerald-300',
                    )}
                  />
                </span>
                <div>
                  <p className="text-xs font-medium text-white/76">Substance 烘焙引擎</p>
                  <p className="mt-0.5 text-[10px] text-white/32">
                    {bakerStatusChecking
                      ? '正在检测本地组件'
                      : bakerMissing
                        ? '未检测到烘焙组件'
                        : '支持 9 张标准烘焙与材质贴图'}
                  </p>
                </div>
              </div>
            </header>

            {bakerMissing ? (
              <div
                className="mt-6 flex flex-col gap-4 rounded-2xl border border-amber-300/18 bg-amber-300/[0.055] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                role="alert"
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-200/78" />
                  <div>
                    <p className="text-sm font-semibold text-amber-50/88">需要安装烘焙组件</p>
                    <p className="mt-1 text-xs leading-5 text-amber-100/52">
                      未检测到 Adobe Substance 3D Designer。安装完成后即可使用一键烘焙，无需打开 Designer。
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl border border-amber-200/20 bg-amber-100/[0.07] px-4 text-xs font-semibold text-amber-50/72 transition-colors hover:bg-amber-100/[0.12] hover:text-amber-50 disabled:cursor-wait disabled:opacity-50"
                  disabled={bakerStatusChecking}
                  onClick={() => void refreshBakerStatus()}
                >
                  <RotateCcw className={cn('h-3.5 w-3.5', bakerStatusChecking && 'animate-spin')} />
                  重新检测
                </button>
              </div>
            ) : null}

            <section className="mt-8 overflow-hidden rounded-[28px] border border-white/[0.09] bg-[#0d0f1e]/82 shadow-[0_30px_100px_rgba(0,0,0,.38)] backdrop-blur-2xl">
              <div className="flex h-11 items-center justify-between border-b border-white/[0.06] px-5 sm:px-6">
                <div className="flex min-w-0 items-center gap-3">
                  <h2 className="shrink-0 text-xs font-medium text-white/48">烘焙素材</h2>
                  <span className="hidden truncate text-[10px] text-white/20 sm:inline">
                    高模 · 低模 · 材质贴图
                  </span>
                </div>
                <span className="text-[10px] tabular-nums text-white/26">
                  {oneClickReady
                    ? '已就绪'
                    : oneClickAssetsReady && alignmentMismatch
                      ? '模型待检查'
                      : `${oneClickAssetCount}/${oneClickRequiredAssetCount}`}
                </span>
              </div>

              <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-3">
                <OneClickAssetCard
                  step="01"
                  title="高模"
                  english="HIGH POLY"
                  description="当前项目中的高精度模型"
                  value={selectedHigh?.name ?? '尚未导入高模'}
                  ready={Boolean(selectedHigh)}
                  icon={Box}
                  tone="violet"
                  preview={project?.thumbnail}
                  actionLabel={highImporting ? '正在导入…' : selectedHigh ? '替换高模' : '选择高模'}
                  onClick={() => chooseFiles('high')}
                  onFilesDropped={(files) => void handleHighImport(files)}
                  dropHint="高模文件"
                />
                <OneClickAssetCard
                  step="02"
                  title="低模"
                  english="LOW POLY"
                  description={
                    selectedLow
                      ? selectedLowInfo
                        ? !hasUv0
                          ? '缺少 UV0，请重新导出'
                          : alignmentMismatch
                            ? '不是同一模型，或变换未对齐'
                            : 'UV0 与模型匹配已通过'
                        : '正在检查 UV…'
                      : '需要包含 UV0 的模型'
                  }
                  value={selectedLow?.name ?? '点击导入低模'}
                  ready={Boolean(selectedLow && selectedLowInfo && hasUv0 && !alignmentMismatch)}
                  warning={Boolean(selectedLowInfo && (!hasUv0 || alignmentMismatch))}
                  icon={Layers3}
                  tone="cyan"
                  actionLabel={selectedLow ? '替换低模' : '选择模型'}
                  onClick={() => chooseFiles('low')}
                  onFilesDropped={handleLowImport}
                  dropHint="低模文件"
                />
                <OneClickAssetCard
                  step="03"
                  title="材质贴图"
                  english="MATERIAL MAPS"
                  description={'颜色、粗糙度和金属度共用一个入口，分别对烘到低模 UV'}
                  value={
                    materialMapCount > 0
                      ? `${materialMapCount}/3 已导入 · ${[
                          selectedColorName ? '颜色' : undefined,
                          selectedRoughness ? '粗糙度' : undefined,
                          selectedMetallic ? '金属度' : undefined,
                        ]
                          .filter(Boolean)
                          .join(' · ')}`
                      : '点击管理材质贴图'
                  }
                  ready={
                    (!requiresColor || Boolean(selectedColorName)) &&
                    (!requiresRoughness || Boolean(selectedRoughness)) &&
                    (!requiresMetallic || Boolean(selectedMetallic))
                  }
                  icon={Sparkles}
                  tone="rose"
                  preview={selectedProjectColor?.imageUrl}
                  actionLabel={materialMapCount > 0 ? '管理贴图' : '导入贴图'}
                  onClick={() => setMaterialDialogOpen(true)}
                  onFilesDropped={handleMaterialImport}
                  dropHint="Base Color / Roughness / Metallic"
                />
              </div>

              <div className="border-t border-white/[0.07] bg-black/14 p-4 sm:p-6">
                <div className="mb-3 flex flex-wrap items-center gap-1.5 px-1">
                  <span className="mr-1 text-[11px] font-medium text-white/30">
                    输出 {enabledChannels.size}/{resultChannelOrder.length}
                  </span>
                  {resultChannelOrder.map((channel) => {
                    const selected = enabledChannels.has(channel);
                    return (
                      <button
                        key={channel}
                        type="button"
                        className={cn(
                          'inline-flex h-7 items-center justify-center gap-1 rounded-lg border px-2 text-[10px] font-medium transition-all',
                          selected
                            ? 'border-white/12 bg-white/[0.055] text-white/58'
                            : 'border-white/[0.05] bg-transparent text-white/20 hover:border-white/12 hover:text-white/48',
                        )}
                        aria-pressed={selected}
                        onClick={() => toggleChannel(channel)}
                      >
                        {selected ? <Check className="h-3 w-3" /> : null}
                        {channelShortLabels[channel]}
                      </button>
                    );
                  })}
                  {enabledChannels.has('normal') ? (
                    <div className="ml-auto flex h-8 items-center rounded-lg border border-white/[0.07] bg-black/20 p-0.5">
                      <span className="px-2 text-[10px] font-medium text-white/34">法线</span>
                      {(
                        [
                          { value: 'directx', label: 'DX', title: 'DirectX 法线（Y-）' },
                          { value: 'opengl', label: 'OP', title: 'OpenGL 法线（Y+）' },
                        ] as const
                      ).map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          title={option.title}
                          aria-pressed={normalOrientation === option.value}
                          className={cn(
                            'inline-flex h-6 min-w-9 items-center justify-center rounded-md px-2 text-[10px] font-semibold transition-all duration-150 active:scale-95',
                            normalOrientation === option.value
                              ? 'bg-white/[0.09] text-white/76'
                              : 'bg-transparent text-white/28 hover:bg-white/[0.04] hover:text-white/52',
                          )}
                          onClick={() => {
                            setNormalOrientation(option.value);
                            setBakeError(undefined);
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4 sm:flex sm:items-center sm:justify-between sm:gap-5">
                    <div className="mb-4 sm:mb-0">
                      <p className="text-sm font-semibold text-white/82">输出贴图大小</p>
                      <p className="mt-1 text-xs text-white/34">
                        默认输出颜色与法线，其他贴图可按需增加
                      </p>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {([1024, 2048, 4096, 8192] as const).map((size) => (
                        <button
                          key={size}
                          type="button"
                          className={cn(
                            'h-12 min-w-[58px] rounded-xl border text-sm font-semibold transition-all duration-200',
                            resolution === size
                              ? 'border-violet-300/50 bg-gradient-to-b from-violet-400/24 to-fuchsia-400/12 text-white shadow-[0_0_24px_rgba(168,85,247,.16)]'
                              : 'border-white/[0.08] bg-black/18 text-white/40 hover:border-white/18 hover:bg-white/[0.045] hover:text-white/70',
                          )}
                          onClick={() => setResolution(size)}
                        >
                          {size / 1024}K
                        </button>
                      ))}
                    </div>
                  </div>

                  <Button
                    variant="primary"
                    className="h-full min-h-[84px] rounded-2xl bg-gradient-to-r from-[#e84fb8] via-[#bc55e5] to-[#765cf6] px-6 text-base font-semibold shadow-[0_18px_44px_rgba(170,70,220,.24)] transition-transform hover:-translate-y-0.5 disabled:translate-y-0"
                    disabled={bakeBusy || bakerStatusChecking || bakerMissing}
                    onClick={handleOneClickBake}
                    icon={
                      bakeBusy ? (
                        <Clock3 className="h-5 w-5 animate-pulse" />
                      ) : (
                        <Flame className="h-5 w-5" />
                      )
                    }
                  >
                    {oneClickActionLabel}
                  </Button>
                </div>

                {bakeBusy ? (
                  <div className="mt-4 rounded-2xl border border-violet-300/12 bg-violet-300/[0.035] px-4 py-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-violet-100/68">正在自动匹配模型并生成贴图…</span>
                      <span className="font-semibold tabular-nums text-white/78">
                        {bakeJob?.progress ?? 0}%
                      </span>
                    </div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-fuchsia-400 to-violet-400 transition-[width] duration-500"
                        style={{ width: `${Math.max(4, bakeJob?.progress ?? 0)}%` }}
                      />
                    </div>
                  </div>
                ) : null}

                {oneClickBakeAttempted && (bakeError || bakeJob?.error) ? (
                  <div
                    className="mt-4 flex items-start gap-3 rounded-2xl border border-rose-300/18 bg-rose-400/[0.055] px-4 py-3 text-sm text-rose-100/82"
                    role="alert"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                    <span>{bakeError ?? bakeJob?.error}</span>
                  </div>
                ) : null}
              </div>
            </section>

            {bakeJob?.status === 'succeeded' ? (
              <section className="mt-6 rounded-[24px] border border-emerald-300/12 bg-emerald-300/[0.025] p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2 className="flex items-center gap-2 text-base font-semibold text-white/88">
                      <Check className="h-4 w-4 text-emerald-300" />
                      烘焙完成
                    </h2>
                    <p className="mt-1 text-xs text-white/36">
                      点击贴图可放大预览，或直接下载 PNG。
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full border border-emerald-300/18 bg-emerald-300/[0.07] px-3 py-1.5 text-xs text-emerald-100/70">
                      {resolution / 1024}K · {availableResultChannels.length} 张
                    </span>
                    <button
                      type="button"
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-emerald-200/24 bg-emerald-300/[0.1] px-4 text-xs font-semibold text-emerald-50/88 transition-all hover:-translate-y-0.5 hover:border-emerald-200/42 hover:bg-emerald-300/[0.16] disabled:cursor-wait disabled:opacity-45 disabled:hover:translate-y-0"
                      disabled={downloadingAllResults || availableResultChannels.length === 0}
                      onClick={async () => {
                        setDownloadingAllResults(true);
                        setBakeError(undefined);
                        try {
                          await downloadAllBakeOutputs(
                            bakeJob,
                            fileStem(selectedHigh?.name ?? 'bake'),
                          );
                        } catch (reason) {
                          setBakeError(
                            reason instanceof Error ? reason.message : '全部贴图导出失败',
                          );
                        } finally {
                          setDownloadingAllResults(false);
                        }
                      }}
                    >
                      <Download className="h-3.5 w-3.5" />
                      {downloadingAllResults ? '正在打包…' : '全部导出贴图'}
                    </button>
                  </div>
                </div>
                <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {resultChannelOrder
                    .filter((channel) => bakeJob.settings.channels.includes(channel))
                    .map((channel) => {
                      const output = getBakeOutput(bakeJob, channel);
                      const outputUrl = output ? bakeOutputUrl(bakeJob, channel) : undefined;
                      const outputLabel =
                        channel === 'normal'
                          ? `Normal · ${bakeJob.settings.normalOrientation === 'directx' ? 'DX' : 'OP'}`
                          : channelLabels[channel];
                      const filename = `${fileStem(selectedHigh?.name ?? 'bake')}_${channelFileSuffix[channel]}`;
                      return (
                        <div
                          key={channel}
                          className="flex items-center gap-4 rounded-2xl border border-white/[0.07] bg-black/18 p-3"
                        >
                          <button
                            type="button"
                            className="h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-black/30 disabled:cursor-default"
                            disabled={!outputUrl}
                            onClick={() => {
                              setSelectedResultChannel(channel);
                              setResultLightboxOpen(true);
                            }}
                          >
                            {outputUrl ? (
                              <img
                                src={outputUrl}
                                alt={outputLabel}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <Box className="m-auto h-6 w-6 text-white/20" />
                            )}
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-white/82">{outputLabel}</p>
                            <p className="mt-1 truncate text-xs text-white/32">
                              {output ? `${output.width} × ${output.height} · PNG` : '正在准备输出'}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.035] text-white/52 transition-colors hover:border-violet-300/28 hover:bg-violet-300/[0.08] hover:text-white disabled:opacity-30"
                            aria-label={`下载 ${outputLabel}`}
                            disabled={!output || downloadingResult || downloadingAllResults}
                            onClick={async () => {
                              setDownloadingResult(true);
                              setBakeError(undefined);
                              try {
                                await downloadBakeOutput(bakeJob, channel, filename);
                              } catch (reason) {
                                setBakeError(
                                  reason instanceof Error ? reason.message : '下载贴图失败',
                                );
                              } finally {
                                setDownloadingResult(false);
                              }
                            }}
                          >
                            <Download className="h-4 w-4" />
                          </button>
                        </div>
                      );
                    })}
                </div>
              </section>
            ) : null}

            {enabledChannels.has('normal') ? (
              <p className="mt-3 text-center text-[9px] text-white/18">
                法线：{normalOrientation === 'directx' ? 'DX（Y-）' : 'OP（Y+）'}
              </p>
            ) : null}

          </main>
        </div>
      </WorkflowShell>
    );

  return (
    <WorkflowShell
      projectName={project?.name ?? (isLoading ? '正在载入项目…' : '未找到项目')}
      eyebrow="MODULE 2 · PROFESSIONAL BAKE"
      onBack={onBack}
      connected={!error}
      navigation={{
        activeModule: 'bake',
        onOpenTexture,
        onOpenBake: () => undefined,
      }}
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
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-black/86 p-8 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={`${selectedResultLabel} 全尺寸预览`}
          onClick={() => setResultLightboxOpen(false)}
        >
          <div
            className="max-h-full max-w-full overflow-hidden rounded-lg border border-white/15 bg-[#0b0d19] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={selectedResultUrl}
              alt={`${selectedResultLabel} 全尺寸贴图`}
              className="max-h-[86vh] max-w-[86vw] object-contain"
            />
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

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_64px] gap-2.5 bg-[#090b16] px-3 pb-3 pt-[82px] text-[13px]">
        <div className="grid min-h-0 gap-2.5 xl:grid-cols-[286px_minmax(0,1fr)_368px]">
          <aside className="flex min-h-0 flex-col">
            <ConceptPanel className="flex min-h-0 flex-1 flex-col">
              <ConceptHeader
                title="资产"
                description={`当前 Bake Set · ${selectedObjectIndex + 1}/${Math.max(highObjects.length, 1)}`}
                help
                actions={
                  highObjects.length > 1 ? (
                    <div className="flex gap-1">
                      <ConceptIconButton label="上一组" onClick={() => selectAdjacentObject(-1)}>
                        <ChevronLeft className="h-4 w-4" />
                      </ConceptIconButton>
                      <ConceptIconButton label="下一组" onClick={() => selectAdjacentObject(1)}>
                        <ChevronRight className="h-4 w-4" />
                      </ConceptIconButton>
                    </div>
                  ) : undefined
                }
              />
              <div className="space-y-2 p-3">
                <ConceptAssetRow
                  label="高模 (High)"
                  value={selectedHigh?.name ?? '未找到高模'}
                  ready={Boolean(selectedHigh)}
                  thumbnail={project?.thumbnail}
                />
                <ConceptAssetRow
                  label="低模 (Low)"
                  value={selectedLow?.name ?? '选择带 UV0 的低模'}
                  ready={Boolean(selectedLow)}
                  warning={Boolean(selectedLow && !hasUv0)}
                  onClick={() => chooseFiles('low')}
                  wire
                />
                <ConceptAssetRow
                  label="高模颜色 (High Color) · 可选"
                  value={selectedColorName ?? '仅烘焙 Base Color 时需要'}
                  ready={Boolean(selectedColorName)}
                  thumbnail={project?.thumbnail}
                  onClick={() => chooseFiles('color')}
                />
              </div>
              <div className="mt-auto border-t border-white/[0.07] px-3.5 py-3 text-[10px] leading-4 text-white/26">
                点击资产卡片即可替换文件；多个模型会自动组成独立 Bake Set。
              </div>
            </ConceptPanel>
          </aside>

          <section className="relative min-h-[520px] min-w-0 overflow-hidden rounded-lg border border-white/10 bg-[#0d0f1c] xl:min-h-0">
            {preflightRan && !preflightPassed ? (
              <div
                className="absolute inset-x-4 top-4 z-30 flex min-h-16 items-center justify-between gap-4 rounded-lg border border-amber-300/25 bg-[#201a18]/94 px-4 py-3 shadow-2xl backdrop-blur-md"
                role="alert"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-amber-50">
                      预检未通过：{preflightIssues[0]?.title ?? '模型匹配需要检查'}
                    </p>
                    <p className="mt-1 truncate text-xs text-amber-100/58">
                      {preflightIssues[0]?.detail}
                    </p>
                    {preflightIssues.length > 1 ? (
                      <p className="mt-1 text-[11px] text-amber-200/42">
                        另有 {preflightIssues.length - 1} 项问题，请查看右侧完整列表。
                      </p>
                    ) : null}
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
                  {preflightIssues[0]?.action === 'low'
                    ? '重新选择低模'
                    : preflightIssues[0]?.action === 'cage'
                      ? '选择 Cage'
                      : preflightIssues[0]?.action === 'color'
                        ? '选择颜色贴图'
                        : '重新检测'}
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
                <ViewportModeButton
                  label="高模"
                  active={viewportMode === 'high'}
                  onClick={() => setViewportMode('high')}
                  icon={<Sparkles className="h-3.5 w-3.5" />}
                />
                <ViewportModeButton
                  label="叠加"
                  active={viewportMode === 'overlay'}
                  onClick={() => setViewportMode('overlay')}
                  icon={<Layers3 className="h-3.5 w-3.5" />}
                />
                <ViewportModeButton
                  label="Cage"
                  active={viewportMode === 'cage'}
                  onClick={() => setViewportMode('cage')}
                  icon={<ScanLine className="h-3.5 w-3.5" />}
                />
              </div>
              <button
                type="button"
                className="flex h-10 items-center gap-2 rounded-lg border border-white/12 bg-[#0c0d18]/92 px-3 text-sm text-white/64 shadow-xl hover:text-white"
                onClick={() => setViewportResetKey((value) => value + 1)}
              >
                <RotateCcw className="h-4 w-4" />
                重置视图
              </button>
            </div>

            {viewportProject && selectedHigh ? (
              <ModuleOneReadonlyViewport
                key={`${selectedHigh.id}:${viewportResetKey}`}
                project={viewportProject}
                object={selectedHigh}
                sceneOverlay={
                  <BakeSceneOverlay
                    highObject={selectedHigh}
                    lowFile={selectedLow}
                    cageFile={selectedCage}
                    mode={viewportMode}
                    cageInflation={cageInflation}
                  />
                }
              />
            ) : (
              <div className="grid h-full place-items-center text-xs text-white/36">
                等待模块 1 模型视图…
              </div>
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
                <div className="space-y-4">
                  <div className="rounded-xl border border-white/[0.08] bg-[#0c0e1a]/64 p-4">
                    <div className="flex items-end justify-between gap-4">
                      <div>
                        <p className="text-[11px] text-white/32">资产准备</p>
                        <p className="mt-1 text-sm font-medium text-white/76">
                          {selectedSetProgress === selectedSetRequirementCount
                            ? 'Bake Set 已就绪'
                            : '补齐必要资产后继续'}
                        </p>
                      </div>
                      <strong className="text-2xl font-semibold tabular-nums text-white/76">
                        {selectedSetProgress}
                        <span className="text-sm text-white/26">
                          /{selectedSetRequirementCount}
                        </span>
                      </strong>
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-2">
                      {[
                        { label: '高模', ready: Boolean(selectedHigh) },
                        { label: '低模', ready: Boolean(selectedLow) },
                        { label: '颜色', ready: Boolean(selectedColorName) || !requiresColor },
                      ].map((item) => (
                        <div
                          key={item.label}
                          className={cn(
                            'rounded-lg border px-2.5 py-2 text-center text-[11px]',
                            item.ready
                              ? 'border-emerald-300/14 bg-emerald-300/[0.045] text-emerald-100/66'
                              : 'border-white/[0.07] bg-black/16 text-white/30',
                          )}
                        >
                          {item.ready ? (
                            <Check className="mx-auto mb-1 h-3.5 w-3.5" />
                          ) : (
                            <Circle className="mx-auto mb-1 h-3.5 w-3.5" />
                          )}
                          {item.label}
                        </div>
                      ))}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="compact-button w-full justify-center"
                    onClick={() => chooseFiles('low')}
                  >
                    <FileUp className="h-3.5 w-3.5" />
                    {selectedLow ? '替换低模' : '选择带 UV0 的低模'}
                  </button>
                  {requiresColor ? (
                    <button
                      type="button"
                      className="compact-button w-full justify-center"
                      onClick={() => chooseFiles('color')}
                    >
                      <FileUp className="h-3.5 w-3.5" />
                      {selectedColorName ? '替换颜色贴图' : '选择颜色贴图'}
                    </button>
                  ) : null}
                  <p className="text-[11px] leading-5 text-white/28">
                    文件名相近的高低模会自动配对，无需重复设置。
                  </p>
                </div>
              ) : null}

              {activeStage === 'alignment' ? (
                <div className="space-y-4">
                  <Field label="烘焙器">
                    <div className="flex h-9 items-center rounded-lg border border-white/10 bg-white/[0.035] px-3 text-xs font-medium text-white/72">
                      Adobe Substance 3D Designer
                    </div>
                  </Field>
                  <Field label="质量">
                    <Segmented
                      value={qualityPreset}
                      options={[
                        { value: 'preview', label: '快速' },
                        { value: 'production', label: '正式' },
                      ]}
                      onChange={selectPreset}
                    />
                  </Field>
                  <Field label="分辨率">
                    <Select
                      value={String(resolution)}
                      options={['1024', '2048', '4096', '8192']}
                      onChange={(value) => setResolution(Number(value))}
                    />
                  </Field>
                  <InspectorSection
                    title="Cage 包围"
                    caption={projectionMode === 'cage' ? '外部模型' : '实时可编辑'}
                  >
                    <div className="space-y-3 py-3">
                      <Segmented
                        value={projectionMode}
                        options={[
                          { value: 'distance', label: '自动包围' },
                          { value: 'cage', label: '外部 Cage' },
                        ]}
                        onChange={(value) => {
                          setProjectionMode(value);
                          setViewportMode('cage');
                        }}
                      />
                      {projectionMode === 'distance' ? (
                        <>
                          <Field label="包围膨胀" hint={`${(cageInflation * 100).toFixed(1)}%`}>
                            <input
                              aria-label="Cage 包围膨胀"
                              className="bake-range w-full"
                              type="range"
                              min="0"
                              max="0.2"
                              step="0.005"
                              value={cageInflation}
                              onChange={(event) => {
                                updateAutoCageInflation(Number(event.target.value));
                              }}
                            />
                          </Field>
                          <div className="grid grid-cols-2 gap-2">
                            <NumberField
                              label="前方距离"
                              value={frontalDistance}
                              onChange={setFrontalDistance}
                              step={0.01}
                            />
                            <NumberField
                              label="后方距离"
                              value={rearDistance}
                              onChange={setRearDistance}
                              step={0.01}
                            />
                          </div>
                          <p className="text-[11px] leading-4 text-white/36">
                            拖动即在模块 1 视口中更新包围圈，提交时同步为 Substance 前后投射距离。
                          </p>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="compact-button w-full justify-center"
                          onClick={() => chooseFiles('cage')}
                        >
                          <FileUp className="h-3.5 w-3.5" />
                          {selectedCage ? `替换 · ${selectedCage.name}` : '选择外部 Cage'}
                        </button>
                      )}
                    </div>
                  </InspectorSection>
                  <InspectorSection title="输出贴图">
                    {(Object.keys(channelLabels) as ChannelId[]).map((channel) => (
                      <CheckLine
                        key={channel}
                        label={channelLabels[channel]}
                        checked={enabledChannels.has(channel)}
                        onClick={() => toggleChannel(channel)}
                      />
                    ))}
                  </InspectorSection>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center justify-between border-t border-white/10 pt-2 text-[13px] font-medium text-white/56 hover:text-white"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen((value) => !value)}
                  >
                    <span className="flex items-center gap-2">
                      <Settings2 className="h-3.5 w-3.5" />
                      高级设置
                    </span>
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 transition-transform',
                        advancedOpen && 'rotate-180',
                      )}
                    />
                  </button>
                  {advancedOpen ? (
                    <div className="space-y-4 border-l border-white/10 pl-3">
                      <Field label="名称匹配">
                        <Segmented
                          value={matchMode}
                          options={[
                            { value: 'always', label: '全部' },
                            { value: 'by-name', label: '按名称' },
                          ]}
                          onChange={setMatchMode}
                        />
                      </Field>
                      <Field label="命中策略">
                        <Segmented
                          value={hitStrategy}
                          options={[
                            { value: 'inward', label: 'Inward cast' },
                            { value: 'closest-from-source', label: 'Closest' },
                          ]}
                          onChange={setHitStrategy}
                        />
                      </Field>
                      <CheckLine
                        label="忽略背面"
                        checked={ignoreBackfaces}
                        onClick={() => setIgnoreBackfaces((value) => !value)}
                      />
                      <Field label="抗锯齿">
                        <Select
                          value={sampling}
                          options={['1x1', '2x2', '4x4', '8x8']}
                          onChange={setSampling}
                        />
                      </Field>
                      <NumberField label="Padding" value={padding} onChange={setPadding} step={1} />
                      <Field label="法线方向">
                        <Segmented
                          value={normalOrientation}
                          options={[
                            { value: 'directx', label: 'DirectX' },
                            { value: 'opengl', label: 'OpenGL' },
                          ]}
                          onChange={setNormalOrientation}
                        />
                      </Field>
                      <Field label="计算设备">
                        <Segmented
                          value={device}
                          options={[
                            { value: 'gpu', label: 'GPU' },
                            { value: 'cpu', label: 'CPU' },
                          ]}
                          onChange={setDevice}
                        />
                      </Field>
                      <NumberField label="UDIM" value={udim} onChange={setUdim} step={1} />
                    </div>
                  ) : null}
                  <div className="space-y-1.5 border-t border-white/8 pt-3">
                    {preflightRan && !preflightPassed ? (
                      <div className="mb-3 space-y-2 rounded-lg border border-amber-300/16 bg-amber-300/[0.035] p-3">
                        <p className="flex items-center gap-2 text-xs font-semibold text-amber-100">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          需要先修复以下问题
                        </p>
                        {preflightIssues.map((issue) => (
                          <div key={issue.id} className="border-t border-amber-100/10 pt-2">
                            <p className="text-xs text-amber-50/86">{issue.title}</p>
                            <p className="mt-1 text-[11px] leading-4 text-amber-100/44">
                              {issue.detail}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <StatusLine
                      label="低模 UV0"
                      value={selectedLow ? (hasUv0 ? '正常' : '缺失') : '待选择'}
                      ready={hasUv0}
                    />
                    <StatusLine
                      label="尺寸差"
                      value={percent(sizeDelta)}
                      ready={sizeDelta !== undefined && sizeDelta < MAX_BAKE_SIZE_DELTA_RATIO}
                    />
                    <StatusLine
                      label="包围盒中心差"
                      value={percent(positionDelta)}
                      ready={
                        positionDelta !== undefined && positionDelta < MAX_BAKE_CENTER_DELTA_RATIO
                      }
                    />
                  </div>
                  <p className="rounded-md border border-white/8 bg-black/20 px-2.5 py-2 text-[10px] text-white/30">
                    快捷键：F 聚焦 · Num 1/3/7 视图 · Num 5 正交 · Ctrl+S 保存
                  </p>
                </div>
              ) : null}

              {activeStage === 'bake' ? (
                <div className="space-y-5">
                  <InspectorSection title="任务摘要" caption={selectedHigh?.name}>
                    <SummaryLine label="烘焙器" value={bakeEngineProfiles[engine].shortName} />
                    <SummaryLine
                      label="输出"
                      value={`${resolution} · ${sampling} · ${padding}px`}
                    />
                    <SummaryLine
                      label="通道"
                      value={Array.from(enabledChannels)
                        .map((id) => channelLabels[id])
                        .join(' · ')}
                    />
                  </InspectorSection>
                  <p className="text-xs leading-5 text-white/38">
                    每个 Bake Set 独立提交和记录；失败对象不会阻塞其他对象。
                  </p>
                  {bakeJob ? <BakeProgressPanel job={bakeJob} /> : null}
                  {bakeError || bakeJob?.error ? (
                    <p className="rounded-lg border border-rose-300/20 bg-rose-950/28 p-3 text-xs leading-5 text-rose-100">
                      {bakeError ?? bakeJob?.error}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {activeStage === 'check' ? (
                <div className="space-y-5">
                  <InspectorSection title="结果检查">
                    {resultChannelOrder.map((channel) => {
                      const output = getBakeOutput(bakeJob, channel);
                      const requested =
                        bakeJob?.settings.channels?.includes(channel) ?? channel === 'normal';
                      return (
                        <AssetLine
                          key={channel}
                          label={channelLabels[channel]}
                          value={
                            output
                              ? `${output.width} × ${output.height} · 点击查看`
                              : requested
                                ? '待烘焙'
                                : '本次未选择'
                          }
                          ready={Boolean(output)}
                          active={selectedResultChannel === channel && Boolean(output)}
                          onClick={output ? () => setSelectedResultChannel(channel) : undefined}
                        />
                      );
                    })}
                  </InspectorSection>
                  {bakeJob?.status === 'succeeded' && selectedResultOutput && selectedResultUrl ? (
                    <div className="overflow-hidden rounded-lg border border-white/10 bg-black/25">
                      <button
                        type="button"
                        className="block w-full cursor-zoom-in"
                        title="点击查看全尺寸"
                        onClick={() => setResultLightboxOpen(true)}
                      >
                        <img
                          src={selectedResultUrl}
                          alt={`${channelLabels[selectedResultChannel]} 烘焙贴图`}
                          className={cn(
                            'aspect-square w-full object-contain',
                            selectedResultChannel === 'normal' ? 'bg-[#777f]' : 'bg-black/30',
                          )}
                        />
                      </button>
                      <div className="flex items-center justify-between border-t border-white/10 px-3 py-2.5">
                        <div>
                          <p className="text-[12px] font-medium text-white/76">
                            {selectedResultFilename}.png
                          </p>
                          <p className="mt-0.5 text-[10px] text-white/34">
                            {channelLabels[selectedResultChannel]} · PNG ·{' '}
                            {selectedResultOutput.width} × {selectedResultOutput.height}
                          </p>
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
                              await downloadBakeOutput(
                                bakeJob,
                                selectedResultChannel,
                                selectedResultFilename,
                              );
                            } catch (reason) {
                              setBakeError(
                                reason instanceof Error ? reason.message : '下载贴图失败',
                              );
                            } finally {
                              setDownloadingResult(false);
                            }
                          }}
                        >
                          <Download className="h-3.5 w-3.5" />
                          {downloadingResult ? '正在下载…' : '下载贴图'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <p className="text-xs leading-5 text-white/38">
                    这里只检查漏烘、接缝、Padding 和通道有效性。
                  </p>
                </div>
              ) : null}

              {activeStage === 'pbr' ? (
                <div className="space-y-5">
                  <InspectorSection title="PBR 通道">
                    <SummaryLine label="Base Color" value="烘焙结果" />
                    <SummaryLine label="AO" value="烘焙结果" />
                    <SummaryLine
                      label="Normal"
                      value={normalOrientation === 'directx' ? 'DirectX' : 'OpenGL'}
                    />
                    <SummaryLine
                      label="Roughness"
                      value={roughnessSource === 'comfy' ? 'ComfyUI' : '手工贴图'}
                    />
                    <SummaryLine label="Metallic" value="手工贴图" />
                  </InspectorSection>
                  <Field label="粗糙度来源">
                    <Segmented
                      value={roughnessSource}
                      options={[
                        { value: 'manual', label: '手工' },
                        { value: 'comfy', label: 'ComfyUI' },
                      ]}
                      onChange={setRoughnessSource}
                    />
                  </Field>
                  <ToggleLine
                    label="净化 Base Color"
                    checked={cleanBaseColor}
                    onChange={setCleanBaseColor}
                  />
                  <p className="text-xs leading-5 text-white/38">
                    ComfyUI 为可选远程步骤；断开时继续使用原始 Base Color 和手工 Roughness。
                  </p>
                </div>
              ) : null}

            </div>
          </aside>
        </div>

        <footer className="flex min-w-0 items-stretch gap-2 rounded-lg border border-white/[0.08] bg-black/35 p-2 backdrop-blur-xl">
          <nav className="flex min-w-[720px] flex-1 items-stretch gap-1" aria-label="PBR 烘焙流程">
            {stages.map((stage) => {
              const Icon = stage.icon;
              const state = stageState(stage.id);
              return (
                <button
                  key={stage.id}
                  type="button"
                  className={cn(
                    'flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md border border-transparent px-2 text-[11px] font-medium transition-colors',
                    state === 'active'
                      ? 'border-[#b64bd0]/48 bg-[#7e3999]/18 text-white'
                      : 'text-white/34 hover:bg-white/[0.04] hover:text-white/70',
                  )}
                  onClick={() => openStage(stage.id)}
                >
                  <span
                    className={cn(
                      'grid h-6 w-6 shrink-0 place-items-center rounded-md border border-white/[0.08]',
                      state === 'active' && 'border-[#b64bd0]/42 bg-[#9c43bd]/12 text-[#e482df]',
                      state === 'done' && 'border-emerald-300/20 text-emerald-300',
                    )}
                  >
                    {state === 'done' ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Icon className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="truncate">{stage.label}</span>
                </button>
              );
            })}
          </nav>
          <Button
            variant="primary"
            className="h-full min-w-[230px] rounded-md px-5 text-sm"
            onClick={handlePrimaryAction}
            disabled={
              activeStage === 'bake' &&
              (!preflightPassed ||
                bakeSubmitting ||
                bakeJob?.status === 'queued' ||
                bakeJob?.status === 'running')
            }
            icon={
              activeStage === 'alignment' ? (
                <ShieldCheck className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )
            }
          >
            {primaryActionLabel}
          </Button>
        </footer>
      </div>
    </WorkflowShell>
  );
}

function MaterialMapSlot({
  label,
  description,
  fileName,
  required,
  onClick,
}: {
  label: string;
  description: string;
  fileName?: string;
  required: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'group flex items-center gap-4 rounded-2xl border px-4 py-3.5 text-left transition-all',
        fileName
          ? 'border-emerald-300/18 bg-emerald-300/[0.045] hover:border-emerald-300/34'
          : required
            ? 'border-fuchsia-300/20 bg-fuchsia-300/[0.045] hover:border-fuchsia-300/38'
            : 'border-white/[0.08] bg-white/[0.025] hover:border-white/18 hover:bg-white/[0.045]',
      )}
      onClick={onClick}
    >
      <span
        className={cn(
          'grid h-11 w-11 shrink-0 place-items-center rounded-xl border',
          fileName
            ? 'border-emerald-200/20 bg-emerald-300/[0.08] text-emerald-100/80'
            : 'border-white/10 bg-black/20 text-white/34',
        )}
      >
        {fileName ? <Check className="h-5 w-5" /> : <FileUp className="h-5 w-5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <strong className="text-sm font-semibold text-white/84">{label}</strong>
          <span className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[9px] text-white/30">
            {required ? '当前需要' : '可选'}
          </span>
        </span>
        <span className="mt-1 block truncate text-xs text-white/36">{fileName ?? description}</span>
      </span>
      <span className="text-xs font-medium text-white/42 transition-colors group-hover:text-white/72">
        {fileName ? '替换' : '导入'}
      </span>
    </button>
  );
}

function OneClickAssetCard({
  step,
  title,
  english,
  description,
  value,
  ready,
  warning = false,
  icon: Icon,
  tone,
  preview,
  actionLabel,
  onClick,
  onFilesDropped,
  dropHint,
}: {
  step: string;
  title: string;
  english: string;
  description: string;
  value: string;
  ready: boolean;
  warning?: boolean;
  icon: LucideIcon;
  tone: 'violet' | 'cyan' | 'rose';
  preview?: string;
  actionLabel: string;
  onClick: () => void;
  onFilesDropped: (files: File[]) => void;
  dropHint: string;
}) {
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const toneClass = {
    violet:
      'from-violet-500/22 via-violet-500/8 to-transparent text-violet-100 border-violet-300/18 group-hover:border-violet-300/34',
    cyan: 'from-cyan-500/18 via-cyan-500/7 to-transparent text-cyan-100 border-cyan-300/16 group-hover:border-cyan-300/32',
    rose: 'from-fuchsia-500/18 via-rose-500/7 to-transparent text-fuchsia-100 border-fuchsia-300/16 group-hover:border-fuchsia-300/32',
  }[tone];
  const iconClass = {
    violet:
      'border-violet-200/24 bg-violet-300/10 text-violet-100 shadow-[0_0_32px_rgba(139,92,246,.15)]',
    cyan: 'border-cyan-200/22 bg-cyan-300/[0.08] text-cyan-100 shadow-[0_0_32px_rgba(34,211,238,.12)]',
    rose: 'border-fuchsia-200/22 bg-fuchsia-300/[0.08] text-fuchsia-100 shadow-[0_0_32px_rgba(232,121,249,.12)]',
  }[tone];
  const dropClass = {
    violet: 'border-violet-200/70 bg-[#171029]/92 text-violet-50',
    cyan: 'border-cyan-200/70 bg-[#071e28]/92 text-cyan-50',
    rose: 'border-fuchsia-200/70 bg-[#241027]/92 text-fuchsia-50',
  }[tone];

  function handleDragEnter(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current += 1;
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onFilesDropped(files);
  }

  return (
    <button
      type="button"
      className={cn(
        'group relative min-h-[270px] overflow-hidden rounded-2xl border bg-gradient-to-br text-left transition-all duration-300 hover:-translate-y-1 hover:bg-white/[0.035] hover:shadow-[0_20px_50px_rgba(0,0,0,.22)]',
        toneClass,
        dragActive && 'scale-[1.015] shadow-[0_24px_60px_rgba(0,0,0,.34)]',
      )}
      title={`点击选择，或将${dropHint}拖到此处`}
      onClick={onClick}
      onDragEnter={handleDragEnter}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive ? (
        <span
          className={cn(
            'pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed backdrop-blur-xl',
            dropClass,
          )}
        >
          <span className="flex flex-col items-center gap-3 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl border border-current/25 bg-white/[0.06]">
              <FileUp className="h-7 w-7" />
            </span>
            <span>
              <strong className="block text-sm font-semibold">松开即可导入</strong>
              <span className="mt-1 block text-[11px] opacity-55">{dropHint}</span>
            </span>
          </span>
        </span>
      ) : null}
      {preview ? (
        <img
          src={preview}
          alt=""
          className="absolute inset-x-0 top-0 h-[132px] w-full object-cover opacity-18 mix-blend-luminosity transition-opacity duration-300 group-hover:opacity-28"
        />
      ) : null}
      <div className="absolute inset-x-0 top-0 h-[150px] bg-gradient-to-b from-transparent to-[#0d0f1e]" />
      <div className="relative flex h-full flex-col p-5">
        <div className="flex items-start justify-between">
          <span className="text-[10px] font-semibold tracking-[0.18em] text-white/28">
            STEP {step}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium',
              warning
                ? 'border-amber-300/24 bg-amber-300/[0.08] text-amber-100/76'
                : ready
                  ? 'border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-100/72'
                  : 'border-white/10 bg-black/18 text-white/38',
            )}
          >
            {warning ? (
              <AlertTriangle className="h-3 w-3" />
            ) : ready ? (
              <Check className="h-3 w-3" />
            ) : (
              <Circle className="h-3 w-3" />
            )}
            {warning ? '需要处理' : ready ? '已导入' : '待导入'}
          </span>
        </div>
        <div
          className={cn(
            'mt-7 grid h-16 w-16 place-items-center rounded-2xl border backdrop-blur-md transition-transform duration-300 group-hover:scale-105',
            iconClass,
          )}
        >
          <Icon className="h-7 w-7" strokeWidth={1.6} />
        </div>
        <div className="mt-5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-xl font-semibold tracking-[-0.02em] text-white/92">{title}</h3>
            <span className="text-[9px] font-semibold tracking-[0.16em] text-white/28">
              {english}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-white/36">{description}</p>
        </div>
        <div className="mt-auto flex items-center justify-between gap-3 pt-5">
          <p className="min-w-0 truncate text-xs font-medium text-white/70" title={value}>
            {value}
          </p>
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-white/42 transition-colors group-hover:text-white/76">
            {actionLabel}
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>
    </button>
  );
}

function ConceptPanel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-lg border border-white/10 bg-black/35 backdrop-blur-xl',
        className,
      )}
    >
      {children}
    </section>
  );
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
        <h2 className="flex items-center gap-2 truncate text-[13px] font-semibold text-white/86">
          {title}
          {help ? <CircleHelp className="h-3.5 w-3.5 text-white/34" /> : null}
        </h2>
        <p className="mt-1 truncate text-[11px] font-normal text-white/40">{description}</p>
      </div>
      {actions}
    </header>
  );
}

function ConceptIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid h-8 w-8 place-items-center rounded-md border border-white/10 text-white/48 hover:bg-white/6 hover:text-white"
      onClick={onClick}
    >
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
        {thumbnail ? (
          <img src={thumbnail} alt="" className="h-full w-full object-cover" />
        ) : wire ? (
          <Box className="h-7 w-7 text-[#d88943]" />
        ) : (
          <Box className="h-7 w-7 text-white/30" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13px] font-medium text-white/84">
          <span
            className={cn(
              'h-2.5 w-2.5 rounded-full',
              ready ? 'bg-emerald-300' : warning ? 'bg-amber-300' : 'bg-white/22',
            )}
          />
          {label}
        </span>
        <span className="mt-1 block truncate text-[12px] font-normal text-white/42" title={value}>
          {value}
        </span>
        {warning ? (
          <span className="mt-1.5 block text-[11px] text-[#e8973d]">UV0 或拓扑需要检查</span>
        ) : null}
      </span>
      {onClick ? <FileUp className="h-4 w-4 shrink-0 text-white/34" /> : null}
    </>
  );
  const className =
    'flex min-h-[74px] w-full items-center gap-3 rounded-lg border border-white/[0.08] bg-[#0c0e1a]/56 p-2.5 text-left transition-colors hover:border-white/16 hover:bg-white/[0.03]';
  return onClick ? (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function ViewportTool({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'grid h-9 w-9 place-items-center rounded-md text-white/44 hover:bg-white/[0.055] hover:text-white',
        active && 'bg-[#72519a]/18 text-[#c794f5]',
      )}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function ViewportModeButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] text-white/48 hover:text-white',
        active && 'bg-[#72519a]/28 text-[#d6a8ff]',
      )}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function InspectorSection({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[12px] font-semibold text-white/64">{title}</h3>
        {caption ? (
          <span className="max-w-36 truncate text-[11px] text-white/28">{caption}</span>
        ) : null}
      </div>
      <div className="divide-y divide-white/8 rounded-lg border border-white/10 bg-[#0c0e1a]/56 px-3">
        {children}
      </div>
    </section>
  );
}

function SaveState({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  const labels = {
    idle: '自动保存',
    saving: '保存中…',
    saved: '已保存',
    error: '保存失败',
  } as const;
  return (
    <span
      title="Ctrl+S 保存烘焙工作区"
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[10px]',
        state === 'error' ? 'border-rose-300/18 text-rose-200/70' : 'border-white/8 text-white/34',
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          state === 'saving'
            ? 'animate-pulse bg-[#dd50cc]'
            : state === 'error'
              ? 'bg-rose-300'
              : 'bg-emerald-300',
        )}
      />
      {labels[state]}
    </span>
  );
}

const bakeStageOrder: NormalBakeJob['stage'][] = [
  'waiting-for-worker',
  'baking-maps',
  'verifying-file',
  'finished',
];
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
  return seconds < 60
    ? `${seconds.toFixed(1)} 秒`
    : `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

function BakeProgressPanel({ job }: { job: NormalBakeJob }) {
  const currentIndex = bakeStageOrder.indexOf(job.stage);
  const statusLabel =
    job.status === 'queued'
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
          <p className="mt-1 flex items-center gap-1.5 text-[10px] text-white/34">
            <Clock3 className="h-3 w-3" />
            {formatBakeDuration(job)} · {job.id.slice(-8)}
          </p>
        </div>
        <strong
          className={cn(
            'text-xl font-semibold tabular-nums',
            job.status === 'failed' ? 'text-rose-300' : 'text-[#dc61d5]',
          )}
        >
          {job.progress}%
        </strong>
      </div>
      <div className="px-3 py-3">
        <div className="h-1 overflow-hidden rounded-full bg-white/8">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#ec55cd] to-[#8b60ef] transition-[width] duration-500"
            style={{ width: `${job.progress}%` }}
          />
        </div>
        <div className="mt-3 grid grid-cols-4 gap-1">
          {bakeStageOrder.map((stage, index) => {
            const done = index < currentIndex || job.status === 'succeeded';
            const active = index === currentIndex && job.status !== 'succeeded';
            return (
              <div key={stage} className="min-w-0 text-center">
                <span
                  className={cn(
                    'mx-auto grid h-5 w-5 place-items-center rounded-full border text-[9px]',
                    done
                      ? 'border-emerald-300/50 bg-emerald-300/10 text-emerald-200'
                      : active
                        ? 'border-[#d85bce]/70 bg-[#d85bce]/12 text-[#ef9bea]'
                        : 'border-white/10 text-white/28',
                  )}
                >
                  {done ? <Check className="h-3 w-3" /> : index + 1}
                </span>
                <span
                  className={cn(
                    'mt-1 block truncate text-[9px]',
                    active ? 'text-white/64' : 'text-white/28',
                  )}
                >
                  {bakeStageLabels[stage]}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {job.logs.length ? (
        <details className="border-t border-white/8 px-3 py-2">
          <summary className="cursor-pointer select-none text-[10px] text-white/34 hover:text-white/58">
            技术日志 · {job.logs.length} 条
          </summary>
          <div className="workflow-scrollbar mt-2 max-h-28 overflow-y-auto rounded bg-black/25 p-2">
            {job.logs.map((line, index) => (
              <p
                key={`${index}-${line}`}
                className="break-all py-0.5 font-mono text-[9px] leading-3.5 text-white/28"
              >
                {line}
              </p>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function AssetLine({
  label,
  value,
  ready,
  active = false,
  onClick,
}: {
  label: string;
  value: string;
  ready: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[13px] text-white/68', active && 'text-white')}>
          {label}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-white/30" title={value}>
          {value}
        </span>
      </span>
      {ready ? (
        <Check className="h-3.5 w-3.5 text-emerald-300" />
      ) : onClick ? (
        <FileUp className="h-3.5 w-3.5 text-white/34" />
      ) : (
        <Circle className="h-3.5 w-3.5 text-white/24" />
      )}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-3 rounded px-1 py-2.5 text-left transition-colors hover:bg-white/[0.035]',
        active && 'bg-[#9c43bd]/10',
      )}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className="flex items-center gap-3 py-2.5">{content}</div>
  );
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

function CheckLine({
  label,
  checked,
  onClick,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 py-2 text-left"
      onClick={onClick}
    >
      <span
        className={cn(
          'grid h-4 w-4 place-items-center rounded-[3px] border border-white/18',
          checked && 'border-[#bd4cce] bg-[#9c43bd]',
        )}
      >
        {checked ? <Check className="h-3 w-3" /> : null}
      </span>
      <span className="text-[13px] text-white/68">{label}</span>
    </button>
  );
}

function StatusLine({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-white/32">{label}</span>
      <span className={ready ? 'text-emerald-300/80' : 'text-white/42'}>{value}</span>
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 text-[12px]">
      <span className="text-white/36">{label}</span>
      <span className="max-w-[190px] truncate text-right text-white/64" title={value}>
        {value}
      </span>
    </div>
  );
}

function ToggleLine({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between border-y border-white/8 py-2.5">
      <span className="text-[12px] text-white/58">{label}</span>
      <input
        className="peer sr-only"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="relative h-[18px] w-8 rounded-full bg-white/10 peer-checked:bg-[#8d42b0] after:absolute after:left-0.5 after:top-0.5 after:h-3.5 after:w-3.5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-3.5" />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step: number;
}) {
  return (
    <Field label={label}>
      <input
        aria-label={label}
        className="compact-input w-full"
        type="number"
        min="0"
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      className="compact-input w-full"
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option}>{option}</option>
      ))}
    </select>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn(
            'h-11 rounded-lg border border-white/[0.08] bg-[#0d0f1b] px-3 text-[13px] font-medium text-white/48 hover:border-white/16 hover:text-white/80',
            value === option.value &&
              'border-[#865cc5]/70 bg-[#69438d]/14 text-white shadow-[inset_0_0_0_1px_rgba(134,92,197,0.1)]',
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
