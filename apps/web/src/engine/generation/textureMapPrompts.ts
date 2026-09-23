// ALG-GEN-001/002 v1.3.1: shared scoped weak-light material completion.
const textureMapPrompt = `只在图一指定的待补全区域绘制材质，不重新生成物体。目标是接近平坦材质预览的效果：固有颜色明确、纹理清晰、光影较弱，而不是摄影级产品渲染。

一、严格保持图一的几何和构图
图一是唯一的画布、相机、位置、比例和几何依据。外轮廓、内部孔洞、零件边界、遮挡关系、视图数量和排版必须严格不变。不得移动、缩放、旋转、变形、平滑或重建结构。轮廓对齐优先于材质表现。

二、限定修改范围
只修改图一中的白模、Clay、Primer或指定待补全区域。已经贴好的纹理区域保持不变，不对整张图重新调色、打光或去光照。保留原有背景及透明区域，不向轮廓外扩展颜色。

三、参考材质，不复制光照
图二只提供材质固有颜色、颜色分区、纹理颗粒、图案、文字、锈迹、污渍、掉漆和磨损，不提供形状、构图或照明。
以图二中没有明显高光和阴影的区域作为材质底色依据。保留真实纹理和局部色差，不把高光、反射或大范围阴影复制成材质颜色。

四、弱化新生成区域的光影
同一材质在正面、侧面、曲面和折弯处保持接近的底色与亮度，不因朝向不同产生明显明暗分区。
不要沿用白模的灰度渐变、三角面明暗或硬法线色块，不在白模明暗上简单染色。
不要主动添加主光源、轮廓光、投射阴影、强烈环境遮蔽、边缘亮线或“凹处压黑、凸处提亮”的效果。
只允许非常轻微、局限于真实接触位置的结构明暗；不得扩展成宽暗带、黑角或大面积渐变。通过轮廓、遮挡和材质边界表达结构，不靠增强光影塑造体积。

五、金属和纹理细节
金属采用稳定的固有颜色、细微色差和真实磨损表达，不通过镜面反射、白色高光条或黑白光带增强金属感。
保留明确的掉漆、露底、锈迹与划痕；不要把真实浅色磨损误删为高光。
大块底色平坦，细节纹理清晰。不要模糊、磨皮、整体泛白、降低饱和度或改成卡通纯色色块。

最终输出与图一尺寸、位置、视图和构图完全一致的一张图片。允许材质显得平坦，不为追求摄影真实感重新添加强光影。`;

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
