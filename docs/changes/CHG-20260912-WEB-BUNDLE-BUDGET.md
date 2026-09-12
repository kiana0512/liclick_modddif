# CHG-20260912-WEB-BUNDLE-BUDGET

## 范围与版本

- 主模块：M15 构建、CI/CD 与发布门禁。
- 协作模块：M04 生成流程、M07 UV 常驻显示、M08 局部重绘与画笔。
- 构建算法版本：`WEB-BUNDLE-BUDGET` v1.0.0、`SHADER-TEMPLATE-FORMAT` v1.2.0。
- 关联算法保持：`UV-DISPLAY-MASK-WORKER` v1.1.0、`ALG-LR-UV-PAINT` v1.1.4、`PERF-UV-SOURCE-PREPARE-001` v1.6.0。

## 问题

本次功能提交与远端 master 的 GPT、着色器变更 rebase 后，正式 Cloud Web 构建总 JavaScript 为 `3,223,880 / 3,222,000` 字节，超出原门禁 `1,880` 字节。单纯提高预算会掩盖持续增长，也无法证明新增后台常驻、UV Worker、图层 LRU 和画笔缓存的实现没有携带重复控制流，因此不调整门禁。

## 修改

1. Preview Bitmap 主线程把 decode/adopt/mask adopt 的 pending、超时和 Worker 投递收敛为一个请求入口，把两种 Worker-backed DataTexture 的所有权和 dispose 发布收敛为一个入口。
2. Preview Bitmap Worker 用一个带类型判别的 resident source Map 同时持有 ImageBitmap 与一字节 mask，共用替换、释放和 ready 回帖；4K mask 仍只按当前上传条带展开 RGBA。
3. `GeneratePanel` 对已被静态依赖包含的 `resultAlphaPolicy` 移除无效动态导入；代码分块与实际加载时机不再携带冗余运行时包装。
4. UV 画笔投影包围盒使用 `[left, top, right, bottom]` 紧凑元组，图层 A/B resolved LRU 使用 `[result, bytes]` 元组；命中数学、淘汰顺序和硬显存预算不变。
5. 生产构建的 shader 去缩进白名单扩展到 resident quality、runtime depth、capture depth/normal、UV repaint、selection mask 与 Comfy 控制图导出七个实际模块。转换只删除模板物理换行后的空格/制表符；测试对转换前后 TypeScript/GLSL token、换行、插值分隔符逐项等价，并确认受影响模板具有 GLSL 标志。普通 UI、外部依赖和未打包 PreviewCompositor 不参与转换。

## 结果与验证

- release 环境正式 Web 总 JavaScript：`3,223,880` → `3,221,157` 字节；普通本地生产构建为 `3,220,689` 字节。
- 原门禁：`3,222,000` 字节，不变；以更严格的 release 环境统计，最终余量 `843` 字节。
- Shader 格式测试确认受控模块合计移除 `12,368` 字节源缩进；由于共享模块、压缩和分块关系，最终产物只按正式预算脚本统计，不把源字节等同产物收益。
- Resident UV Worker 测试逐字节验证 Y 翻转、`R=mask/G=0/B=0/A=255`、条带化和释放；GPT 多视图顺序、原生 UV 重绘及 TypeScript 专项回归通过。
- 最终合入必须继续通过 `pnpm verify:prepush`，包括 lint、生产构建、Cloud artifact、全 Web 回归和包体门禁。

## 不变项

- 不提高任何 bundle budget，不降低 1K/2K/4K 分辨率，不关闭 QA、Top-K、接缝、补边或 Resident UV 屏障。
- 不改变 GPU/CPU/Worker/shader 的像素公式、图层顺序、眼睛状态、鼠标交互、持久化和导出结果。
- 不改变 Project Command 幂等性、Revision CAS、ownership、verified object assets 或生产 Cloud 边界。

## 迁移与回滚

无 Schema、项目数据、对象资产或缓存持久化迁移。回滚时先恢复本变更前的 Worker/调用端重复入口、对象结构与局部重绘动态导入，再从 `shader-template-format.mjs` 删除本次新增七个白名单；不得通过提高预算、降低分辨率或跳过 QA 作为回滚替代方案。
