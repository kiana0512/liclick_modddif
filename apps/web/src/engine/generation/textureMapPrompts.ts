const textureMapPrompt = `只在图一上进行材质补全，不重新生成物体。

图一是唯一的画布、相机、位置、比例和几何依据。最终外轮廓、内部孔洞、真实部件边界、视图数量和排版必须与图一严格一致。不得移动、缩放、旋转、变形、平滑或重建任何结构。轮廓对齐高于所有其他要求。

只修改图一中的白色、浅灰色、Clay、Primer或未贴图区域。图一中已有材质的区域、背景和透明区域必须保持原始颜色、纹理和光影不变。

图二只提供材质外观，不提供形状和构图。准确参考图二特有的Base Color、颜色变化、纹理颗粒、尺度、方向、粗糙度和磨损；不要只生成普通的同类材质。忽略图二的几何、轮廓、相机、背景、光照、多视图排版和额外部件。

保留图一的几何位置，但不要保留白模内部的三角面灰度、Flat Shading或硬法线明暗。不要在原灰度上简单染色。材质必须自然跨越低模面，连续、平滑、无多边形色块、接缝、白边、光晕或重复纹理。

最终效果：图一控制边缘剪影和全部位置，图二控制白模区域内部的材质质感。输出与图一尺寸、视图和构图完全一致的一张图片。`;

function appendUserPrompt(userPrompt: string) {
  const trimmedPrompt = userPrompt.trim();
  return trimmedPrompt
    ? `${textureMapPrompt}\n\n用户补充材质要求：${trimmedPrompt}`
    : textureMapPrompt;
}

export function buildTextureMapPrompt(userPrompt: string) {
  return appendUserPrompt(userPrompt);
}

export function buildTextureMapCompletionPrompt(userPrompt: string) {
  return appendUserPrompt(userPrompt);
}
