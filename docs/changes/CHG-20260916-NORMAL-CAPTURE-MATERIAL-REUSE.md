# 多视角法线采集材质复用

主模块 M03，协作 M04；`NORMAL-CAPTURE-MATERIAL/1.0.0`，`ALG-CAP-005` v1.0.1。

## 问题与变化

生成多视角所需的 Normal 捕获原来会为每个视角创建并在 PNG 返回后释放同一份材质。Three.js 随材质释放清除程序引用，使同一离屏 renderer 的后续视角重复编译完全相同的 view/world/object normal 程序。

现在按 renderer 和 normal space 弱持有至多三份不可变材质。同一 renderer 的连续视角复用程序；替换 renderer 时使用独立材质。Normal 捕获仍在每次 draw 提交后立即恢复场景，等待 GPU 回读和 Worker PNG 时不持有临时可见性或材质。离屏 renderer 原有 20 秒释放策略与 `renderer.dispose()` 继续清除 GPU 程序；WeakMap 不延长 renderer 生命周期。

## 验证与边界

- 内置浏览器用 49,152 三角形模型、三个 normal space、每种十个相机角度做旧/新/旧/新对照。完整 decoded RGBA SHA-256 全部一致；每轮程序创建数从 30 降为 3，总耗时从约 702–742ms 降为约 568–569ms，未提交付费生图。
- 生产函数回归覆盖三个 space 各十个视角只建一份材质、不同 renderer 隔离、失败后恢复、并行 PNG 等待不覆盖新材质、camera 身份和 geometry guide 参数保持。
- 该对照是 512×512 隔离样本，证明重复程序编译已消除，不代表用户 4K 捕获、颜色 pass、GPU 光栅、回读、PNG 或远端请求全部降到该耗时。

## 审计、迁移和回滚

view/world/object 法线公式、投影矩阵、RGB 编码 `n*0.5+0.5`、tone mapping、相机、模型几何、分辨率、normal/depth/mask/color 顺序和服务输入不变。GPU 只复用相同程序；CPU/Worker/其他 shader、投影/逐层 UV 权重、回贴、QA、持久化、导出、Project Command、Revision CAS、ownership 和 verified assets 不变。无 Schema 或资产迁移。回滚 renderer/space 缓存并恢复逐角度释放即可；已有工程和生成资产无需改写。
