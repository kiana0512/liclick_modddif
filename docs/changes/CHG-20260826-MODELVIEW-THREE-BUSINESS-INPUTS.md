# CHG-20260826-MODELVIEW-THREE-BUSINESS-INPUTS

> 状态：Verified  
> Owner：LI3D  
> Reviewer：待指定  
> 日期：2026-08-26  
> 分支：`codex/main-docs-v2-normal-push`  
> 基线 commit：`24fcc313`  
> 最终 commit/tag：待提交

## 1. 问题与证据

- 实际现象：前端禁用提示词，并向新版 ModelView 额外提交已废弃的 `viewport_reference` 图片。
- 期望结果：三个业务输入固定为可选 `prompt`、必填白模 `image`、必填材质多视图 `material_image`。
- 证据：`138_2026-08-26_MODELVIEW_PROMPT_FRONTEND_ALIGNMENT.md`，生产 workflow `2026.08.26-740115a-truev3-gguf-3input-rseed-r1`。

## 2. 范围

- 变更等级：Minor
- 主模块 ID：`M08`
- 影响模块 ID：`M04/M15`
- 算法 ID：`ALG-LR-002`
- 明确不做：不改变本地选择蒙版、flat viewport reference 接缝融合、depth guard、表面回贴、投影或 UV 合成算法。

## 3. 当前契约与根因

- 修改前输入：白模、材质多视图、viewport reference 三张图片，提示词固定为空。
- 修改后输入：可选提示词、白模、材质多视图；seed 由远端随机生成。
- 输出：唯一 PNG 及远端 Job/sha256 元数据，保持不变。
- 根因：前端和服务代理仍绑定上一版 ModelView multipart 合同。

## 4. 方案

- 在局部重绘页增加可编辑提示词，最大 4096 字符，空值可提交。
- 服务代理 multipart 只允许 `image`、`material_image`，有内容时追加 `prompt`。
- 幂等键由同一 client generation ID 稳定派生；重新生成使用新的 generation ID。
- workflow 元数据升级为 `2026.08.26-740115a-truev3-gguf-3input-rseed-r1`。
- 旧工程兼容：历史 Generation/viewport reference 元数据继续可读；不迁移、不删除。

## 5. 风险与回退

- 主要风险：生产端仍运行旧三图片合同会返回 422。
- 性能影响：减少一张图片的 data URL 转换和远端上传，浏览器本地融合捕获保持不变。
- 回退：revert 本变更并恢复上一版 workflow 合同；已保存工程无需迁移。

## 6. 验证

| 验证项 | 修改后 | 结果 |
|---|---|---|
| Server/Web typecheck | 通过 | Verified |
| ModelView smoke | 可空 prompt + 两图片字段；拒绝废弃字段 | Verified |
| Web/Server build | 通过 | Verified |
| 本地真实登录入口 | `http://127.0.0.1:4517/` | Verified |

执行命令：`pnpm --filter @liclick/server typecheck`、`pnpm --filter @liclick/web typecheck`、`pnpm smoke:modelview-inpaint`、`pnpm docs:maintenance`。

## 7. 文档与评审

- [x] 已更新唯一准则中的当前实现/版本
- [x] 已更新 `CHANGELOG.md`
- [x] 已更新算法版本和回退说明
- [ ] Reviewer 已检查真实生产输出

## 8. 结论

- 合并决定：本地合同与 smoke 全部通过后允许普通推送 `main`。
- 遗留问题：推送后核对 GitLab CI；A100 发布仍须使用同一 commit 的 CI 产物单独验收。
