const textureMapPrompt = `【绝对第一优先级：轮廓配准】

只编辑图一，不重新生成物体。

最终物体的外轮廓、剪影像素边界、位置、尺寸、比例、朝向、相机和透视，必须与图一的白模完全一致。

图一白模的每一个外轮廓转折点、低模折角、凹凸、开口、孔洞、鞋头、靴筒、鞋底和鞋跟边界，都必须保持在完全相同的像素坐标。

不得移动、缩放、旋转、拉伸、变形、平滑、圆润化、美化、补全或重新塑造白模轮廓。不得让轮廓向图二靠拢。

如果轮廓一致与材质自然度、参考图相似度或细节表现发生冲突，必须牺牲材质和细节，优先保证图一轮廓完全不变。

先复制图一的画布、背景和物体剪影，再仅在该剪影内部补全材质。所有生成内容必须严格限制在图一原始白模轮廓内部，不得向外溢出，也不得向内收缩。

【内部材质】

只修改图一中的白色、浅灰色、Clay、Primer或无纹理区域。

图一中已经具有材质的区域必须保留原始颜色、纹理、光影和细节，不得重绘、调色、重新照明、锐化或模糊。

图二只提供材质外观，包括Base Color、颜色变化、纹理颗粒、纹理尺度、粗糙度观感和自然磨损。图二不提供几何、轮廓、位置、比例、相机、构图或光照。

不得复制图二的外形，不得使用图二重建物体。

白模内部的三角面灰度、多边形色块、硬法线明暗和Flat Shading不是材质。不要按照这些模型面分块着色。

在固定不变的白模轮廓内部，生成自然、柔和、连续的材质，使颜色和纹理跨越三角面平滑延续，不出现棱角色块、折面明暗、接缝、白边、光晕或亮度突变。

“内部平滑”只表示材质连续，绝不表示可以平滑或改变外轮廓。

【最终检查】

输出前必须确认：

1. 外轮廓与图一白模逐像素对齐。
2. 物体包围框、位置和尺寸与图一一致。
3. 背景和白模外区域保持图一原样。
4. 只有白模内部被填入图二的自然材质。
5. 内部没有三角面或Flat Shading色块。
6. 不输出额外视图、额外物体或重新构图的结果。`;

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
