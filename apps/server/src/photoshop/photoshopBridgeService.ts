import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { serverConfig } from '../config.js';
import { writeFileAtomically } from '../services/atomicFileService.js';
import { getLocalSettings } from '../services/localSettingsService.js';
import {
  PHOTOSHOP_BRIDGE_PROTOCOL_VERSION,
  publicPhotoshopSession,
  type PhotoshopBridgeStatus,
  type PhotoshopInstallation,
  type PhotoshopPluginInfo,
  type PhotoshopPluginMessage,
  type PhotoshopServerMessage,
  type PhotoshopSessionDocument,
} from './protocol.js';

const execFileAsync = promisify(execFile);
const sessionRoot = path.join(serverConfig.workspaceDir, 'photoshop-sessions');
const manifestFilename = 'session.json';
const maxSourceBytes = 512 * 1024 * 1024;

function now() {
  return new Date().toISOString();
}

async function removeSessionDirectoryWhenReleased(directory: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) return;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

function normalizeExecutablePath(value?: string) {
  return value?.trim().replace(/^"|"$/g, '') ?? '';
}

function installationVersion(label: string) {
  return label.match(/(?:Photoshop\s*)?(\d{4}|\d+(?:\.\d+)+)/i)?.[1] ?? label;
}

function installationId(executablePath: string) {
  return crypto.createHash('sha1').update(executablePath.toLowerCase()).digest('hex').slice(0, 12);
}

async function isFile(filePath: string) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function detectRegistryPhotoshopPaths() {
  if (process.platform !== 'win32') return [];
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe',
  ];
  const paths: string[] = [];
  await Promise.all(
    keys.map(async (key) => {
      try {
        const { stdout } = await execFileAsync('reg.exe', ['query', key, '/ve'], {
          windowsHide: true,
          timeout: 3000,
        });
        for (const line of stdout.split(/\r?\n/)) {
          const match = line.match(/REG_SZ\s+(.+)$/i);
          if (match?.[1]) paths.push(normalizeExecutablePath(match[1]));
        }
      } catch {
        // A missing registry key is expected on many Photoshop installations.
      }
    }),
  );
  return paths;
}

async function detectFilesystemPhotoshopPaths() {
  if (process.platform !== 'win32') return [];
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ]
    .filter((value): value is string => Boolean(value))
    .map((root) => path.join(root, 'Adobe'));
  const results: string[] = [];
  await Promise.all(
    roots.map(async (root) => {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        await Promise.all(
          entries
            .filter((entry) => entry.isDirectory() && /^Adobe Photoshop/i.test(entry.name))
            .map(async (entry) => {
              const executablePath = path.join(root, entry.name, 'Photoshop.exe');
              if (await isFile(executablePath)) results.push(executablePath);
            }),
        );
      } catch {
        // Adobe is optional; inaccessible or absent install roots are ignored.
      }
    }),
  );
  return results;
}

function sourceExtension(mime: string) {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/tiff') return '.tif';
  return '.png';
}

function safeSessionId(value: string) {
  return /^[a-f0-9-]{20,80}$/i.test(value);
}

function safeRevisionFilename(value: string) {
  return /^rev-[a-z0-9_-]{6,80}\.png$/i.test(value);
}

function safeDocumentName(layerName: string, sessionId: string) {
  const normalized = layerName
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*]/g, '-')
    .split('')
    .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `LIclick-${normalized || 'Texture'}-${sessionId.slice(0, 8)}.psd`;
}

type ReusablePhotoshopSession = {
  session: PhotoshopSessionDocument;
  hasWorkingDocument: boolean;
  hasSource: boolean;
  duplicates: PhotoshopSessionDocument[];
};

type PhotoshopSessionInput = {
  projectId: string;
  layerId: string;
  layerName: string;
  layerType: 'projected' | 'uv';
};

class PhotoshopBridgeService {
  private readonly sessions = new Map<string, PhotoshopSessionDocument>();
  private readonly sessionWrites = new Map<string, Promise<void>>();
  private readonly webClients = new Map<string, Set<WebSocket>>();
  private readonly openCommands = new Set<string>();
  private sessionCreateQueue = Promise.resolve();
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private pluginSocket?: WebSocket;
  private pluginInfo: PhotoshopPluginInfo = { connected: false };
  private initialized?: Promise<void>;
  private pluginMessageQueue = Promise.resolve();
  private heartbeatTimer?: NodeJS.Timeout;

  attach(server: HttpServer) {
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (url.pathname !== '/api/photoshop/socket') return;
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (webSocket) => {
        void this.handleConnection(webSocket, request, url);
      });
    });
    this.heartbeatTimer = setInterval(() => this.checkConnections(), 20_000);
    server.on('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.wss.close();
    });
  }

  private async ensureInitialized() {
    this.initialized ??= this.loadSessions();
    await this.initialized;
  }

  private async loadSessions() {
    await fs.mkdir(sessionRoot, { recursive: true });
    const entries = await fs.readdir(sessionRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && safeSessionId(entry.name))
        .map(async (entry) => {
          try {
            const raw = await fs.readFile(path.join(sessionRoot, entry.name, manifestFilename), 'utf8');
            const session = JSON.parse(raw) as PhotoshopSessionDocument;
            if (session.id !== entry.name || session.protocolVersion !== PHOTOSHOP_BRIDGE_PROTOCOL_VERSION) return;
            if (session.status !== 'closed') session.status = 'waiting_for_plugin';
            this.sessions.set(session.id, session);
          } catch {
            // Corrupt or incomplete sessions remain isolated in their own folder.
          }
        }),
    );
  }

  async detectInstallations(): Promise<PhotoshopInstallation[]> {
    const settings = await getLocalSettings();
    const candidates: Array<{ executablePath: string; source: PhotoshopInstallation['source'] }> = [];
    const fromEnvironment = normalizeExecutablePath(process.env.LICLICK_PHOTOSHOP_PATH);
    if (fromEnvironment) candidates.push({ executablePath: fromEnvironment, source: 'environment' });
    if (settings.photoshop.executablePath) {
      candidates.push({ executablePath: settings.photoshop.executablePath, source: 'settings' });
    }
    for (const executablePath of await detectRegistryPhotoshopPaths()) {
      candidates.push({ executablePath, source: 'registry' });
    }
    for (const executablePath of await detectFilesystemPhotoshopPaths()) {
      candidates.push({ executablePath, source: 'filesystem' });
    }
    const unique = new Map<string, PhotoshopInstallation>();
    for (const candidate of candidates) {
      const executablePath = path.resolve(candidate.executablePath);
      if (!(await isFile(executablePath))) continue;
      const installFolder = path.basename(path.dirname(executablePath));
      const version = installationVersion(installFolder);
      const key = executablePath.toLowerCase();
      if (unique.has(key)) continue;
      unique.set(key, {
        id: installationId(executablePath),
        label: installFolder || `Adobe Photoshop ${version}`,
        version,
        executablePath,
        source: candidate.source,
        selected:
          executablePath.toLowerCase() === settings.photoshop.executablePath.toLowerCase() ||
          (!settings.photoshop.executablePath && candidate.source === 'environment'),
      });
    }
    const installations = [...unique.values()].sort((left, right) =>
      right.version.localeCompare(left.version, undefined, { numeric: true }),
    );
    if (!installations.some((item) => item.selected) && installations[0]) installations[0].selected = true;
    return installations;
  }

  async getStatus(): Promise<PhotoshopBridgeStatus> {
    await this.ensureInitialized();
    const installations = await this.detectInstallations();
    return {
      protocolVersion: PHOTOSHOP_BRIDGE_PROTOCOL_VERSION,
      plugin: { ...this.pluginInfo },
      installations,
      selectedInstallation: installations.find((item) => item.selected),
      activeSessions: [...this.sessions.values()].filter((session) => session.status !== 'closed').length,
    };
  }

  async launchPhotoshop() {
    const status = await this.getStatus();
    const selected = status.selectedInstallation;
    if (!selected) throw new Error('未检测到 Photoshop。请在启动器高级设置中选择 Photoshop.exe。');
    const child = spawn(selected.executablePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { installation: selected, pluginConnected: this.pluginInfo.connected };
  }

  private async findReusableSession(projectId: string, layerId: string): Promise<ReusablePhotoshopSession | undefined> {
    const matches = [...this.sessions.values()].filter(
      (session) => session.projectId === projectId && session.layerId === layerId,
    );
    const inspected = await Promise.all(
      matches.map(async (session) => ({
        session,
        hasWorkingDocument: await isFile(session.workingDocumentPath),
        hasSource: Boolean(session.sourcePath && (await isFile(session.sourcePath))),
      })),
    );
    const ranked = inspected.sort((left, right) => {
      if (left.hasWorkingDocument !== right.hasWorkingDocument) return left.hasWorkingDocument ? -1 : 1;
      if (left.hasSource !== right.hasSource) return left.hasSource ? -1 : 1;
      return (Date.parse(right.session.updatedAt) || 0) - (Date.parse(left.session.updatedAt) || 0);
    });
    const selected = ranked[0];
    return selected
      ? {
          ...selected,
          duplicates: ranked.slice(1).map((item) => item.session),
        }
      : undefined;
  }

  private async retireDuplicateSessions(sessions: PhotoshopSessionDocument[]) {
    await Promise.all(
      sessions.map(async (session) => {
        if (session.status === 'closed') return;
        if (this.pluginReady()) this.sendPlugin({ type: 'close-session', sessionId: session.id });
        session.status = 'closed';
        this.openCommands.delete(session.id);
        await this.persistSession(session);
        this.broadcastSession(session);
      }),
    );
  }

  async createSession(input: PhotoshopSessionInput) {
    const previous = this.sessionCreateQueue;
    let release!: () => void;
    this.sessionCreateQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.createOrReuseSession(input);
    } finally {
      release();
    }
  }

  private async createOrReuseSession(input: PhotoshopSessionInput) {
    await this.ensureInitialized();
    const settings = await getLocalSettings();
    const projectId = input.projectId.slice(0, 200);
    const layerId = input.layerId.slice(0, 200);
    const reusable = await this.findReusableSession(projectId, layerId);
    if (reusable) {
      await this.retireDuplicateSessions(reusable.duplicates);
      const session = reusable.session;
      session.layerName = input.layerName.slice(0, 240);
      session.layerType = input.layerType;
      session.status = reusable.hasWorkingDocument ? 'waiting_for_plugin' : 'awaiting_source';
      session.syncMode = settings.photoshop.syncMode;
      session.liveSyncDelayMs = settings.photoshop.liveSyncDelayMs;
      session.error = undefined;
      session.updatedAt = now();
      this.openCommands.delete(session.id);
      await this.persistSession(session);
      this.broadcastSession(session);
      return {
        ...publicPhotoshopSession(session),
        reused: true,
        sourceRequired: !reusable.hasWorkingDocument,
      };
    }
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString('base64url');
    const directory = path.join(sessionRoot, id);
    const revisionsDirectory = path.join(directory, 'revisions');
    await fs.mkdir(revisionsDirectory, { recursive: true });
    const timestamp = now();
    const session: PhotoshopSessionDocument = {
      protocolVersion: PHOTOSHOP_BRIDGE_PROTOCOL_VERSION,
      id,
      token,
      projectId,
      layerId,
      layerName: input.layerName.slice(0, 240),
      layerType: input.layerType,
      status: 'awaiting_source',
      workingDocumentPath: path.join(directory, safeDocumentName(input.layerName, id)),
      revisionsDirectory,
      latestRevision: 0,
      syncMode: settings.photoshop.syncMode,
      liveSyncDelayMs: settings.photoshop.liveSyncDelayMs,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.sessions.set(id, session);
    await this.persistSession(session);
    return {
      ...publicPhotoshopSession(session),
      reused: false,
      sourceRequired: true,
    };
  }

  async uploadSource(sessionId: string, token: string, mime: string, buffer: Buffer) {
    if (buffer.byteLength > maxSourceBytes) throw new Error('图层图片超过 512 MB，无法创建 Photoshop 会话。');
    const session = await this.requireSession(sessionId, token);
    if (!mime.startsWith('image/')) throw new Error('Photoshop 会话源文件必须是图像。');
    const sourcePath = path.join(sessionRoot, session.id, `source${sourceExtension(mime)}`);
    await writeFileAtomically(sourcePath, buffer);
    session.sourcePath = sourcePath;
    session.sourceMime = mime;
    session.status = 'waiting_for_plugin';
    session.error = undefined;
    session.updatedAt = now();
    await this.persistSession(session);
    this.broadcastSession(session);
    return publicPhotoshopSession(session);
  }

  async openSession(sessionId: string, token: string) {
    const session = await this.requireSession(sessionId, token);
    const hasSource = Boolean(session.sourcePath && (await isFile(session.sourcePath)));
    const hasWorkingDocument = await isFile(session.workingDocumentPath);
    if (!hasSource && !hasWorkingDocument) throw new Error('Photoshop 会话源图像尚未上传。');
    session.status = this.pluginReady() ? 'opening' : 'launching';
    session.error = undefined;
    session.updatedAt = now();
    await this.persistSession(session);
    this.broadcastSession(session);
    if (!this.pluginReady()) {
      const settings = await getLocalSettings();
      if (settings.photoshop.autoLaunch) {
        await this.launchPhotoshop();
      }
      session.status = 'waiting_for_plugin';
      session.updatedAt = now();
      await this.persistSession(session);
      this.broadcastSession(session);
    } else {
      this.sendOpenSession(session);
    }
    return publicPhotoshopSession(session);
  }

  async getSession(sessionId: string, token: string) {
    return publicPhotoshopSession(await this.requireSession(sessionId, token));
  }

  async requestSync(sessionId: string, token: string) {
    const session = await this.requireSession(sessionId, token);
    if (!this.pluginReady()) throw new Error('Photoshop 插件尚未连接。');
    this.sendPlugin({ type: 'sync-now', sessionId });
    session.status = 'syncing';
    session.updatedAt = now();
    await this.persistSession(session);
    this.broadcastSession(session);
    return publicPhotoshopSession(session);
  }

  async closeSession(sessionId: string, token: string) {
    const session = await this.requireSession(sessionId, token);
    if (this.pluginReady()) this.sendPlugin({ type: 'close-session', sessionId });
    session.status = 'closed';
    this.openCommands.delete(session.id);
    session.updatedAt = now();
    await this.persistSession(session);
    this.broadcastSession(session);
    const result = publicPhotoshopSession(session);
    const settings = await getLocalSettings();
    if (!settings.photoshop.keepSessionFiles) {
      this.sessions.delete(session.id);
      this.sessionWrites.delete(session.id);
      void removeSessionDirectoryWhenReleased(path.join(sessionRoot, session.id));
    }
    return result;
  }

  private async requireSession(sessionId: string, token: string) {
    await this.ensureInitialized();
    if (!safeSessionId(sessionId)) throw new Error('无效的 Photoshop 会话。');
    const session = this.sessions.get(sessionId);
    const expectedToken = Buffer.from(session?.token ?? '');
    const receivedToken = Buffer.from(token);
    if (
      !session ||
      !token ||
      expectedToken.byteLength !== receivedToken.byteLength ||
      !crypto.timingSafeEqual(expectedToken, receivedToken)
    ) {
      throw new Error('Photoshop 会话不存在或令牌无效。');
    }
    return session;
  }

  private async persistSession(session: PhotoshopSessionDocument) {
    const filePath = path.join(sessionRoot, session.id, manifestFilename);
    const snapshot = `${JSON.stringify(session, null, 2)}\n`;
    const previous = this.sessionWrites.get(session.id) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => writeFileAtomically(filePath, snapshot));
    this.sessionWrites.set(session.id, write);
    try {
      await write;
    } finally {
      if (this.sessionWrites.get(session.id) === write) this.sessionWrites.delete(session.id);
    }
  }

  private pluginReady() {
    return this.pluginSocket?.readyState === WebSocket.OPEN && Boolean(this.pluginInfo.pluginVersion);
  }

  private sendPlugin(message: PhotoshopServerMessage) {
    if (!this.pluginReady()) return false;
    this.pluginSocket?.send(JSON.stringify(message));
    return true;
  }

  private sendOpenSession(session: PhotoshopSessionDocument) {
    if (this.openCommands.has(session.id)) return;
    this.openCommands.add(session.id);
    session.status = 'opening';
    session.updatedAt = now();
    void this.persistSession(session).catch(() => undefined);
    this.broadcastSession(session);
    this.sendPlugin({
      type: 'open-session',
      session: {
        id: session.id,
        projectId: session.projectId,
        layerId: session.layerId,
        layerName: session.layerName,
        layerType: session.layerType,
        sourcePath: session.sourcePath,
        workingDocumentPath: session.workingDocumentPath,
        revisionsDirectory: session.revisionsDirectory,
        syncMode: session.syncMode,
        liveSyncDelayMs: session.liveSyncDelayMs,
      },
    });
  }

  private broadcastSession(session: PhotoshopSessionDocument) {
    const message: PhotoshopServerMessage = { type: 'session-updated', session };
    for (const socket of this.webClients.get(session.id) ?? []) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }
  }

  private broadcastBridgeStatus() {
    const status = {
      protocolVersion: PHOTOSHOP_BRIDGE_PROTOCOL_VERSION,
      plugin: { ...this.pluginInfo },
      activeSessions: [...this.sessions.values()].filter((session) => session.status !== 'closed').length,
    };
    const message: PhotoshopServerMessage = { type: 'bridge-status', status };
    for (const clients of this.webClients.values()) {
      for (const socket of clients) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      }
    }
  }

  private async handleConnection(socket: WebSocket, _request: IncomingMessage, url: URL) {
    await this.ensureInitialized();
    const role = url.searchParams.get('role');
    if (role === 'plugin') {
      if (this.pluginSocket && this.pluginSocket !== socket) this.pluginSocket.close(4001, 'Replaced by a newer plugin connection.');
      this.pluginSocket = socket;
      this.pluginInfo = { connected: true, connectedAt: now(), lastSeenAt: now() };
      socket.on('message', (data) => {
        this.pluginMessageQueue = this.pluginMessageQueue
          .catch(() => undefined)
          .then(() => this.handlePluginMessage(data.toString()))
          .catch((error: unknown) => {
            console.error(
              '[Photoshop Bridge] Plugin message failed; the workspace server will keep running.',
              error,
            );
          });
      });
      socket.on('pong', () => {
        this.pluginInfo.lastSeenAt = now();
      });
      socket.on('close', () => {
        if (this.pluginSocket !== socket) return;
        this.pluginSocket = undefined;
        this.pluginInfo = { ...this.pluginInfo, connected: false, lastSeenAt: now() };
        this.openCommands.clear();
        this.broadcastBridgeStatus();
      });
      this.broadcastBridgeStatus();
      return;
    }
    if (role === 'web') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const token = url.searchParams.get('token') ?? '';
      try {
        const session = await this.requireSession(sessionId, token);
        const clients = this.webClients.get(session.id) ?? new Set<WebSocket>();
        clients.add(socket);
        this.webClients.set(session.id, clients);
        socket.send(JSON.stringify({ type: 'session-updated', session } satisfies PhotoshopServerMessage));
        socket.on('close', () => {
          clients.delete(socket);
          if (clients.size === 0) this.webClients.delete(session.id);
        });
      } catch {
        socket.close(4003, 'Invalid session.');
      }
      return;
    }
    socket.close(4000, 'Unknown bridge role.');
  }

  private async handlePluginMessage(raw: string) {
    let message: PhotoshopPluginMessage;
    try {
      message = JSON.parse(raw) as PhotoshopPluginMessage;
    } catch {
      return;
    }
    this.pluginInfo.lastSeenAt = now();
    if (message.type === 'hello') {
      this.pluginInfo = {
        connected: true,
        pluginVersion: message.pluginVersion,
        photoshopVersion: message.photoshopVersion,
        connectedAt: this.pluginInfo.connectedAt ?? now(),
        lastSeenAt: now(),
      };
      const settings = await getLocalSettings();
      this.sendPlugin({
        type: 'hello-ack',
        protocolVersion: PHOTOSHOP_BRIDGE_PROTOCOL_VERSION,
        syncMode: settings.photoshop.syncMode,
        liveSyncDelayMs: settings.photoshop.liveSyncDelayMs,
      });
      for (const session of this.sessions.values()) {
        if (
          session.status !== 'closed' &&
          ((session.sourcePath && (await isFile(session.sourcePath))) || (await isFile(session.workingDocumentPath)))
        ) {
          this.sendOpenSession(session);
        }
      }
      this.broadcastBridgeStatus();
      return;
    }
    if (message.type === 'heartbeat') return;
    const session = this.sessions.get(message.sessionId);
    if (!session || session.status === 'closed') return;
    if (message.type === 'session-status') {
      session.status = message.status;
      session.error = message.error;
      if (message.status === 'error') this.openCommands.delete(session.id);
      session.updatedAt = now();
      await this.persistSession(session);
      this.broadcastSession(session);
      return;
    }
    if (message.type === 'session-exported') {
      if (!safeRevisionFilename(message.filename)) return;
      const imagePath = path.resolve(session.revisionsDirectory, message.filename);
      if (!imagePath.startsWith(`${path.resolve(session.revisionsDirectory)}${path.sep}`) || !(await isFile(imagePath))) return;
      if (session.latestImagePath === imagePath) return;
      session.latestRevision += 1;
      session.latestImagePath = imagePath;
      const relativePath = path.relative(serverConfig.workspaceDir, imagePath).split(path.sep).map(encodeURIComponent).join('/');
      session.latestImageUrl = `${serverConfig.publicWorkspaceUrl.replace(/\/$/, '')}/workspace/${relativePath}?revision=${session.latestRevision}`;
      session.status = 'synced';
      session.error = undefined;
      session.updatedAt = now();
      await this.persistSession(session);
      this.broadcastSession(session);
    }
  }

  private checkConnections() {
    if (this.pluginSocket?.readyState === WebSocket.OPEN) this.pluginSocket.ping();
    for (const clients of this.webClients.values()) {
      for (const socket of clients) {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }
    }
  }
}

export const photoshopBridge = new PhotoshopBridgeService();
export { maxSourceBytes };
