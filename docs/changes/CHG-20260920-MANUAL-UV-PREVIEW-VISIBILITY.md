# 手动 UV 局部重绘多层显隐

## 范围与版本

- 主模块 M06，协作 M07/M08；UV-REPAINT-PREVIEW-BINDING v1.0.0 → v1.0.1。
- 症状：UUID、无特殊 role 的手动重绘层分别可见，同时显示时下层消失；PNG 组合切换可能残留旧层。
- 不更改用户图层、生成、蒙版、分辨率或源像素。

## 原因与修复

1. 首帧识别 live UV 顶层，显隐订阅和延迟发布却只识别旧 local-repaint role；现在共同调用 uvPreviewStack，顶层只取一层，所有其余可见 UV 组成下层。
2. 单层快速路径必须匹配实际下层，不能把已经占用顶层采样器的手动层重复选为普通 UV。
3. live URL 不可由 HTMLImageElement 解码；预热跳过它，绑定从运行时所有者借用，不上传/释放借用纹理。
4. 含 live 输入的静态组合缓存不复用；全部显示预热明确检查结果 ready，避免旧组合在新 key 下被登记。图片化后的普通 UV 眼睛操作同样通知异步组合所有者，防止晚到结果覆盖新状态。

## 对等路径审计

- GPU/CPU/Worker：继续使用原纹理、Worker 合成及 CPU fallback；仅修正输入集合、缓存准入与发布时机。
- Shader：采样、透明度和色彩计算公式不变；仅统一提供纹理和有效 opacity。
- 保存、历史、UV 合并、导出：仍使用既有作者 UV 数据；未改资产、Schema、Command、CAS、ownership、verified asset 协议。
- 无历史迁移。回滚本次显示模块及测试即可，保留用户全部资产。

## 验证

- 浏览器隔离回归 run-uv-preview-visibility-browser.mjs：真实 ViewportCanvas，普通 UUID/no-role 层；2/3 层，live Canvas/保存 PNG，叠加 UV 底图，反复检查单开、全开、全关的实际 WebGL 像素（48 次转换）。不访问用户工程，不发真实生成。
- 同一脚本使用 UV_REPAINT_BASELINE=5c155f73 可验证旧版双层全开缺失下层，并复现运行时 URL 图片解码失败。
- projected-layer-visibility 单元回归覆盖共享顶层选择、投射层相对顺序、旧 role、空栈及迟到发布；另执行 resident-uv-visibility-scheduling 和类型检查。
- 隔离纯平面投射烘焙 fixture 不具备真实模型资产/深度输入，未将其无覆盖 QA 失败当作显示验证通过；此脚本只验证已有 UV 底图的显示绑定。用户自行打开的在线工程未刷新、未修改。
- 既有 run-manual-repaint-browser.mjs 在本次改动前后均有第二次生成后像素清空的独立失败，未绕过其断言或宣称通过；本次针对已存在图层的显隐回归独立验证。

## 发布

用户已授权推送 master 并部署 A100。发布前执行完整 verify:prepush，合入最新 master；A100 保留 runtime/工程数据，备份旧构建，检查空闲和健康状态。无数据库或资产迁移要求。
