# CHG-20260912-VIEWPORT-CLEANUP-OWNERS

## 范围

- 主模块：UI-06 视口；协作模块：M08 局部重绘。
- 生命周期：`LOCAL-REPAINT-GPU-OWNER-LIFECYCLE` v1.1.0。

## 修改

视口卸载清理在 effect 建立时固定捕获当前 dirty texture、局部重绘发布请求和 revision Map，与已经采用同样模式的 native UV owner 一致。cleanup 不再通过可变 ref 间接取得容器，避免未来 ref 更换后旧 cleanup 清空新生命周期资源。资源准备 effect 补齐 resident mask 提升回调依赖；该回调只依赖已有的 `invalidate`，不会增加额外重跑。

另删除 LayersPanel、SceneRoot 和 EditorPage 中 7 处编译器确认未使用的图标导入、store 订阅、帮助函数和 React 导入，减少死代码与维护噪声。未删除任何可见按钮、菜单或回调接口。

## 验证

- 全仓 typecheck 通过。
- lint 无 error，警告由 14 降为 2；剩余两条涉及 Editor 自动保存与激活回调的刻意重触发语义，本次不冒险调整。
- 局部重绘后台调度、隐藏页完成、GPU 上传、解码屏障与图层保留回归通过。

## 迁移与回滚

不改变 GPU/CPU/Worker/shader 像素、Project Schema、Command、Revision CAS、ownership、verified assets 或导出；无数据迁移。回滚恢复原 cleanup ref 读取和死代码即可，历史工程无需处理。
