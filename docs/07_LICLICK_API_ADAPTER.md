# Liclick API Adapter

Liclick 相关请求不是单一“浏览器 -> 主服务”路径。当前前端根据登录/provider 状态选择两种 transport，并在专用 UI 编排层组合 Texture Map、Multiview 与 Local Repaint。

## Transport Selection

`apps/web/src/services/liclickTransport.ts` 当前支持：

- `atlas-workspace`：请求主 workspace service，`credentials='include'`，用于相应开发/兼容身份策略。
- `personal-local-component`：请求当前用户的 loopback local component（默认 `127.0.0.1:4618`），不使用主站 cookie，而是附加主服务签发的 local identity proof。

生产贴图流程的目标边界是 personal local component：个人 Atlas/Liclick token 只保存在该 Windows 用户本地；组件验证绑定邮箱与当前 Feishu Web 身份一致。主服务不能以机器级共享 Atlas 凭据兜底。

## Generic Client Contract

`createLiclickApiClient()` 当前真正接线的方法：

```ts
generateTextureSingleView(input)
getGenerationJob(jobId)
listGenerationJobs(projectId)
cancelGenerationJob(jobId)
```

接口仍声明 `inpaint()`、`generateNormal()` 和 `generateMultiview()`，但这三个 generic methods 当前直接抛出“not wired”。这不等于产品没有 Local Repaint 或 Multiview：它们由专用 editor/service orchestration 实现，不能调用这三个 stub。

## Image And Texture Map Generation

`POST /api/liclick/generate-image` 接收 client/project identity、workflow、prompt、model、aspect ratio、image size、count 和预处理后的 references。服务/本地组件：

1. 上传 reference assets；
2. 调用 Atlas/Liclick `generate_image`；
3. 保存 server job 与 remote task identity；
4. 轮询或按 job endpoint 恢复状态；
5. 只把清洗后的 task/result metadata 返回浏览器。

普通 Liclick image generation 与 Texture Map 共用底层 endpoint，但 metadata/workflow 不同。Texture Map 会同时带模型视图 reference 与材质 reference，成功后成为 Projected Layer，而不是自动加入材质参考库。

## Multiview Boundary

Texture Map 多视图由 `GeneratePanel` 实现：

- 生成 6/10/14/自定义 camera views；
- 捕获并一次性持久化所有 view data；
- 为每个 view 调用 `generateTextureSingleView({ mode: 'single' })`；
- 在本地 Generation 上标记 `mode='multiview'`、`textureBatchId` 和 camera view metadata；
- 支持部分成功、取消、远端 job 恢复、自动投影和后续内容识别补缝。

因此服务端不需要一个“返回整套视角”的 `generateMultiview` 调用；文档和新代码都不应误用 generic stub。

## Local Repaint Boundary

Local repaint 不是 generic `LiclickApiClient.inpaint()`：

- 编辑器先从当前视角创建透明模型图、用户 edit mask、保护 mask、depth/normal visibility 与 ROI。
- 专用 edit/model-view service 将 image + mask 提交给个人组件或主服务代理的远端 inpaint/ComfyUI 能力。
- 客户端以 authored mask 作为硬权限边界，把结果只合成回允许区域。
- 默认 enhanced seam mode 将原始结果、flat viewport colour reference 和 mask 送入本地 Worker 做边缘色彩融合；metadata 同时保存 raw/harmonized URL 和版本/耗时，任何失败精确回退 raw result。
- 用户可保存为原投影层替换、Project Layer 或 UV repair layer。
- 内容识别填充还提供不依赖远端生成的本地/UV repair 路径。

## Account And Secret Boundary

- Feishu OAuth session、App Secret、Atlas token、Liclick token 和 API key 不写入前端状态或仓库。
- `GET /api/local-liclick-account/status` 只返回清洗后的绑定状态。
- 本地组件对 Web 用户做 identity proof 和邮箱匹配；401/403/428 或 email mismatch 会使前端失效缓存并要求重新绑定。
- 远端生成资产物化时使用 HTTPS 和受控 host allowlist。

## Persistence And Recovery

- Generation 先以 client id 写入 running 状态；服务端 job id、remote task id、result URLs 和 startedAt 追加到 metadata。
- 项目刷新后按 project id 列出 jobs，恢复未完成结果，并补建完成但尚未持久化的 Projected Layer。
- 多视图取消会同时标记 batch/client generations，并尝试取消已提交的 server jobs。
- 旧的 frontend mock generation service 已移除；只有首页 mock project gallery 仍作为离线展示回退。

## Normal Generation

Normal 可视化和已有材质 normalMap 导出已经存在，但 Normal generation UI 与 API 仍未接线。不要把 `generateNormal()` 类型声明描述成已交付能力。
