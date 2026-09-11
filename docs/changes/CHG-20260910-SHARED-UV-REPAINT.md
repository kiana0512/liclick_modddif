# 共享 UV 局部重绘

- 主模块 M08；协作 M03/M05/M07/M11/M12。
- 算法 ALG-LR-UV-PAINT v1.1.0，运行语义 UV_REPAINT_VERSION=2；持久 RGBA 格式和 native-v1 图层识别不变。
- 用户接受共用 UV 的表面共享颜色/透明度，授权实现、推送 master 和部署 A100。

## 行为

取消整模型重叠 UV 拦截，但保留 UV 缺失、退化、越界、非法顶点/不支持变形和设备尺寸检查。不自动重排模型 UV，不改旧资产。

原提前压平来源 UV 会使共享表面的来源互相覆盖，不能简单删掉拒绝条件。本次冻结来源 uniforms/纹理，笔刷实时用原 capture shader 计算被当前可见表面命中的来源颜色，保留原相机、深度、作者遮罩、source alpha/轮廓、朝向公式。不是使用当前画面光照取色。

每个共享 UV texel 在本 stamp 的临时 RGBA/depth 目标中竞争：当前可见且笔刷覆盖最强的有效表面获胜；同权重按固定 mesh/triangle 渲染顺序保留第一个。画笔没有命中的面不提供颜色。然后只合成一次到输出 UV，paint alpha=max，erase alpha乘(1-weight)，避免多个重叠面反复扣透明度。擦除允许通过共享 UV 任一可见位置进行，不受原返图有效区域再次限制。UV 共用的隐藏表面显示同步变化是用户接受的共享存储语义，不是穿透几何取色。

## 对应路径审计

- GPU/shader：临时 winner pass 与一次 composite；提前编译来源、可见性和合成材质；原来源 UV 目标改为 stamp 目标并增加 depth。保留原分辨率，移除整图 overlap 计数和读回。来源贴图由 session clone 后由 engine 释放；原来源资源不提前失效。
- CPU：脏瓦片异步读回、Canvas、精确 before/after 历史和工作选区消费保持。共享像素历史一次撤销/重做。
- Worker/合并/导出：消费同一已提交 RGBA，不再次投影，不自动补洞；现有 PNG/FBX/前台及后台合并 snapshot barrier 不变。
- 保存：verified assets / Command 幂等 / Revision CAS / ownership 不改，无 Project Schema 升级；v1 图层继续读写，不批量改写。
- 范围：单视图和旧 projected 重绘不改；不新增表面限定。完全无有效来源覆盖的位置仍不应用生成颜色。

## 验证与限制

真实 Edge WebGL 回归包含分离/遮挡/孔洞/转视角、source alpha/作者遮罩和生产来源 shader，以及新增共享 UV 左右不同颜色、隐藏面排除、最强命中、共享擦除只执行一次、撤销重做、PNG恢复、同 mesh 镜像/部分重叠和同权重稳定性。实际 React 视口同时检查画笔/擦除/撤销/重开和 FBX 临时纹理颜色一致。全套回归、类型、构建门禁与部署结果见最终发布记录。

用户原护栏项目的真实生图尚待试用；相同 UV 的不同表面不能保存独立颜色。未将隔离浏览器结果宣称为全模型性能/美术验收。

本地验证：116 项 Web 回归通过，全仓 typecheck 通过，lint 0 errors / 14 项既有 warnings，Cloud/repository 边界通过。真实 Edge / React 夹具通过，5914 个覆盖像素，FBX 中心 [211,68,34,255] 与 UV 相同，PNG 1024²。新增 winner/composite/identity 材质和几何预热后，32 万三角形/4K 隔离平面准备 136.5ms（含构造 63.2ms）、stamp CPU 提交中位 0.8ms / 最大 2.4ms；不是端到端 FPS 或用户项目实测。

## 迁移与回滚

无自动迁移，无模型/UV/历史资产删除。回滚到 0665e46，已保存 RGBA 仍可读；旧运行时会再次拒绝重叠 UV 的新绘制准备。A100 发布保留旧 dist/app.env 和旧哈希静态资源，项目数据库及运行目录不替换。
