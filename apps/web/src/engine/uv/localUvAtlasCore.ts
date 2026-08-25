import * as watlas from 'watlas';

export type LocalUvAtlasInputMesh = {
  positions: Float32Array;
  indices: Uint32Array;
};

export type LocalUvAtlasOutputMesh = {
  indices: Uint32Array;
  vertexXrefs: Uint32Array;
  uvs: Float32Array;
};

export type LocalUvAtlasResult = {
  width: number;
  height: number;
  chartCount: number;
  utilization: number;
  meshes: LocalUvAtlasOutputMesh[];
};

let initialization: Promise<void> | undefined;

function initializeWatlas() {
  initialization ??= watlas.Initialize();
  return initialization;
}

export async function generateLocalUvAtlas(
  meshes: LocalUvAtlasInputMesh[],
  options: { resolution: number; padding: number },
): Promise<LocalUvAtlasResult> {
  if (!meshes.length) throw new Error('模型中没有可展开的三角网格。');
  await initializeWatlas();
  const atlas = new watlas.Atlas();
  try {
    meshes.forEach((mesh) => {
      if (mesh.positions.length % 3 !== 0 || mesh.indices.length % 3 !== 0) {
        throw new Error('本地 UV 输入包含无效三角网格。');
      }
      atlas.addMesh({
        vertexPositionData: mesh.positions,
        vertexCount: mesh.positions.length / 3,
        vertexPositionStride: 12,
        indexData: mesh.indices,
        indexCount: mesh.indices.length,
      });
    });
    atlas.generate(
      { fixWinding: true },
      {
        resolution: options.resolution,
        padding: options.padding,
        bilinear: true,
        blockAlign: false,
        bruteForce: false,
        rotateCharts: true,
        rotateChartsToAxis: true,
      },
    );
    if (atlas.atlasCount !== 1) {
      throw new Error(`模型需要 ${atlas.atlasCount} 个 UV Atlas，当前项目仅支持单 Atlas。`);
    }
    const utilizationValues = new Float32Array(atlas.atlasCount);
    atlas.getUtilization(utilizationValues);
    const outputs: LocalUvAtlasOutputMesh[] = [];
    for (let meshIndex = 0; meshIndex < atlas.meshCount; meshIndex += 1) {
      const mesh = atlas.getMesh(meshIndex);
      const indices = new Uint32Array(mesh.indexCount);
      mesh.getIndexArray(indices);
      const vertexXrefs = new Uint32Array(mesh.vertexCount);
      const uvs = new Float32Array(mesh.vertexCount * 2);
      for (let vertexIndex = 0; vertexIndex < mesh.vertexCount; vertexIndex += 1) {
        const vertex = mesh.getVertex(vertexIndex);
        vertexXrefs[vertexIndex] = vertex.xref;
        uvs[vertexIndex * 2] = vertex.uv[0] / atlas.width;
        uvs[vertexIndex * 2 + 1] = vertex.uv[1] / atlas.height;
      }
      outputs.push({ indices, vertexXrefs, uvs });
    }
    return {
      width: atlas.width,
      height: atlas.height,
      chartCount: atlas.chartCount,
      utilization: utilizationValues[0] ?? 0,
      meshes: outputs,
    };
  } finally {
    atlas.delete();
  }
}
