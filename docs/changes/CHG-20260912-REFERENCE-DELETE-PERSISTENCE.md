# CHG-20260912-REFERENCE-DELETE-PERSISTENCE

- 主模块：M05；协作：UI-05、M03、M12
- 问题：旧版 `ReferenceImagePicker` 只更新内存 ReferenceStore。删除后若在 autosave 前刷新或切换路由，服务端项目仍保存旧引用，重新进入时会再次水合该参考图。
- 修改：删除成功后派发现有 `IMMEDIATE_PROJECT_SAVE_EVENT`。EditorPage 的保存协调器从 ReferenceStore 读取删除后的精确快照，并沿用 Revision CAS、冲突合并、Project Command 幂等与资产校验链路。
- 边界：新版 `ReferenceGroupPicker` 已具备相同屏障，不重复派发；生成锁期间仍禁止删除。只删除项目引用，不删除对象存储中的已验证图片资产，不改变生成任务输入或图片内容。
- 迁移：无 Schema、资产或历史项目迁移。旧项目在用户下一次删除时按新路径保存。
- 回滚：移除旧入口的即时保存事件即可；已删除或仍存在的参考图记录均保持合法。
- 验证：静态契约要求删除调用后紧邻即时保存事件；Project Save Coordinator 全量回归覆盖当前 Store 快照、Revision CAS 和冲突重试。
