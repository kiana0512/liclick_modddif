# 局部重绘右键参数面板

- UI-06/UI-10，主模块 M08；交互契约 `REPAINT-BRUSH-CONTEXT-MENU` v1.0.0。负责人 Codex。
- 用户明确要求取消局部重绘右键擦除，改为调大小/羽化，左键关闭。
- ViewportCanvas 在 Alt/中键导航让行后、模型拾取及擦除派发前拦截鼠标右键；仅 paintTool=inpaint-apply 生效。在空白视口也可打开，不要求点击命中模型。
- BottomToolDock 复用已有参数控件和设置；右键打开后面板外左键消费 pointerdown 及 click，不画图、不改选择；面板内左键可调数字和滑条，不立即关闭。下次左键恢复绘制，Escape 也可关闭。切工具/工作区、组件卸载清理状态与监听；原工具栏打开方式保留原行为。
- 独立橡皮、笔尾擦除、普通画笔右键、Alt 导航、中键平移和相机逻辑不变。没有执行生成或服务端写入。
- `ALG-LR-UV-PAINT` v3.0.0 不变；GPU/CPU/Worker/shader、线性羽化、内缩、UV/export、Project/Layer Schema、Command 幂等、Revision CAS、ownership、verified assets 不变，无迁移。旧工程及已有笔迹不改写。
- 回退：删除右键参数事件分流和面板监听，恢复原右键擦除入口；无资产回滚。

## 验证

- 生产监听 effect 的执行回归：打开、重复右键、控件点击、左键关闭与 click 尾部拦截、下一笔、工具隔离及清理。
- 实际 Edge 挂载 BottomToolDock 并使用提取的生产视口右键 guard：参数面板显示、大小输入、关闭不触发模拟画笔/选择、下一笔、Escape、Alt 右键通过。是隔离交互夹具，不是用户模型端到端绘制。
- projected-layer visibility、viewport-wheel/navigation、repaint-panel-navigation 回归通过；Web typecheck 与修改文件 lint 检查。本次不推送或部署，线上仍为上一版。
- 发布预检首次发现 editor 分包超预算 207 bytes，合并原菜单与右键菜单的重复监听、复用清理入口，不提高预算；真实浏览器与生产监听回归再次通过。最终发布以精简后提交的完整 prepush 和 A100 校验为准。
