# Change Records

本目录保存源码、算法、契约和维护流程的逐项变更证据。规范以 `../00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md` 为准。

- 一个问题一个 `CHG-YYYYMMDD-SHORT-NAME.md`。
- 从 `CHANGE_TEMPLATE.md` 复制，先填写范围和复现，再开始修改。
- 合并后记录最终 commit/tag 和验证结果；不要删除失败或回退的记录。
- 小型纯文档拼写修正可以不建 CHG；运行行为、默认值、算法、性能、数据或模块边界变化必须建立。
