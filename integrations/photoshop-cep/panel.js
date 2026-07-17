(function () {
  'use strict';

  var BRIDGE_URLS = [
    'ws://127.0.0.1:4617/api/photoshop/socket?role=plugin',
    'ws://127.0.0.1:4517/api/photoshop/socket?role=plugin'
  ];
  var bridgeIndex = 0;
  var PLUGIN_VERSION = 'cep-1.1.0';
  var sessions = {};
  var socket;
  var reconnectTimer;
  var reconnectAttempt = 0;
  var pollBusy = false;
  var exportCounter = 0;

  function element(id) { return document.getElementById(id); }
  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function jsxString(value) {
    return JSON.stringify(value == null ? '' : String(value));
  }

  function evalScript(functionName, args) {
    return new Promise(function (resolve, reject) {
      var source = functionName + '(' + (args || []).map(jsxString).join(',') + ')';
      window.__adobe_cep__.evalScript(source, function (result) {
        if (!result || result === 'EvalScript error.') {
          reject(new Error('Photoshop 脚本执行失败（' + functionName + '）。'));
          return;
        }
        try {
          var parsed = JSON.parse(result);
          if (parsed && parsed.ok === false) reject(new Error(parsed.error || 'Photoshop 脚本执行失败。'));
          else resolve(parsed);
        } catch (error) {
          reject(new Error(String(result)));
        }
      });
    });
  }

  function setConnection(tone, status, copy) {
    element('connectionDot').setAttribute('data-tone', tone);
    element('connectionStatus').textContent = status;
    element('connectionCopy').textContent = copy;
  }

  function labelForStatus(status) {
    var labels = {
      opening: '正在打开 LIclick 图层', ready: '已连接', dirty: '等待同步',
      syncing: '正在同步', synced: '已同步', error: '同步异常'
    };
    return labels[status] || status;
  }

  function renderSessions() {
    var list = element('sessionList');
    var values = Object.keys(sessions).map(function (id) { return sessions[id]; });
    list.innerHTML = '';
    element('emptyState').style.display = values.length ? 'none' : 'block';
    element('syncNow').disabled = !values.length || !socket || socket.readyState !== WebSocket.OPEN;
    values.forEach(function (session) {
      var card = document.createElement('article');
      card.className = 'session-card';
      var name = document.createElement('strong');
      name.textContent = session.layerName;
      var meta = document.createElement('div');
      meta.className = 'session-meta';
      var type = document.createElement('span');
      type.textContent = session.layerType === 'uv' ? 'UV 图层' : '投影图层';
      var status = document.createElement('span');
      status.textContent = labelForStatus(session.status);
      meta.appendChild(type);
      meta.appendChild(status);
      card.appendChild(name);
      card.appendChild(meta);
      if (session.error) {
        var error = document.createElement('p');
        error.className = 'session-error';
        error.textContent = session.error;
        card.appendChild(error);
      }
      list.appendChild(card);
    });
  }

  function updateSession(session, patch) {
    Object.keys(patch || {}).forEach(function (key) { session[key] = patch[key]; });
    sessions[session.id] = session;
    renderSessions();
  }

  function reportStatus(session, status, error) {
    updateSession(session, { status: status, error: error });
    var message = { type: 'session-status', sessionId: session.id, status: status };
    if (error) message.error = error;
    send(message);
  }

  function openSession(payload) {
    var existing = sessions[payload.id];
    if (existing && existing.opening) return;
    var session = existing || payload;
    updateSession(session, { status: 'opening', opening: true, exporting: false });
    reportStatus(session, 'opening');
    evalScript('liclickOpenSession', [
      session.sourcePath,
      session.workingDocumentPath,
      session.layerName
    ]).then(function (result) {
      updateSession(session, {
        opening: false,
        documentName: result.documentName,
        documentPath: result.documentPath,
        historyLength: result.historyLength,
        historyName: result.historyName,
        status: 'ready'
      });
      reportStatus(session, 'ready');
    }).catch(function (error) {
      updateSession(session, { opening: false });
      reportStatus(session, 'error', error.message || String(error));
    });
  }

  function scheduleExport(session, delay) {
    if (session.syncMode !== 'live' || session.exporting) return;
    clearTimeout(session.exportTimer);
    session.exportTimer = setTimeout(function () { exportSession(session); }, delay);
  }

  function exportSession(session) {
    if (!session || session.exporting || !session.documentName) return;
    session.exporting = true;
    clearTimeout(session.exportTimer);
    reportStatus(session, 'syncing');
    var startedAt = Date.now();
    var filename = 'rev-' + Date.now().toString(36) + '-' + (++exportCounter).toString(36) + '.png';
    var outputPath = session.revisionsDirectory.replace(/[\\/]$/, '') + '\\' + filename;
    evalScript('liclickExportSession', [
      session.documentName,
      session.documentPath,
      outputPath
    ]).then(function () {
      session.exporting = false;
      reportStatus(session, 'synced');
      element('lastSync').textContent = '同步 ' + (Date.now() - startedAt) + 'ms';
      send({ type: 'session-exported', sessionId: session.id, filename: filename });
    }).catch(function (error) {
      session.exporting = false;
      reportStatus(session, 'error', error.message || String(error));
    });
  }

  function closeSession(sessionId) {
    var session = sessions[sessionId];
    if (!session) return;
    clearTimeout(session.exportTimer);
    delete sessions[sessionId];
    renderSessions();
  }

  function pollSessions() {
    if (pollBusy) return;
    var values = Object.keys(sessions).map(function (id) { return sessions[id]; });
    if (!values.length) return;
    pollBusy = true;
    var index = 0;
    function next() {
      if (index >= values.length) {
        pollBusy = false;
        return;
      }
      var session = values[index++];
      if (session.opening || session.exporting || !session.documentName) {
        next();
        return;
      }
      evalScript('liclickGetSessionState', [
        session.documentName,
        session.documentPath
      ]).then(function (state) {
        if (!state.exists) {
          reportStatus(session, 'error', 'LIclick 工作文档已关闭。');
          next();
          return;
        }
        var changed = state.historyLength !== session.historyLength || state.historyName !== session.historyName;
        session.historyLength = state.historyLength;
        session.historyName = state.historyName;
        if (changed) {
          reportStatus(session, 'dirty');
          scheduleExport(session, Math.max(80, session.liveSyncDelayMs || 120));
        }
        next();
      }).catch(function () { next(); });
    }
    next();
  }

  function handleMessage(event) {
    var message;
    try { message = JSON.parse(String(event.data)); } catch (error) { return; }
    if (message.type === 'hello-ack') {
      setConnection('online', '已连接', 'Photoshop 与 LIclick 通过本机回环网络连接。');
      renderSessions();
    } else if (message.type === 'open-session') {
      openSession(message.session);
    } else if (message.type === 'sync-now') {
      exportSession(sessions[message.sessionId]);
    } else if (message.type === 'close-session') {
      closeSession(message.sessionId);
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    setConnection('error', '等待工作区', '启动 LIclick 后将自动重新连接。');
    var delay = Math.min(10000, 500 * Math.pow(2, Math.min(reconnectAttempt++, 5)));
    reconnectTimer = setTimeout(function () { reconnectTimer = undefined; connect(); }, delay);
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    setConnection('starting', '连接中', '正在连接 LIclick 本地工作区…');
    try { socket = new WebSocket(BRIDGE_URLS[bridgeIndex]); } catch (error) { scheduleReconnect(); return; }
    socket.onopen = function () {
      reconnectAttempt = 0;
      send({ type: 'hello', protocolVersion: '1.0.0', pluginVersion: PLUGIN_VERSION, photoshopVersion: '25.x CEP' });
    };
    socket.onmessage = handleMessage;
    socket.onclose = function () {
      bridgeIndex = (bridgeIndex + 1) % BRIDGE_URLS.length;
      scheduleReconnect();
    };
    socket.onerror = scheduleReconnect;
  }

  element('syncNow').addEventListener('click', function () {
    var ids = Object.keys(sessions);
    if (ids.length) exportSession(sessions[ids[0]]);
  });
  renderSessions();
  connect();
  setInterval(function () { send({ type: 'heartbeat' }); }, 10000);
  setInterval(pollSessions, 100);
})();
