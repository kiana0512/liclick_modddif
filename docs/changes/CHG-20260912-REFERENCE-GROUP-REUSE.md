# CHG-20260912-REFERENCE-GROUP-REUSE

- 范围：UI-05 → M04/M08，参考图输入策略 `REFERENCE-GROUP-REUSE` v1.0.0。
- 输入：提交时冻结的参考图列表、当前选择 ID，以及仅在没有显式选择时使用的最近纹理任务参考 ID。
- 规则：显式选择多视图时直接使用该图；显式选择单视图时，若同一 `referenceGroupId` 中仍存在多视图则复用该多视图；若用户已经删除该多视图，则返回单视图并沿既有流程重新生成、持久化和绑定新的多视图。不得跨组复用，也不得以历史任务覆盖当前显式选择。
- 输出：局部重绘 ModelView 继续只接收一张已持久化多视图材质参考。主纹理单/多视图流程原有同组复用语义不变。
- 持久化：沿用 `ReferenceImage.referenceGroupId/referenceRole/derivedFromReferenceId/generationId`、Project Command v1、Revision CAS、ownership 与 verified reference asset；不增加 Schema，不重写旧工程，不删除历史生成资产。
- GPU/CPU/Worker/shader、投影、UV、重绘 coverage、分辨率、QA 和导出公式均不变。
- 回退：恢复局部重绘解析器“选中什么就返回什么”的策略；已有配对参考和工程数据继续可读。
- 测试：`test:local-repaint-material-reference` 覆盖显式多视图、单视图同组复用、删除后重建触发、跨组隔离和无选择时历史兜底。
