# 蒙版工具会话自愈

- 主模块：M08；协作模块：M03，入口 UI-06/UI-10。
- 算法/会话版本：`INPAINT-TOOL-SESSION/1.0.0`。
- 问题边界：低概率出现“步骤 1”仍高亮但模型不接收或不显示新蒙版笔画，刷新页面后恢复。

## 原因与修复

蒙版工具栏把重复点击只当作设置菜单开关：当 Store 中仍是 `inpaint-add`/`inpaint-subtract` 时，不再向视口发布工具激活。视口的旧 pointer capture、输入草稿或 GPU 覆盖层 direct-ready 标记若在模型/材质/重绘会话切换期间残留，模式布尔值没有变化，负责同步投影和覆盖层的 effect 不会再次运行，因此 UI 高亮状态与实际绘制会话可能分离；刷新会重建组件，所以表面上恢复。

Store 新增仅运行时 `paintToolActivationRevision`。进入或重复选择加选/减选工具都会递增；工具栏重复点击保持当前加/减选模式并发布该命令。视口收到新 revision 后：

1. 若存在因 `pointercancel`/`lostpointercapture` 未闭合的笔画，按取消边界完成提交和历史收口；否则释放残留 capture 与 brush ownership，并恢复相机控制。
2. 重新取得当前选中模型，复用既有蒙版层，重同步投影相机、遮挡深度和每个表面覆盖层。
3. 复用已有兼容清理，移除过期 direct-ready 标记，避免其错误压制轻量覆盖层。

不引入定时轮询或页面刷新，不清空已绘制蒙版，不把一次点击同时解释成开/关。`paintToolActivationRevision` 不进入 localStorage、工程文档或服务端资产。

## 对应面审计

- GPU/shader：只重新绑定/同步现有资源，不修改蒙版写入、混合、深度和显示 shader，不新增纹理或 pass。
- CPU/Worker：只增加常数级命令 revision 和输入状态清理；无像素 Worker、分辨率或 QA 变化。
- 投影/UV/repaint/export：作者蒙版、Capture/GPT 输入、局部重绘回贴、UV 合成和导出字节语义不变。
- 持久化：无 Schema/资产迁移；Project Command、Revision CAS、ownership 和 verified assets 不变。

## 验证、发布与回滚

- Store 回归验证首次与重复蒙版激活分别递增，退出工具不伪造激活。
- 工具栏/视口契约回归验证高亮按钮仍会重发当前工具，视口先收口孤立输入再同步覆盖层，effect 依赖 activation revision。
- 类型检查、完整 Web 回归、生产构建和本机 4517 冒烟由发布前门禁记录。

发布只需替换 Web 代码，无迁移。回滚时删除 activation revision、重复点击重发与视口 rearm 处理；已有蒙版和项目资产无需回写。若仍出现绘制失败，应保留浏览器控制台、模型/材质切换顺序和 pointer 类型用于定位，不允许用降低分辨率或关闭深度/QA规避。
