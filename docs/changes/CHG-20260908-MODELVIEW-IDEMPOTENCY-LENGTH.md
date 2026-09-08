# ModelView 第二张单视图生成 422 修复

- UI-05 → M04 生成编排，协作 M13/M15；`MODELVIEW-IDEMPOTENCY` v1.1.0，实施 Codex。
- 真实证据：single-view-inpaint 返回 `String should have at most 128 characters`；浏览器任务 ID 为两段 UUID 嵌套的 104 字符字符串。
- 根因：服务端将该 ID 与 workflow 后缀拼接为 idempotency-key。普通单视图为 125 字符，已有贴图补全为 147 字符。旧函数只将 ID 截到 160，未限制最终键。

## 修复契约

输入是原始 clientGenerationId 与固定服务后缀；旧最终键不超过 128 字符时完全保留。仅超长时改为完整原始 ID 的 SHA-256 十六进制摘要加原 workflow 后缀；当前三个服务均小于 128 字符。同任务重试相同，不同任务的尾部 UUID 进入哈希；禁止只截断丢弃任务区别。

三种远端入口共用此函数，局部重绘、单视图及单视图补全均覆盖。prompt、图像、RGB mask、分辨率、远端端点、workflow、GPU/CPU/Worker/shader、投影/UV/export 不变。无 Layer/Generation Schema、Project Command/Revision CAS、ownership 或 verified assets 变化。

## 验证

在真实 HTTP mock 中执行生产服务代码，增加 128 字符上限和真实长度任务 ID：旧实现复现 422，新实现通过。覆盖边界 128/129、超长共同前缀而尾部不同、重试稳定、旧合法键不变，沿用四输入补全/两图片初始生成、图像尺寸与空蒙版拒绝、PNG 保存与恢复资产验证。将原独立 smoke 注册到 Server 全回归，避免 CI 漏测。

该回归验证协议修正，不能替代线上实际模型连续生成；生产测试及部署状态以最终记录为准。截图里的 local-settings 502 和 Project Command 409 尚无响应详情证明其原因，不归因于此键长问题，也不通过忽略错误放行保存。

## 迁移与回退

不迁移历史工程。旧合法键保持不变；超长键曾被远端参数校验拒绝，修复后首次可接收。失败任务可新建重试；已有成功成果不重算。回退函数会重新产生超长键并恢复该 422；不删除项目/生成/资产，也不修改服务器配置。
