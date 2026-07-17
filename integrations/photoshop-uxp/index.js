const { app, core, action } = require('photoshop');
const { storage } = require('uxp');

const PLUGIN_VERSION = '1.0.0';
const PROTOCOL_VERSION = '1.0.0';
const BRIDGE_URLS = [
  'ws://127.0.0.1:4617/api/photoshop/socket?role=plugin',
  'ws://127.0.0.1:4517/api/photoshop/socket?role=plugin',
];
const sessions = new Map();
let socket;
let reconnectTimer;
let reconnectAttempt = 0;
let eventListenersInstalled = false;
let exportCounter = 0;
let bridgeIndex = 0;

function $(selector) {
  return document.querySelector(selector);
}

function setConnection(tone, status, copy) {
  const dot = $('#connectionDot');
  if (dot) dot.dataset.tone = tone;
  if ($('#connectionStatus')) $('#connectionStatus').textContent = status;
  if ($('#connectionCopy')) $('#connectionCopy').textContent = copy;
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function statusLabel(status) {
  return {
    opening: '正在打开',
    ready: '已连接',
    dirty: '等待同步',
    syncing: '正在同步',
    synced: '已同步',
    error: '同步异常',
  }[status] ?? status;
}

function renderSessions() {
  const list = $('#sessionList');
  if (!list) return;
  list.replaceChildren();
  const values = [...sessions.values()];
  $('#emptyState').hidden = values.length > 0;
  $('#syncNow').disabled = values.length === 0 || socket?.readyState !== WebSocket.OPEN;
  for (const session of values) {
    const card = document.createElement('article');
    card.className = 'session-card';
    const name = document.createElement('strong');
    name.textContent = session.layerName;
    const meta = document.createElement('div');
    meta.className = 'session-meta';
    const type = document.createElement('span');
    type.textContent = session.layerType === 'uv' ? 'UV 图层' : '投影图层';
    const state = document.createElement('span');
    state.textContent = statusLabel(session.status);
    meta.append(type, state);
    card.append(name, meta);
    if (session.error) {
      const error = document.createElement('p');
      error.textContent = session.error;
      card.append(error);
    }
    list.append(card);
  }
}

function fileUrl(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return `file:/${normalized.replace(/^\/+/, '')}`;
}

async function entryIfExists(filePath) {
  try {
    return await storage.localFileSystem.getEntryWithUrl(fileUrl(filePath));
  } catch {
    return undefined;
  }
}

function findDocument(documentId) {
  return app.documents.find((document) => document.id === documentId);
}

function workingDocumentName(session) {
  return session.workingDocumentPath.split(/[\\/]/).pop();
}

function findOpenWorkingDocument(session) {
  const expectedName = workingDocumentName(session).toLowerCase();
  return app.documents.find((document) => document.name?.toLowerCase() === expectedName);
}

function sessionForActiveDocument() {
  const documentId = app.activeDocument?.id;
  if (!documentId) return undefined;
  return [...sessions.values()].find((session) => session.documentId === documentId);
}

function updateSession(session, patch) {
  Object.assign(session, patch);
  sessions.set(session.id, session);
  renderSessions();
}

function reportStatus(session, status, error) {
  updateSession(session, { status, error });
  send({ type: 'session-status', sessionId: session.id, status, ...(error ? { error } : {}) });
}

async function createWorkingDocument(session) {
  const existing = await entryIfExists(session.workingDocumentPath);
  if (existing?.isFile) return app.open(existing);
  const source = await entryIfExists(session.sourcePath);
  if (!source?.isFile) throw new Error('LIclick 源图像不存在。');
  const document = await app.open(source);
  const workingFolder = await storage.localFileSystem.getEntryWithUrl(
    fileUrl(session.workingDocumentPath.replace(/[\\/][^\\/]+$/, '')),
  );
  const requestedName = workingDocumentName(session);
  const workingFile = await workingFolder.createFile(requestedName, { overwrite: true });
  await document.saveAs.psd(workingFile, {}, false);
  try {
    const editLayer = await document.createLayer({ name: 'LIclick 编辑' });
    document.activeLayers = [editLayer];
  } catch {
    // Older supported hosts may not expose createLayer through the DOM; the PSD is still editable.
  }
  return document;
}

async function openSession(payload) {
  const existing = sessions.get(payload.id);
  if (existing?.documentId && findDocument(existing.documentId)) {
    app.activeDocument = findDocument(existing.documentId);
    reportStatus(existing, 'ready');
    return;
  }
  if (existing?.openingPromise) {
    await existing.openingPromise;
    return;
  }
  const openDocument = findOpenWorkingDocument(payload);
  if (openDocument) {
    const restored = { ...payload, status: 'ready', exporting: false, documentId: openDocument.id };
    sessions.set(restored.id, restored);
    app.activeDocument = openDocument;
    reportStatus(restored, 'ready');
    return;
  }
  const session = { ...payload, status: 'opening', exporting: false };
  sessions.set(session.id, session);
  reportStatus(session, 'opening');
  session.openingPromise = (async () => {
  try {
    const document = await core.executeAsModal(
      () => createWorkingDocument(session),
      { commandName: '打开 LIclick 纹理编辑会话' },
    );
    session.documentId = document.id;
    reportStatus(session, 'ready');
    if (session.syncMode === 'live') scheduleExport(session, Math.max(300, session.liveSyncDelayMs));
  } catch (error) {
    reportStatus(session, 'error', error instanceof Error ? error.message : String(error));
  } finally {
    session.openingPromise = undefined;
  }
  })();
  await session.openingPromise;
}

function scheduleExport(session, delay) {
  if (session.syncMode !== 'live' || session.exporting) return;
  clearTimeout(session.exportTimer);
  session.exportTimer = setTimeout(() => void exportSession(session), delay);
}

async function exportSession(session) {
  if (session.exporting) return;
  const document = findDocument(session.documentId);
  if (!document) {
    reportStatus(session, 'error', 'Photoshop 工作文档已关闭。');
    return;
  }
  session.exporting = true;
  clearTimeout(session.exportTimer);
  reportStatus(session, 'syncing');
  try {
    const filename = `rev-${Date.now().toString(36)}-${(++exportCounter).toString(36).padStart(3, '0')}.png`;
    await core.executeAsModal(async () => {
      const outputFolder = await storage.localFileSystem.getEntryWithUrl(fileUrl(session.revisionsDirectory));
      const outputFile = await outputFolder.createFile(filename, { overwrite: false });
      await document.saveAs.png(outputFile, { compression: 6 }, true);
    }, { commandName: '同步纹理到 LIclick' });
    updateSession(session, { status: 'synced', error: undefined, lastSyncAt: new Date() });
    $('#lastSync').textContent = `同步于 ${new Date().toLocaleTimeString()}`;
    send({ type: 'session-exported', sessionId: session.id, filename });
  } catch (error) {
    reportStatus(session, 'error', error instanceof Error ? error.message : String(error));
  } finally {
    session.exporting = false;
  }
}

function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.exportTimer);
  sessions.delete(sessionId);
  renderSessions();
}

async function handleMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.type === 'hello-ack') {
    setConnection('online', '已连接', 'Photoshop 与 LIclick 本地工作区保持实时连接。');
    renderSessions();
    return;
  }
  if (message.type === 'open-session') {
    await openSession(message.session);
    return;
  }
  if (message.type === 'sync-now') {
    const session = sessions.get(message.sessionId);
    if (session) await exportSession(session);
    return;
  }
  if (message.type === 'close-session') closeSession(message.sessionId);
}

function connect() {
  clearTimeout(reconnectTimer);
  setConnection('starting', '连接中', '正在连接 LIclick 本地工作区…');
  try {
    socket = new WebSocket(BRIDGE_URLS[bridgeIndex]);
  } catch (error) {
    scheduleReconnect(error);
    return;
  }
  socket.addEventListener('open', () => {
    reconnectAttempt = 0;
    send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      pluginVersion: PLUGIN_VERSION,
      photoshopVersion: app.version,
    });
  });
  socket.addEventListener('message', (event) => void handleMessage(event));
  socket.addEventListener('close', () => {
    bridgeIndex = (bridgeIndex + 1) % BRIDGE_URLS.length;
    scheduleReconnect();
  });
  socket.addEventListener('error', (event) => scheduleReconnect(event));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  setConnection('error', '等待工作区', '启动 LIclick 后插件会自动重新连接。');
  const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}

function installDocumentListeners() {
  if (eventListenersInstalled) return;
  eventListenersInstalled = true;
  action.addNotificationListener(['historyStateChanged', 'save'], (event) => {
    const session = sessionForActiveDocument();
    if (!session || session.exporting) return;
    const eventName = typeof event === 'string' ? event : event?.event;
    reportStatus(session, 'dirty');
    if (session.syncMode === 'live' || eventName === 'save') {
      scheduleExport(session, eventName === 'save' ? 100 : Math.max(300, session.liveSyncDelayMs));
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  $('#syncNow').addEventListener('click', () => {
    const session = sessionForActiveDocument() ?? [...sessions.values()][0];
    if (session) void exportSession(session);
  });
  installDocumentListeners();
  renderSessions();
  connect();
  setInterval(() => send({ type: 'heartbeat' }), 10_000);
});
