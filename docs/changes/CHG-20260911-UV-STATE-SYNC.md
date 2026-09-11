# UV 状态同步和刷新缓存后续优化

日期：2026-09-11。主模块 M06，协作 M07/M09/M15。前置集成 b3247cf 的 pipeline 629949 全部 8 项通过，正式包体 3,219,378 / 3,222,000 bytes。本卡描述其后的修改，不代表这些修改已发布。

## 已定位的问题与修改

- `UV-DISPLAY-DERIVED-CACHE/1.1`：两个磁盘快照按写入淘汰，返回 GPU 已缓存的当前状态不会保留对应磁盘结果；F5 读回也没有把验证过的压缩字节放回 Worker 内存。于是 A→B→A→C→A 后可能把 A 淘汰，刷新重新投影。现在实际呈现确认时 activate 当前签名；磁盘写入串行化，淘汰排除当前实际显示的快照；过期的激活写入在执行前跳过。磁盘恢复通过完整摘要与解压长度校验后记入内存，已有内存项不重新绑定别的持久身份。
- 编码忙时此前直接丢弃新完成的 UV。现在只保留最新一个等待编码的完整结果，替换较旧等待项；上传和数组所有权门禁仍先执行，卸载先清空待处理项。新结果不等待压缩或磁盘操作才显示。
- `UV-TOPOLOGY-LOOKAHEAD/1`：把原几何拓扑 Promise 提前到来源加载阶段，重叠解码/光栅工作，原 gutter 消费点仍等待同一完整校验结果。GPU/CPU gold 门禁和失败兼容处理不变。
- `UV-POSTPROCESS-CANCEL/1`：常驻请求传入仅运行时使用的取消检查，接缝/gutter 的让出前后及阶段边界检查最新请求。过期计算停止，不发布旧 UV；当前任务继续原完整计算。可选回调不进入 Project Schema。
- `UV-SEAM-REPAIR-PLAN/1.1`：共享索引端点已证明相同 UV，直接比较端点身份，避免内边重复量化和字符串创建；重复位置但不同 UV、非索引、非流形边仍按旧量化键处理。首次 UV 键顺序与最后边记录、donor 顺序不变。

## 审计、容量与回滚

GPU 光栅与 Top-K/shader 像素、CPU blend/接缝/gutter donor、Worker 源 mask 和完整分辨率均不改。主线程增加取消与准备调度，缓存 Worker 增加派生资源的保留策略。深灰斜线材质未修改。显式合并共用原准备和接缝函数；PNG/FBX 等导出继续原生产路径，不新增自动烘焙、不合并或删除源层。

压缩内存仍最多 256 MiB，磁盘仍最多两个压缩快照；额外队列只持有一个完整 CPU RGBA+mask，4K 最多约 80 MiB，上传后才允许转移。当前 pin 是当前 Worker 内的实际显示状态，其他页面/项目独立 Worker 的磁盘写入仍可能淘汰全局两个快照，不宣称跨标签永久 pin。关闭页面前尚未完成的异步压缩也不能保证已经落盘。

磁盘 namespace、deflate 字节、摘要与 account/project/object/source identity 不变，无资产或 Schema 迁移。Project Command 幂等、Revision CAS、ownership 和 verified assets 不改；回滚本卡代码恢复调度与淘汰策略即可，已存字节仍可读。回滚取消接口时同时移除调用方参数，不删除用户图层或缓存源资产。

## 实际内置浏览器验证

地址为 127.0.0.1:4517 的用户割草机器人原项目，20 个投影/旧重绘来源，4K。通过真实图层眼睛的 pointer 处理器执行开关，最后恢复原显隐，等待 Saved 后 location.reload。计时等到协调器发布最终 UV，包含 UI 同步等待；不是 GPU fence 单项计时，也不表示所有网络/设备的稳定指标。

修复前 A→B→A→C→A 后 F5 约 6188ms，重新执行 mask 和完整 bake；修复后同序列 F5 2644ms，maskPreparationMs=0、completeBakeMs=0、underlayCompositeMs=0，确认没有重新投影。后续无异常复测初始恢复 2637ms、新局部组合 4367ms、已有结果约 32ms。首次组合仍有约 1.6 秒光栅/来源等待、1 秒接缝准备、0.8 秒蒙版准备，尚未达到即时要求。4K 单层 color+quality 就占 128 MiB，256 MiB 光栅预算不能容纳全部 14 个普通来源；不能只扩大缓存冒充首次算法已解决。

连续四次开关后回到原状态，后续 2.5 秒未再发布过期版本，眼睛状态正确恢复。曾单次捕获 Three 异步编译 isReady 异常，随后加完整异常/context-loss 采集复测未复现；没有把该异常宣称为已修复。最终回归和发布状态在验收后补充。

候选未保留：单 pass MRT 虽完整 RGBA 对照一致，但实际项目无收益；提前准备 CPU 接缝把约 1 秒从后处理挪到前面，整体仍约 4.64 秒，已撤回。接缝端点短路保留，不把约几十毫秒单次波动宣称为显著总耗时收益。

## 验证范围

真实压缩 Worker 测试覆盖磁盘恢复重新驻留、A/B/A/C/A/D/A 两快照淘汰、所有权身份不重绑、损坏字节拒绝和最新待编码结果的独占转移。取消回归覆盖让出前、让出中被新请求取代及正常恢复。冻结旧接缝核继续逐像素/coverage/count 对照，覆盖直接几何编辑、索引/非索引、变换、重复与非流形边。

逐层 UV 贡献持久化、缓存未命中组合的增量重算、首次计算进一步提速仍未完成；普通 F5 的整体资源加载也不等于单独 UV 恢复耗时。不得将已有状态的约 32ms 当成任意新组合性能。

本地完整回归 121 项通过，新增取消入口在排队开始及 live UV 提交等待前后拒绝过期请求，专项测试通过。后续同一内置页两次刷新为 2565ms、2467ms，完整 bake 均为 0，异常采集为空；普通新组合 2294ms。该轮没有重现之前的 isReady 异常，仍保留诊断记录。正式包体和新 CI 以最终提交检查记录为准。

## CI 期间继续优化首次接缝

`1715111ba8c5ef122df1d791060de8071f7dadf1` 已推送 master；正式检查 3,220,484 / 3,222,000 bytes，剩余 1516 bytes。pipeline 629981 全部 8 项通过（2026-09-11 16:17 GMT+8）；记录这些数据不代表其后的算法修改已经推送或 CI 通过。

M07 / `UV-SEAM-REPAIR-PLAN/1.2` 保持原世界位置量化，按首次出现映射整数 ID，以 `minId * radix + maxId` 无碰撞配对；radix 是全部位置元素数量加一，radix² 必须是安全整数，否则用原字符串键。Map 首次插入顺序不改。已共享的同 UV 内边原位更新 a/b/insideUv，避免每个三角形边再分配记录；记录只在本次遍历内持有，配对和 donor 消费仍在遍历完成后发生。

GPU/CPU/Worker/shader 像素公式和分辨率不改；显式合并、常驻 UV、导出消费同一个接缝实现。纯内存查找形式改变，持久缓存内容和版本身份兼容，无 Schema/资产/磁盘格式迁移；回滚恢复键与记录分配即可。

新增对优化内部 collector 的逐边深比较，覆盖变换/非索引、重复位置但不同 UV、非流形顺序和超安全整数边界回退；原 600 gutter、500 repair、40 transformed-mesh RGBA/coverage/count 对照通过，构建和相关 lint 通过。隔离 256×256 分段球冷处理三次旧 384.6/316.1/314.5ms，新 239.2/150.7/176.7ms，完整输出差异 0。内置原工程首次接缝两次约 880.9/878.7ms，对比上一版约 1026ms；明确可见且聚焦的复测为 895ms，整次新局部组合 4862ms、普通组合 2443ms、F5 2526ms。总时间受来源准备和并发界面工作影响，不能把局部 CPU 收益宣称为所有组合已无感。

一次新构建后仍捕获相同 Three isReady 异常，已取得编译轮询栈；加入临时生命周期诊断后的同页三次 F5 为 2281/2477/2508ms，未复现。临时诊断已经从源码移除，不作为生产修复提交，该异常保持待定位。

## 蒙版 Worker 依赖裁剪

M07，协作 M06/M09；`PROJECTED-MASK-WORKER-BOOTSTRAP/1`。将原 sampleImageBilinear、applyProjectedAlphaMask 原样移入纯计算模块，旧 imageSampler/createMaskedProjectedImage 保留 API 重导出。蒙版 Worker 只依赖纯函数，避免引入图像加载、项目状态和无关抠图代码。无新增依赖；Worker 构建产物 16,618→2,365 bytes。普通本地 JS 合计 3,206,618 bytes，正式发布另以最终 HEAD 的 verify:prepush 为准。

冻结核 800 组不同尺寸、稀疏/完整 mask、两种源 alpha 策略逐字节一致；投影显隐回归和相关 lint、构建通过。内置同一原工程可见聚焦测试：初始恢复 2497.5ms、新局部组合 4101ms（mask 704.4ms、seam 864.1ms）、普通组合 2348.2ms、缓存返回约 31ms、F5 2509.2ms；连续开关最终状态稳定。首次仍捕获已记录的 isReady 异常，后续 F5 无异常，不能宣称首次渲染 QA 完全通过或这项裁剪单独使整体加速。

CPU/Worker 共用原采样及蒙版公式；GPU/shader、接缝/Top-K、深灰斜线和输出分辨率不变；显式合并/导出继续原入口；持久资产、Command/CAS/ownership/verified assets 不改，无 Schema 或磁盘格式迁移。回滚同时恢复两个调用方的 imports 与原函数位置，不修改任何已保存的图层或缓存。
纯模块裁剪后完整 web 回归 121 项通过。

`adb26060619a5b3e19bbebbdfd1957f908666b19`（含接缝 1.2）正式 prepush 通过并推送 master，JS 3,207,110 / 3,222,000，余量 14,890 bytes；shell 256,101、editor 480,734、high bake 693,126、pipeline 828,957。pipeline 630007 尚在运行。

## 位置索引继续优化

M07 / `UV-SEAM-REPAIR-PLAN/1.3`：以量化后的完整世界坐标生成位置 ID。整数哈希只定位桶，桶内完整坐标比较后才能复用；超 int32 值不截断为位置身份，NaN/-0 的等价关系保持原字符串键规则。边配对、UV 键首顺序和最后记录、接缝 donor 与修补坐标均不变；此前超安全整数边键回退仍走原字符串路径。无像素、GPU/Worker/shader、分辨率、持久化/Schema/资产和导出语义变化；回滚恢复位置字符串 Map 即可。

补充强制哈希碰撞、大坐标、量化边界、正负零与非有限值和重复位置验证，保留原随机用例种子；600 gutter、500 repair、40 transformed-mesh、非流形与几何失效对照通过。隔离同一球模型三轮旧 158.6/137.6/125.7ms、新 122.4/113.1/105.4ms，完整 RGBA/coverage/count 一致。内置原工程可见聚焦：首次接缝 749.2ms、新局部组合 4193.6ms、普通组合 2291.1ms、F5 2609.9ms、已算状态约 31ms；连续开关最终稳定，该轮异常为空。仅局部阶段下降，不宣称总转换显著缩短或 isReady 已修复。

拒绝候选：蒙版在 Worker 编码 PNG 的 1/97/512/4096 尺寸、两种 alpha 模式完整解码 RGBA 对照差异 0，但真实原工程整次仍约 4147ms（原约 4190ms，波动不足以证明收益），已恢复原正式编码路径。早期 compileAsync 生命周期诊断尝试未获得有效定位证据，没有生产诊断补丁。

`bdfa20af0e2649361e3281c088bdb267c9854c30` 已通过正式 prepush 并推送 master；总 JS 3,207,419 / 3,222,000，余量 14,581 bytes，受限 chunk 全部通过。

## 首次静态 PNG 像素读取

M07/M09，协作 M06；`PERF-UV-SOURCE-PREPARE-001` v1.3.0。原 PNG header/尺寸校验通过后，CPU ImageData 请求也交给原软件 Canvas 采样 Worker；完整 RGBA 在 Worker 读出后转移所有权，主线程直接包装 ImageData 并进入原 192 MiB 缓存。GPU ImageBitmap 消费模式不变。JPEG、需要缩放的 PNG、live 来源保留原路径；不是把有差异的 Bitmap 缩放当成等价实现。

真实内置浏览器对 bdfa20a 冻结加载器逐字节对照：1/97/512/4096 尺寸 PNG、非方图、缩放 PNG、JPEG 全部尺寸和 RGBA 相同。4K 67,108,864 字节差异 0，旧 458.4ms、新 249.4ms；1px 的首次 Worker 启动反而较慢（11.2→18.6ms），不宣称所有小图也有收益。新增客户端转移包装、Worker 完整尺寸/字节、读取/发送错误和资源释放回归；原 live 同步快照/源解码/bitmap 与 CPU 合成断言保留。完整 web 回归 121 项通过，构建与相关 lint 通过。

内置原工程两轮可见且聚焦：首次新局部组合 3913/3930ms，mask 490.5/468.3ms；上一版约 4194ms、mask 845.5ms。普通新组合 2269/2384ms，已计算状态约 31–32ms；第一轮 F5 2428ms。连续开关恢复全部原显隐并等待 Saved，最终版本稳定，无该轮捕获的页面异常。仍未达到即时新组合，未证明未覆盖设备/所有原始 PNG 色彩配置均相同；已记录的偶发 isReady 仍待单独定位。

GPU/CPU/Worker/shader 共用原像素公式；CPU 消费者（蒙版、UV/导出等）只改变准备位置，alpha 舍入、Top-K、接缝、深灰斜线、全分辨率和 QA 保留。持久资产及 Project Command/CAS/ownership/verified assets 不变，无 Schema/存量资产/磁盘格式迁移。回滚同时恢复 imageSampler 的 bitmap-only 入口及 Worker 像素消息分支，已保存的结果无需重写。

## 2026-09-11：删除无贡献的颜色与法线计算

M07，协作 M06/M09；`UV-OVERLAY-IDENTITY/1`、`UV-RASTER-SPECIALIZATION/1`。优先验收没有缓存过的图层组合到最终 UV 发布，F5 约 2.4 秒已获用户接受，不能用恢复缓存的 32ms 代替新组合性能。

- Worker overlay：底层贡献为零（来源 alpha 为 1 或底层 alpha 为 0）时直接写来源 RGB，保留原 fractional alpha、renderedColorMask、coverage、顺序及其他像素的完整线性混合。去掉三次恒等的 sRGB 往返运算。
- GPU：仅内部 quality-alpha 光栅启用无 RGB 输出的 shader 分支；忽略来源 alpha 时不再为该分支采样无用颜色。其他公开光栅入口仍输出原 RGB。surface-locked/无 normal check 时，原法线一致性权重已经为零，直接保留 depth visibility。深度九点采样、几何裁切、Top-K/舍入、半透明边缘和三角面顺序保持。
- 编译资源：程序保留键增加 defines，防止颜色与权重变体互相挤掉已编译程序；原 256MiB 光栅缓存预算不变。
- 对照：`test-quality-blend-resources.mjs` 增加 524288 像素的来源字节/alpha 穷举组合，对照冻结核的完整 RGBA、coverage、rendered mask/count；既有 240 组 CPU resolve/资源用例通过。
- 内置浏览器：运行 `node apps/web/scripts/serve-uv-raster-specialization-qa.mjs`，打开输出的 `__raster_qa` 地址。需本地有冻结提交 `5b8dcde`。48 组 mode/source-alpha/mask/surface-locked/normal-check 对照零差异；4K 权重 alpha 零差异。10 次光栅+读回，预热后旧 96.2/104.8ms，新 91.7/92.2ms；首轮受初始化影响，不当成稳定加速比例。该夹具不是原工程整体性能。
- 原工程 4K：第一种新局部组合 3946ms，普通基底已复用时其他新局部组合 1469/1390ms，新普通投影组合 2080/2122/2040ms，恢复完整缓存约 31–32ms。连续开关最终稳定、恢复原显隐，无本轮捕获的异常；F5 2387ms。计时止于协调器发布最终 UV，未当成 GPU fence/屏幕呈现精确计时。完整回归 121 项及构建/相关 lint 通过。
- 限制：整体还没有大幅提速。普通新组合仍只有一个全尺寸光栅命中，其他 12 层重新计算；每层 color+quality 4K 为 128MiB，96MiB 普通聚合结果共用预算，不能直接堆显存。源准备、读回/后处理和上传仍需后续优化。已记录偶发 isReady 问题未宣称解决。
- 对应面审计：CPU/Worker 质量核和 GPU 量化规则不变；质量中间目标 RGB 变为零但消费者仅读取 alpha，最终颜色/导出无变化。深灰斜线 shader 不改；RGBA/Top-K、QA、分辨率、Project Command/CAS/ownership/verified assets 不变。无 Schema/资产或磁盘缓存迁移。回滚恢复三个运行时文件及程序保留键，已保存资产无需重写。

## 2026-09-11：来源解码与 GPU 计算重叠

M07，协作 M06/M09；`PERF-UV-SOURCE-PREPARE-001` v1.4.0。普通投影新组合依然只有一个 4K 光栅命中；未命中的来源准备会让 GPU 等待。将受限静态输入的预备槽从一个增加到两个，在上一层计算时重叠 PNG 解码、软件 Canvas 准备。保持消费顺序，逆序完成不能改变图层混合次序；关闭/失败排空两个槽，已交付资源由消费者释放，其余只释放一次。

边界：只有输出不超过 4K、每层最多两个非空 image/mask/depth/normal 输入的栈采用第二槽。任何 live 输入都保持同步消费快照；更大输出或更多输入沿用一槽。192 MiB CPU 缓存和 256 MiB 光栅缓存不变。额外一个预备层最多产生 128 MiB 输出像素，另有浏览器解码/Canvas 瞬时内存；不宣称峰值内存完全不增加。原工程普通来源 1254² 色图 + 2048² 深度，额外输出约 22 MiB；局部来源 2048² 色图 + 1024² 深度约 20 MiB。

验证与结果：

- 调度回归覆盖 23 层顺序、1/2 槽上限、逆序完成、各槽失败、消费中取消、重复 close、live 同步快照及分辨率/输入数量门禁。
- `LICLICK_SOURCE_IAB=1 LICLICK_SOURCE_REFERENCE=288ac80 LICLICK_SOURCE_FULL_ALPHA=1` 配置下运行 `verify-uv-source-lookahead-webgl.mjs`，在内置浏览器打开输出地址。该模式不再要求安装 Playwright。512²/13 层保留光栅、4096²/6 层、JPEG 和缩放 PNG：完整 RGBA、coverage、quality 与计数对照零差异。4K 独立段原版 1374/1314ms，新版 979/941ms；每轮使用新 URL，非缓存命中比较。4K 新版无 Long Task，但最大帧间隔约 33ms（对照约 17ms），不能宣称计算期间零掉帧。
- 最终内置原工程 4K：新普通组合 1921/1849/1845ms（上一发布约 2080/2122/2040ms），来源等待 322/263/270ms；首次新局部组合 3722ms，复用普通基底后的新局部组合 1433/1411ms。恢复完整缓存仍约 31–33ms，F5 2412ms。连续切换最终版本稳定，图层恢复原状态；本轮捕获的页面异常为空。完整 web 回归 121 项、构建及相关 lint 通过。计时止于协调器发布新 UV，不等同于屏幕呈现 fence。
- 位图 LRU 复用候选在相同 192 MiB 总预算下实测新普通组合仍约 2.1 秒，已撤销，未增加缓存或作为收益发布。

对应面审计：GPU 光栅/深度/Top-K/shader 和 CPU/Worker 像素公式未改；只重叠独立静态来源准备，GPU renderer 仍按原顺序使用。PNG/JPEG/缩放/live 解码路径、透明边缘、深灰斜线、分辨率、质量验收不变。持久资产、Command/CAS/ownership/verified assets、导出与 Schema/缓存格式不变，无迁移。回滚将 GPU 调用的第二槽关闭即可，不重写已保存结果。

限制：新组合仍为秒级；本次是来源准备的调度优化，不是已经完成逐层贡献复用或消除全部光栅成本。第一种新组合和局部重绘切换仍需后续优化。
