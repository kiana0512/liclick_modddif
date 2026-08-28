# CHG-20260827-LOCAL-REPAINT-ACTIVATION-PUBLISH-PERSISTENCE

> 状态：Verified
> Owner：LI3D Texture
> Reviewer：CI/CD + 业务人工验收
> 日期：2026-08-27
> 分支：`main`
> 基线 commit：`216d36fabf746cf7e262add001a9cab168817067`
> 合并云端 commit：`b9ca6dbcf9acebe69ceb6b1ebb515b430d624244`
> 本地修复 commit：`7d1e7bb8386849e1244175ec70db13a353e49544`
> 合并契约对齐 commit：`f993f29f08c3`
> 发布分包优化 commit：`95a7473`
> 最终 commit/tag：本次发布提交

## 1. 问题与证据

- 实际现象：首次或第二次局部重绘后，按钮 3 可能需要点击两次才能出现圆形画笔；重复重绘越多，预热与按钮 2 保存越慢；停笔后右侧局部重绘图层晚约 3 秒出现；部分已保存图层恢复后不可见或被实时 overlay 重复投影到底面。
- 期望结果：按钮 3 单击后完成必要 GPU/深度预热并进入可绘制态；停笔后两帧内显示完整图层行；保存继续后台合并且不重复上传同一工作区资产；有序图层栈与实时 overlay 只有一个显示所有者。
- 复现步骤：按钮 1 绘制蒙版 → 按钮 2 生图 → 按钮 3 绘制 → 再次按钮 1/2/3；观察第二次按钮 3 光标、停笔后的图层行与连续保存耗时。
- 证据：业务录屏与浏览器人工复现确认第二次点击失效；源码确认 `waitForPaintCommitIdle` 的 3000ms 空闲等待位于 `setLayers` 之前；本地工作区确认同一 image/depth 曾被自动保存重复上传。

## 2. 范围

- 变更等级：L2 / Minor（兼容的时序与持久化性能语义调整）
- 主模块 ID：`M08` 局部重绘，`UI-10` 底部工具条
- 影响模块 ID：`M04` 生成编排、`M05/M06` 投影预览、`M12/M14` 项目保存与对象资产
- 算法 ID：`ALG-LR-007` v2.0.1、`ALG-LR-008` v2.1.0；合并 `b9ca6dbc` 的有序栈显示所有权门禁
- 修改文件：`GeneratePanel.tsx`、`EditorPage.tsx`、`ViewportCanvas.tsx`、投影材质/预览合成器、`workspaceApiClient.ts` 及局部重绘回归测试
- 明确不做：不降低 1K/2K/4K/8K 输出；不关闭 depth/visibility QA；不改变投影矩阵、face-on 阈值、颜色公式、UV merge 或生产服务；不恢复 Windows 本地组件。

## 3. 当前契约与根因

- 当前输入：Generation 的 durable source/raw/mask/depth、冻结 camera/object matrix、用户 live coverage mask 与当前项目 Revision。
- 当前算法/状态转换：按钮 3 将 source/depth/shader/overlay 预热后进入 `inpaint-apply`；停笔将 live mask 发布为 projected layer，再由自动保存提交 verified assets 与 Project Command。
- 当前输出：可见 projected local repaint layer，`localRepaintMaskUrl`、`maskUrl`、depth/camera/matrix、`needsRebake=true`。
- 根因：第二次任务的异步 background stage 会因自身 layer/project 更新取消；重复 shader/depth/source 准备扩大预热窗口；停笔发布被错误放在 3000ms persistence idle 之后；项目内 `assets/...` 未识别为 durable，自动保存重复上传；renderer overlay 的复用/重绑/pointer-down 分支未全部检查 ordered-stack ownership。

## 4. 方案

- 按 capture revision 缓存并复用 source/depth/shader program；background stage 使用稳定依赖与 latest-wins 修订门禁，避免自取消。
- 按钮 2 的项目保存与相互独立的 capture/reference/depth 准备并行；最终以权威 capture 集合执行一次 CAS 保存。
- 停笔完成 live mask 后让出两个 animation frame，立即向 Layer Store 发布完整权威图层行；3000ms idle 保留给 latest-wins 后台保存合并，不阻塞 LayersPanel。
- 本地集成工作区内项目相对 `assets/...` 视为已验证 durable URL，禁止再次上传同一 image/depth。
- 所有 GPU overlay 激活、program rebind 与 pointer-down 分支在 ordered projected stack 已拥有显示权时保持隐藏，阻止重复投影到底面。
- 图片异步解码继续有限重试；失败保留上一有效投影，不发布空层。
- 发布构建复用独立 `vendor-zod` 缓存分包并从 JS chunk 移除重复 license banner；`THIRD_PARTY_NOTICES.txt` 继续随云端制品发布，不放宽单 chunk 或总 bundle budget。
- 旧工程兼容：Layer/Capture/Generation/Project Schema 不变；旧项目重开时惰性重建 runtime cache，不批量改写 Revision。
- 数据或版本升级：算法 Minor/Patch；无 Schema、Workspace 或数据库迁移。

## 5. GPU、CPU、Worker、Shader、持久化与导出审计

- GPU：复用同 source revision 的 linear-view depth、overlay geometry 和已链接 shader program；live overlay 与 ordered projected stack 互斥显示。
- CPU/Worker：未修改 UV raster、mask worker、seam harmonization 或合成公式；仅调整调度与异步重试。
- Shader：未修改 projector matrix、depth encoding、normal/facing/edge 阈值和 sampler 语义。
- 持久化：仍使用 Project Command v1、Revision CAS、ownership 和 verified asset；权威 captures 在完成保存前重新合并，避免自动保存竞争覆盖。
- 导出：仍消费相同 `imageUrl + maskUrl + localRepaintMaskUrl + depth/camera/matrix`；GLB/纹理/UV merge 路径无格式变化。

## 6. 风险、迁移与回退

- 主要风险：立即 `setLayers` 可能触发重复渲染；通过 live overlay/ordered stack 显示权门禁和两帧 pen-up handoff 隔离。
- 性能/显存/内存影响：减少重复 shader/depth/image 准备与资产上传；不增加纹理尺寸或长期 GPU 驻留上限。
- 迁移：无数据迁移；旧项目与旧资产原样可读，首次进入局部重绘时重建 runtime cache。
- 回退：回退本次修复提交并恢复 `setLayers` 位于 idle wait 之后即可；保留已生成 Layer/Generation/Capture/Revision 和对象资产，禁止删除用户项目。回退 `b9ca6dbc` 时只移除 ordered-stack ownership 保护，不改写数据。
- 回退后数据兼容：兼容；新增内容未写入新字段。

## 7. 验证

| 验证项 | 修改前 | 修改后 | 结果 |
|---|---|---|---|
| 按钮 3 二次激活 | 常需重复点击 | 单击进入预热/绘制态 | 通过定向回归，待业务最终验收 |
| 停笔图层行 | 等待约 3000ms | 两帧后立即发布，后台保存独立 | 通过源码顺序门禁与构建 |
| 多局部重绘图层 | 存在隐藏/重复到底面 | ordered stack 与 live overlay 单一所有者 | `test:local-repaint-ordered-composition` 通过 |
| 保存/重开 | 重复上传项目内资产 | `assets/...` durable 去重，CAS 不变 | 工作区上传回归通过 |
| 输出质量 | 不稳定时可能空层 | 分辨率、depth/visibility、export 语义不变 | 图层保留/合成回归通过 |

执行命令与结果：

```text
pnpm --filter @liclick/web typecheck                                      PASS
pnpm --filter @liclick/web test:local-repaint-performance-merge           PASS
pnpm --filter @liclick/web test:local-repaint-layer-retention             PASS
pnpm --filter @liclick/web test:local-repaint-result-composite            PASS
pnpm --filter @liclick/web test:local-repaint-ordered-composition         PASS
pnpm --filter @liclick/web test:regression                                PASS (67 contracts)
pnpm --filter @liclick/server test:regression                             PASS (9 contracts)
pnpm run lint                                                             PASS (warnings only)
pnpm run build:release                                                    PASS
pnpm run check:cloud-artifact                                             PASS
pnpm run check:web-bundle-budget                                          PASS (3,050,867 bytes)
GitLab CI contracts/typecheck/web/server/lint/build                        推送后核对
```

未覆盖项：生产 A100 多账号并发和业务素材的人工手感由本次发布后的验收继续确认，不以本地模拟器代替。

## 8. 文档与评审

- [x] 已更新唯一准则中的当前实现、算法版本和参数
- [x] 已更新 `CHANGELOG.md`
- [x] 已记录无 Schema/Workspace 迁移及可逆回退
- [x] 已审计 GPU、CPU、Worker、shader、持久化与导出对应路径
- [x] 已检查真实本地构建和定向回归
- [ ] GitLab CI/CD 全部通过

## 9. 结论

- 合并/发布决定：本地与云端最新修复合并后推送 `main`，以 GitLab CI/CD 绿灯为发布门禁。
- 遗留问题：业务方继续验证按钮 3 首次/二次手感与真实大项目保存耗时；若失败保留性能事件和项目 Revision，不覆盖用户数据。
- 关联：`CHG-20260826-LOCAL-REPAINT-STATUS-SYNC.md`、`ALG-LR-007/008`、`UI-10`。
