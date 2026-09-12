# CHG-20260912-TOOLBOX-LOGO-HOME

- 主模块：UI-01；协作：M03
- 问题：工具箱 `/tools` 顶部 LI3D Logo 使用无回调的 `BrandMark`，因此只有页面正文的“返回功能首页”按钮能够导航，Logo 点击没有反应。
- 修改：顶部 `BrandMark` 复用工具箱页面已有 `onBack` 回调，并设置可访问名称“返回功能首页”。
- 交互：鼠标点击、Enter/Space 键盘激活、hover、focus-visible 和 active 反馈沿用公共 `BrandMark` 行为。
- 边界：不新增路由、不直接操作 history、不增加 React state/effect；工具清单、安装器下载、说明书、用户菜单和退出登录不变。
- 算法/数据：不涉及 GPU、CPU、Worker、shader、投影、UV、重绘、Schema、Project Command、Revision CAS、ownership、verified assets、持久化或导出。
- 迁移：无。
- 回滚：恢复工具箱页顶部无 `onBack` 的 `BrandMark`；无数据回滚。
