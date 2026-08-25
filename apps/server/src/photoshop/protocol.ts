export const PHOTOSHOP_BRIDGE_PROTOCOL_VERSION = '1.0.0';

export type PhotoshopSyncMode = 'save' | 'live';

export type PhotoshopSessionStatus =
  | 'awaiting_source'
  | 'launching'
  | 'waiting_for_plugin'
  | 'opening'
  | 'ready'
  | 'dirty'
  | 'syncing'
  | 'synced'
  | 'error'
  | 'closed';

export type PhotoshopInstallation = {
  id: string;
  label: string;
  version: string;
  executablePath: string;
  source: 'environment' | 'settings' | 'registry' | 'filesystem';
  selected: boolean;
};

export type PhotoshopSessionDocument = {
  protocolVersion: string;
  id: string;
  token: string;
  projectId: string;
  layerId: string;
  layerName: string;
  layerType: 'projected' | 'uv';
  status: PhotoshopSessionStatus;
  sourcePath?: string;
  sourceMime?: string;
  workingDocumentPath: string;
  revisionsDirectory: string;
  latestRevision: number;
  latestImagePath?: string;
  latestImageUrl?: string;
  syncMode: PhotoshopSyncMode;
  liveSyncDelayMs: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type PhotoshopPluginInfo = {
  connected: boolean;
  pluginVersion?: string;
  photoshopVersion?: string;
  connectedAt?: string;
  lastSeenAt?: string;
};

export type PhotoshopBridgeStatus = {
  protocolVersion: string;
  plugin: PhotoshopPluginInfo;
  installations: PhotoshopInstallation[];
  selectedInstallation?: PhotoshopInstallation;
  activeSessions: number;
};

export type PhotoshopServerMessage =
  | {
      type: 'hello-ack';
      protocolVersion: string;
      syncMode: PhotoshopSyncMode;
      liveSyncDelayMs: number;
    }
  | {
      type: 'open-session';
      session: Pick<
        PhotoshopSessionDocument,
        | 'id'
        | 'projectId'
        | 'layerId'
        | 'layerName'
        | 'layerType'
        | 'sourcePath'
        | 'workingDocumentPath'
        | 'revisionsDirectory'
        | 'syncMode'
        | 'liveSyncDelayMs'
      >;
    }
  | { type: 'sync-now'; sessionId: string }
  | { type: 'close-session'; sessionId: string }
  | { type: 'session-updated'; session: PhotoshopSessionDocument }
  | { type: 'bridge-status'; status: Omit<PhotoshopBridgeStatus, 'installations' | 'selectedInstallation'> };

export type PhotoshopPluginMessage =
  | {
      type: 'hello';
      protocolVersion: string;
      pluginVersion: string;
      photoshopVersion?: string;
    }
  | { type: 'heartbeat' }
  | {
      type: 'session-status';
      sessionId: string;
      status: Extract<PhotoshopSessionStatus, 'opening' | 'ready' | 'dirty' | 'syncing' | 'error'>;
      error?: string;
    }
  | {
      type: 'session-exported';
      sessionId: string;
      filename: string;
      width?: number;
      height?: number;
    };

export function publicPhotoshopSession(session: PhotoshopSessionDocument) {
  return {
    id: session.id,
    token: session.token,
    projectId: session.projectId,
    layerId: session.layerId,
    layerName: session.layerName,
    layerType: session.layerType,
    status: session.status,
    workingDocumentPath: session.workingDocumentPath,
    latestRevision: session.latestRevision,
    latestImageUrl: session.latestImageUrl,
    syncMode: session.syncMode,
    liveSyncDelayMs: session.liveSyncDelayMs,
    error: session.error,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
