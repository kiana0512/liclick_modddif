# 原局部重绘模型轮廓内缩 3px

- 主模块 M08，协作 M04/M06/M07/M12；ALG-LR-013 v1.2.0，结果 metadata 版本 2。
- 用户要求把 2K 时 2 像素改为 3 像素。半径为 `max(1, round(3 * longestEdge / 2048))`，1K/2K/4K 分别为 2/3/6px。
- 仅原 ModelView/Klein 局部重绘返图按冻结 depth coverage 腐蚀；内部孔洞相应扩大。细于腐蚀直径的部件可能被完全裁掉，保持既有 fail-closed 覆盖约束，不补救扩张。
- GPT 继续原样保留远端 RGBA。原始作者蒙版、16px@2K 内向渐变、提交蒙版外扩、像素 RGB、完整画布、相机及输出分辨率不变。

## 一致性与兼容

- 只有 CPU 返图准备阶段改变 alpha；GPU、shader、UV rasterizer、Worker PNG、合并与 export 沿用既有 `ignoreSourceAlpha=false` 传递裁后 alpha 的路径，无额外腐蚀。
- 新结果使用 `modelSilhouetteClipVersion=2` 与 `model-silhouette-inset-v2`，alpha 判断同时识别历史 v1 和新 v2，冷恢复不重复处理已裁任务。
- 保存的旧结果与已有图层不会自动重算，无 Schema/Project Command/CAS/ownership/verified assets 改动，无数据迁移。

## 验证与回滚

- 定向回归覆盖 3px 外轮廓/孔洞、512/1K/2K/4K 缩放、RGB 与输入不变、尺寸不符/空轮廓失败、细几何、投影/保存/恢复/合并/export alpha 契约。
- GPT 回归覆盖跳过内缩、旧 v1/新 v2 结果识别与恢复幂等；内向渐变单独回归，确保不改变。
- 未进行真实付费生成；截图中的黑边是否消失需要真实结果验收，不由参数测试推断。
- 回滚半径至 2px@2K 并恢复新写入版本为 v1 时，仍须保留对 v2 的 alpha 识别，避免已保存的新结果被忽略透明度。已生成资产不自动恢复，原始远端结果仍保留。
- 本次未推送或部署。
