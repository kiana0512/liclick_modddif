import * as THREE from 'three';

const FBX_BINARY_HEADER = 'Kaydara FBX Binary  ';

class BinaryFbxVisibilityReader {
  private readonly source: ArrayBuffer;
  private readonly view: DataView;
  private readonly decoder = new TextDecoder();
  private offset = 0;
  private readonly visibilityByModelId = new Map<number, number>();

  constructor(source: ArrayBuffer) {
    this.source = source;
    this.view = new DataView(source);
  }

  read() {
    if (this.source.byteLength < 27 || this.readStringAt(0, 20) !== FBX_BINARY_HEADER) {
      return this.visibilityByModelId;
    }
    this.offset = 23;
    const version = this.readUint32();
    const wideOffsets = version >= 7500;
    while (this.offset < this.source.byteLength) {
      if (!this.readNode(wideOffsets)) break;
    }
    return this.visibilityByModelId;
  }

  private readNode(wideOffsets: boolean, parentModelId?: number) {
    const headerSize = wideOffsets ? 25 : 13;
    if (this.offset + headerSize > this.source.byteLength) return false;

    const endOffset = wideOffsets ? this.readUint64() : this.readUint32();
    const propertyCount = wideOffsets ? this.readUint64() : this.readUint32();
    if (wideOffsets) this.readUint64();
    else this.readUint32();
    const nameLength = this.readUint8();
    if (endOffset === 0) return false;
    if (endOffset > this.source.byteLength || this.offset + nameLength > endOffset) {
      this.offset = this.source.byteLength;
      return false;
    }

    const name = this.readString(nameLength);
    const properties: unknown[] = [];
    for (let index = 0; index < propertyCount && this.offset < endOffset; index += 1) {
      properties.push(this.readProperty());
    }

    const modelId =
      name === 'Model' && typeof properties[0] === 'number' ? properties[0] : parentModelId;
    if (
      name === 'P' &&
      modelId !== undefined &&
      properties[0] === 'Visibility' &&
      typeof properties[4] === 'number'
    ) {
      this.visibilityByModelId.set(modelId, properties[4]);
    }

    while (this.offset < endOffset) {
      const beforeChild = this.offset;
      if (!this.readNode(wideOffsets, modelId)) break;
      if (this.offset <= beforeChild) break;
    }
    this.offset = endOffset;
    return true;
  }

  private readProperty(): unknown {
    if (this.offset >= this.source.byteLength) return undefined;
    const type = String.fromCharCode(this.readUint8());
    switch (type) {
      case 'C':
        return this.readUint8();
      case 'Y':
        return this.readInt16();
      case 'I':
        return this.readInt32();
      case 'F':
        return this.readFloat32();
      case 'D':
        return this.readFloat64();
      case 'L':
        return this.readInt64();
      case 'S':
        return this.readString(this.readUint32());
      case 'R':
        this.offset += this.readUint32();
        return undefined;
      case 'b':
      case 'c':
      case 'd':
      case 'f':
      case 'i':
      case 'l': {
        this.readUint32();
        this.readUint32();
        this.offset += this.readUint32();
        return undefined;
      }
      default:
        this.offset = this.source.byteLength;
        return undefined;
    }
  }

  private readStringAt(offset: number, length: number) {
    return this.decoder.decode(new Uint8Array(this.source, offset, length));
  }

  private readString(length: number) {
    const safeLength = Math.max(0, Math.min(length, this.source.byteLength - this.offset));
    const value = this.readStringAt(this.offset, safeLength);
    this.offset += safeLength;
    return value;
  }

  private readUint8() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  private readInt16() {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  private readUint32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  private readInt32() {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  private readUint64() {
    const value = Number(this.view.getBigUint64(this.offset, true));
    this.offset += 8;
    return value;
  }

  private readInt64() {
    const value = Number(this.view.getBigInt64(this.offset, true));
    this.offset += 8;
    return value;
  }

  private readFloat32() {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  private readFloat64() {
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }
}

function findClosingBrace(source: string, openBrace: number) {
  let depth = 0;
  let quoted = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' && source[index - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

function readAsciiFbxVisibility(source: ArrayBuffer) {
  const text = new TextDecoder().decode(source);
  const visibilityByModelId = new Map<number, number>();
  const modelPattern = /Model:\s*(-?\d+)\s*,[^{]*\{/g;
  for (let match = modelPattern.exec(text); match; match = modelPattern.exec(text)) {
    const openBrace = text.indexOf('{', match.index);
    const closeBrace = findClosingBrace(text, openBrace);
    const body = text.slice(openBrace + 1, closeBrace);
    const visibility = body.match(
      /P:\s*"Visibility"\s*,\s*"Visibility"\s*,\s*""\s*,\s*"[^"\r\n]*"\s*,\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/,
    );
    if (visibility) visibilityByModelId.set(Number(match[1]), Number(visibility[1]));
    modelPattern.lastIndex = closeBrace + 1;
  }
  return visibilityByModelId;
}

export function readFbxModelVisibility(source: ArrayBuffer) {
  const header = new TextDecoder().decode(new Uint8Array(source, 0, Math.min(20, source.byteLength)));
  if (header === FBX_BINARY_HEADER) return new BinaryFbxVisibilityReader(source).read();
  return readAsciiFbxVisibility(source);
}

export function applyFbxModelVisibility(root: THREE.Object3D, source: ArrayBuffer) {
  const visibilityByModelId = readFbxModelVisibility(source);
  let hiddenObjectCount = 0;
  root.traverse((object) => {
    const modelId = (object as THREE.Object3D & { ID?: number }).ID;
    if (modelId === undefined) return;
    const visibility = visibilityByModelId.get(modelId);
    if (visibility === undefined) return;
    object.visible = visibility > 0;
    if (!object.visible) hiddenObjectCount += 1;
  });
  return hiddenObjectCount;
}
