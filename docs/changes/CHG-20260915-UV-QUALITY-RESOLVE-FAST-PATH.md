# UV 质量解析快路径

主模块 M07，协作 M06/M09/M12/M13；算法 ALG-UV-003，执行优化 UV-QUALITY-RESOLVE/1.0.1。每张投影仍独立成为 UV 颜色与质量贡献，再执行原 Top-K 和权重合成。

共享 `qualityBlendCpuPixel.ts` 将单候选无需使用的 sRGB 线性转换移到混合分支，并与原基色累计循环合并。每个候选的强权重幂值只计算一次，保存在三个复用的 Number 槽中；分母、运算顺序、颜色一致性、dominance、alpha 与字节舍入保持原式。scratch 仍只用于同步、不可重入内核，不缓存输入或输出。

CPU、Worker 后备与 GPU 稀疏舍入修正共用此函数；GPU Top-K、WebGL/WGSL shader 不变，真实 GPU 输出继续经过原修正与 QA。分辨率、填边、接缝、导出、Project Command 幂等、Revision CAS、ownership、verified assets 和缓存文件格式均不变。无像素语义或 Schema 迁移。回滚仅恢复共享解析器的颜色转换位置与重复幂计算，无需重建历史资产。

`test-quality-blend-resources.mjs` 以冻结旧版验证 240 组 CPU 输出及 GPU 上传字节、资源生命期；resident display 与 readback 回归通过。`benchmark-quality-resolve.mjs` 固定 42c33049 为比较基线，交替运行新旧内核，三个场景各 262144 像素、6 轮、两种 alpha；所有 RGBA 字节与写入返回值零差异。每 8192 像素让步，计时只统计解析计算，不含让步与校验。

内置浏览器真实 WebGL 对照冻结 CPU：128² 的 23 层与 1 层、保留/不保留 coverage alpha 四组全部零字节差异。23 层分别触发 852/905 个舍入修正像素；单层为零。可用 `verify-resident-quality-webgl.mjs --serve` 的 `/__quality_test` 按钮重跑，不需要在测试浏览器注入内部接口。

实际内置浏览器五轮热样本：三候选旧 65.0/66.4/68.1/65.3/63.2ms，新 63.2/70.4/68.6/66.6/62.6ms，基本持平；单候选旧 9.4/9.5/7.6/7.2/7.6ms，新 5.2/5.5/4.2/5.7/5.5ms，中位数 7.6→5.5ms；混合边界旧 45.6/43.4/48.5/46.5/46.3ms，新 39.3/45.1/48.0/41.3/44.9ms，中位数 46.3→44.9ms。这是解析内核样例，不能代替完整工程点击到 UV 显示的延迟，也未解决整张回读和显示上传耗时。
