# UV 接缝屏蔽对照与默认跳过

## 当前策略：默认跳过常驻预览接缝

- 用户检查当前模型后反馈视觉无区别，要求默认跳过；M07，协作 M06/M09，UV-DISPLAY-BUFFER v1.5.0。
- 所有地址的常驻预览默认关闭接缝修复，无需 URL 参数；局部橡皮草稿与普通显隐使用相同策略。Top-K、留边、拓扑 QA、完整分辨率保持。
- 新派生缓存 purpose 为 `resident-uv-display-3-no-seams`，恢复正常持久缓存；旧接缝结果不会作为新默认结果恢复。无需删除旧缓存、重写源图层或迁移工程资产。
- 本地 `?skipUvSeams=0` 可开启接缝对照，使用原 `resident-uv-display-2` 缓存空间；开关固定于实例，修改参数须刷新。生产地址始终使用新默认。
- 共享 CPU/GPU/Worker/shader 接缝内核、显式 UV 合并及导出流程保留；视口截图使用新的显示结果。用户的视觉验收限于当前工程，不能推断所有模型逐像素相同。
- 回滚：恢复常驻默认修复以及旧 purpose；源资产/Schema/Command/CAS/ownership 无迁移。尚未发布线上。
- 验证：TypeScript、修改文件 ESLint、Resident UV 回归通过；该回归加载器补齐先前快照优化引入的真实 fflate 依赖。构建与原包体门禁通过：96 chunks，3,244,195 / 3,247,500 bytes。
- 已更新本地 4517，入口 `index-hmVdq17P.js`。Chrome 无参数地址实测 `residentUvSeamMode=skipped`、`seamReconcileMs=0`、状态 ready，拓扑 QA 通过；此次工程已有 10 个可见投影层，未改动用户显隐。前一入口备份 `.codex-tmp/before-seam-default-off-index.html`。

## 历史：本地对照阶段

- 主模块 M07，协作 M06/M09；ALG-UV-005 诊断修订 seam-bypass/1。
- 用户要求临时屏蔽 UV 接缝操作观察效果。
- 仅 localhost/127.0.0.1 页面带 `skipUvSeams=1` 时，常驻显示传入 `repairMissingUvSeams: false`。此路径输出透明 RGBA，现有 CPU 与 GPU 后处理分支均跳过接缝修复。独立 Worker 后处理、显式合并/导出及 shader 不改写。
- 开关固定于显示实例；页面刷新重新建立内存缓存。关闭试验的持久缓存 key，禁止读取旧修复结果或把试验结果写入正式派生缓存。原始图层、资产和 Project Command/CAS/ownership 无变化。
- 留边、拓扑 QA、全分辨率、底图合成继续运行。接缝像素可能出现缺口；试验显示也会被视口截图看到，不能视为正式合并输出。
- 回滚：移除地址中的 `skipUvSeams=1` 并刷新。无数据迁移。未发布线上。
- 验证：TypeScript、修改文件 ESLint、生产构建及原包体门禁通过（96 chunks，3,244,160 / 3,247,500 bytes）。已安装本地 4517，入口 index-DVzAS2cq.js；替换前入口备份 `.codex-tmp/before-seam-disabled-index.html`。

## Chrome 真实 2K 工程单次对照

工程 project-4f91cea9-348c-4149-af58-ca2c01192316；底、顶和内容识别修补层为初始可见状态。

| 操作 | 接缝开启 | 接缝屏蔽 |
| --- | ---: | ---: |
| 显示右前层，总耗时 | 1799.2ms | 950.3ms |
| 同轮接缝阶段 | 835.9ms（缓存命中） | 0.1ms（跳过，仅计时开销） |
| 另一次隐藏右前层，总耗时 | 未采集 | 846.3ms |

屏蔽版本首次进入含 3 个可见投影层的页面仍需 3554.9ms（包括拓扑初始化和 QA），不能将首次加载与上述热轮直接比较。两次显示测量在刷新前后完成，源准备与调度存在差异，单次数据不代表稳定中位数。拓扑准备与留边仍有耗时。浏览器 readback 已确认 `residentUvSeamMode=skipped-local-test`、正式 QA 仍接受、输出 2K；最后恢复原显隐并保留试验参数。未进行全模型多角度视觉质量验收，由用户在当前页面观察接缝差异。
