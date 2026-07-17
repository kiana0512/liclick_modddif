#target photoshop

function liclickJsonString(value) {
  return '"' + String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t') + '"';
}

function liclickResult(value) {
  if (value === null || typeof value === 'undefined') return 'null';
  if (typeof value === 'string') return liclickJsonString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Array) {
    var items = [];
    for (var itemIndex = 0; itemIndex < value.length; itemIndex += 1) {
      items.push(liclickResult(value[itemIndex]));
    }
    return '[' + items.join(',') + ']';
  }
  var properties = [];
  for (var key in value) {
    if (value.hasOwnProperty && !value.hasOwnProperty(key)) continue;
    properties.push(liclickJsonString(key) + ':' + liclickResult(value[key]));
  }
  return '{' + properties.join(',') + '}';
}

function liclickError(error) {
  var message = error && error.message ? error.message : String(error);
  if (error && error.line) message += '（第 ' + error.line + ' 行）';
  return liclickResult({ ok: false, error: message });
}

function liclickFindDocument(documentName, documentPath) {
  var requestedPath = documentPath ? new File(documentPath).fsName.toLowerCase() : '';
  for (var index = 0; index < app.documents.length; index += 1) {
    var document = app.documents[index];
    if (requestedPath) {
      try {
        if (document.fullName.fsName.toLowerCase() === requestedPath) return document;
      } catch (error) {}
    }
    if (documentName && document.name === documentName) return document;
  }
  return null;
}

function liclickDocumentState(document) {
  var historyLength = 0;
  var historyName = '';
  try { historyLength = document.historyStates.length; } catch (error) {}
  try { historyName = document.activeHistoryState.name; } catch (error) {}
  return {
    ok: true,
    exists: true,
    documentName: document.name,
    documentPath: document.fullName.fsName,
    historyLength: historyLength,
    historyName: historyName
  };
}

function liclickOpenSession(sourcePath, workingDocumentPath, layerName) {
  try {
    var existing = liclickFindDocument('', workingDocumentPath);
    if (existing) {
      app.activeDocument = existing;
      return liclickResult(liclickDocumentState(existing));
    }
    var workingFile = new File(workingDocumentPath);
    var document;
    if (workingFile.exists) {
      document = app.open(workingFile);
    } else {
      var sourceFile = new File(sourcePath);
      if (!sourceFile.exists) throw new Error('LIclick 源图像不存在：' + sourcePath);
      document = app.open(sourceFile);
      var saveOptions = new PhotoshopSaveOptions();
      saveOptions.layers = true;
      saveOptions.embedColorProfile = true;
      document.saveAs(workingFile, saveOptions, false, Extension.LOWERCASE);
      var editLayer = document.artLayers.add();
      editLayer.name = 'LIclick 编辑';
      document.activeLayer = editLayer;
      document.save();
    }
    app.activeDocument = document;
    return liclickResult(liclickDocumentState(document));
  } catch (error) {
    return liclickError(error);
  }
}

function liclickGetSessionState(documentName, documentPath) {
  try {
    var document = liclickFindDocument(documentName, documentPath);
    if (!document) return liclickResult({ ok: true, exists: false });
    return liclickResult(liclickDocumentState(document));
  } catch (error) {
    return liclickError(error);
  }
}

function liclickExportSession(documentName, documentPath, outputPath) {
  var previousDialogs = app.displayDialogs;
  try {
    var document = liclickFindDocument(documentName, documentPath);
    if (!document) throw new Error('LIclick 工作文档已关闭。');
    var outputFile = new File(outputPath);
    var options = new PNGSaveOptions();
    options.compression = 0;
    options.interlaced = false;
    app.displayDialogs = DialogModes.NO;
    document.saveAs(outputFile, options, true, Extension.LOWERCASE);
    app.activeDocument = document;
    return liclickResult({ ok: true, outputPath: outputFile.fsName });
  } catch (error) {
    return liclickError(error);
  } finally {
    app.displayDialogs = previousDialogs;
  }
}
