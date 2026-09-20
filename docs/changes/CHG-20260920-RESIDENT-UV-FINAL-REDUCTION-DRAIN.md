# Resident UV 末级归约直接读回

- 日期：2026-09-20
- 主模块：M06 / M07
- 协作模块：M09 / M15
- 算法：`UV-LAYER-CONTRIBUTION` v1.0.4

## 问题与边界

Resident UV 冷路径会为每个投影层生成可显隐恢复的无损贡献瓦片。两级 8×8 占用归约在第二级结束后仍额外调度一次 `yieldToBrowserTask`，随后才启动 GPU 异步读回；完成单层贡献后主循环还会再让出一次。末级后的第一次让出不再保护共享 renderer，却按投影层数量重复累积。

本次不降低分辨率，不关闭 QA，不改变投影、Top-K、质量、gutter、瓦片地址或 archive 字节格式。

## 修改

- 保留第一级归约后的主线程让出，避免连续 GPU pass 长时间占用交互。
- 第二级归约完成后直接发起 `readRenderTargetPixelsAsync`；异步读回本身会归还主线程，且保持 WebGL 命令顺序。
- 末级读回前仍执行取消检查；每层完成后的 viewport 让出仍保留。

## GPU / CPU / Worker / Shader / 持久化 / 导出审计

- GPU：归约 pass、target 尺寸、shader 取样和 RGBA 读回不变，仅删除末级 pass 与异步读回之间的空调度。
- CPU / Worker：占用地址生成、紧凑图集与 Worker 恢复算法不变。
- Shader：8×8 两级归约和 64×64 瓦片语义不变。
- 持久化 / 导出：仅会话级派生缓存的调度改变；Project Command、Revision CAS、对象资产、导出结果与云端服务协议均不变。

## 验证

- Node 合同锁定两级 8×8 精确覆盖，且仅中间级保留显式主线程让出。
- WebGL 夹具覆盖 65/128/257/512/4096 分辨率、显隐/重排、archive restore，并将原始贡献与瓦片恢复结果逐字节比对。
- 4517 真实 4K 工程需再验证 `ready`、控制台无新错误以及页面交互正常。
- 正式 pre-push 需通过 typecheck、Web/Server 回归、lint、生产构建、Cloud artifact/deployment 与包体余量门禁。

## 迁移与回滚

无 Schema、项目资产或数据迁移。回滚时恢复第二级归约后的 `yieldToBrowserTask`，无需转换持久项目或导出结果。
