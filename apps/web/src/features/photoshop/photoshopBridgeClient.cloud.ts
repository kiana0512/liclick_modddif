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

export type PhotoshopSession = {
  id: string;
  token: string;
  projectId: string;
  layerId: string;
  layerName: string;
  layerType: 'projected' | 'uv';
  status: PhotoshopSessionStatus;
  workingDocumentPath: string;
  latestRevision: number;
  latestImageUrl?: string;
  syncMode: 'save' | 'live';
  liveSyncDelayMs: number;
  reused?: boolean;
  sourceRequired?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type PhotoshopBridgeStatus = {
  protocolVersion: string;
  plugin: { connected: boolean; pluginVersion?: string; photoshopVersion?: string };
  installations: Array<{
    id: string;
    label: string;
    version: string;
    executablePath: string;
    selected: boolean;
  }>;
  selectedInstallation?: {
    id: string;
    label: string;
    version: string;
    executablePath: string;
    selected: boolean;
  };
  activeSessions: number;
};

function unavailable(): never {
  throw new Error('Photoshop/DCC 桥接不属于 Cloud Build 核心能力。');
}

export async function getPhotoshopBridgeStatus(): Promise<PhotoshopBridgeStatus> {
  return unavailable();
}

export async function launchPhotoshop(): Promise<{ pluginConnected: boolean }> {
  return unavailable();
}

export async function createPhotoshopSession(_input: {
  projectId: string;
  layerId: string;
  layerName: string;
  layerType: 'projected' | 'uv';
}): Promise<PhotoshopSession> {
  return unavailable();
}

export async function uploadPhotoshopSessionSource(
  _session: PhotoshopSession,
  _image: Blob,
): Promise<PhotoshopSession> {
  return unavailable();
}

export async function openPhotoshopSession(_session: PhotoshopSession): Promise<PhotoshopSession> {
  return unavailable();
}

export async function syncPhotoshopSession(_session: PhotoshopSession): Promise<PhotoshopSession> {
  return unavailable();
}

export async function closePhotoshopSession(_session: PhotoshopSession): Promise<PhotoshopSession> {
  return unavailable();
}

export function subscribePhotoshopSession(
  _session: PhotoshopSession,
  _listener: (session: PhotoshopSession) => void,
) {
  return () => undefined;
}
