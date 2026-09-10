# 单视图、多视图仅使用 GPT，隐藏供应方选项

- 主模块：M04；UI-05；入口策略 TEXTURE-GENERATION-PROVIDER v1.0.1。
- 基线：405f7f5；维护文档 2.19.8。

## 行为

删除整个 GPT2/远端 segmented control 及容器，不留空行。共享单/多视图 provider 状态固定初始化为 gpt，不暴露 setter，不从项目、旧结果 metadata 或浏览器存储恢复。新任务走既有 GPT 登录和生成路径，沿用原模型、提示词、参考图与单/多视图编排；不增加模型标签。预设 1/2、自定义视角顺序保持。

保留历史远端 Generation 和兼容实现、ModelView 后端接口；不批量改历史记录，不触碰局部重绘的生成服务、蒙版及橡皮逻辑。旧页面需刷新才能使用新入口。

UI-05 文案补充：单/多视图标题和输入框 aria-label 统一为“纹理提示词（可选）”；仅文案，无算法或请求语义变化，局部重绘文案保持。

## 测试与边界

入口回归检查不可变 GPT 状态、无 setter/供应方选择器/标签；提取实际函数执行单视图和多视图认证分支，确认只走 GPT，不调用远端登录或串行远端入口。原远端兼容路径回归保留，单视图补全、排序、取消、参考图生成不导航等断言不删除。

验证：99 项 Web 回归、TypeScript 类型检查、变更文件 ESLint 和 git diff --check 均通过；未提交真实付费生成任务。

GPU/CPU/Worker/shader、投影/UV/export、质量与分辨率不变；无 Schema、幂等性、Revision CAS、ownership 或 verified assets 改动，无迁移。回滚恢复原 setter 和选项行即可，历史资产不受影响。本次只修改本地，尚未提交/部署。
