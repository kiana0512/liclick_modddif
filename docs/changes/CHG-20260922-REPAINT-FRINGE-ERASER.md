# 局部重绘预览白边与擦除准备

- 主模块 M06，协作 M08/M07/M09。ALG-ERASE-001 显示生命周期 UV-ERASER-LIVE/1.1.0；像素算法/持久化 eraserAlgorithmVersion 仍为 1，Schema 不变。

## 修改

UV 显示材质原来仅在覆盖率等于零时显示未覆盖斜线；部分透明的预览、已保存 UV 及实时重绘会与白膜底色混合，出现宽白边。现在按剩余透明度替换白膜贡献，连续过渡到同一种斜线背景。仅在显示诊断模式生效；远端捕获模式、作者 alpha 和输出颜色不改。

活跃 native UV 重绘橡皮擦已有 GPU 会话，但普通图层准备 effect 仅排除了旧 projected 重绘，因此切换时还会恢复一份通用 UV 画布。现在所有局部重绘会话都排除这条重复准备。

恢复后的普通 UV 图层仍使用原 destination-out 笔迹和历史算法；实时刷新改为每帧合并脏区域，用 GPU 子图上传替代整张 CanvasTexture 更新。保持完整分辨率，首次初始化/撤销恢复仍允许完整上传。它不是新的减面/低分辨率路径，也没有把普通 UV 擦除改成另一套投影算法。普通投射 GPU keep-mask 不变。

## 对等审计与回滚

GPU/shader：显示底色贡献修正；native 会话继续 GPU stamp；普通 UV 局部上传保持纹理 identity、Y 方向、alpha/颜色空间。CPU 正式画布、Worker、保存、导出和 Command/CAS/ownership/verified assets 不变。无迁移；回滚这次显示 shader、准备条件和局部上传器即可，已保存像素无需转换。

## 验证

- verify-repaint-display-edges：底图、UV overlay、live overlay 的四分之一透明边缘均为 [3,3,3]，捕获模式仍为原白膜混合 [112,113,110]；4K 中心蓝色及非对称左上绿色脏块方向正确，纹理全量 revision 不递增。
- verify-uv-repaint-eraser-browser：4K，UV 下层和投射下层均在按住鼠标时从橙色变为下层蓝色；正式提交、撤销、重做通过。
- native 浏览器回归前半段：去掉切换橡皮擦后的 150ms 人工等待，立即点击擦除、撤销、PNG/FBX/重开通过；HiDPI 1/1.25/1.5/2 通过。
- 原 native 全套测试在双层覆盖断言失败；通过 Vite 加载 HEAD 原始 ViewportCanvas/ProjectedLayerMaterial 对照，得到完全相同的失败像素：overlap=[74,181,66]，另一个独立绿点=[33,179,65]。这是现有问题，不记为全套通过。
- TypeScript、修改源码 ESLint、native UV/擦除策略/shader 格式检查及 Web 构建通过；包体门禁通过，未放宽预算。
- 32 万三角面、4K 的既有 native GPU 合成平面测试：准备约 147ms，stamp CPU 提交中位数 0.4ms、最大 5.8ms。这是 GPU 命令提交数据，不是用户模型端到端 FPS。
- 查看了用户 25.7 秒录屏的关键帧；未访问或修改其线上工程，真实高面模型仍需现场复测。未推送、未部署。
