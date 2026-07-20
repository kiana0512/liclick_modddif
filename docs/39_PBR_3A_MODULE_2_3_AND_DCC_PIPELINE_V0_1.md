# LI3D PBR/3A 模块 2、3 与 DCC 联动流程基线 v0.1

状态：初始开发基线

版本：0.1

建立日期：2026-07-20

适用范围：LI3D Web 工作台、Windows EXE 启动器、本地服务、Substance 烘焙适配器、ComfyUI 适配器、DCC 连接器、建模工具箱复用

维护原则：本文件是模块 2、模块 3 第一阶段产品设计、接口设计、UI 设计、实现和验收的共同依据。

## 1. 文档目的

LI3D 当前核心能力是模块 1：使用 AI 和投射图层为高模生成、编辑并烘焙纹理。下一阶段需要在同一套产品中补齐从高模资产到可交付低模 PBR 资产的后半段流程，并把结果稳定发送到 Blender、3ds Max、Maya、Unreal 等 DCC 或引擎。

本文档解决以下问题：

1. 固定模块 1、2、3 的边界、输入和输出。
2. 完整记录高模到低模的 PBR/3A 标准流程。
3. 规定 Substance、ComfyUI 和 DCC 软件的接入职责。
4. 规定 EXE 启动器在新流程中的职责。
5. 规定项目资产、任务日志、版本和文件校验的记录要求。
6. 明确现有 DCC 工具箱中可以复用的能力，避免重复造轮子。
7. 给第一版开发划定范围和验收条件。

本文档不代表模块 2、3 已经实现。没有通过实现和 Golden Asset 验证的内容必须继续标记为计划能力。

## 2. 产品模块定义

### 2.1 模块 1：AI 高模纹理

职责：

- 导入或生成高模。
- 通过参考图、AI 生成、投射、局部重绘和图层合成完成高模外观。
- 生成模块 2 可消费的高模资产版本。

模块 1 交付给模块 2 的最小内容：

- 高模模型文件。
- 高模 BaseColor 或颜色来源贴图。
- 模型原始变换和 LI3D 中的用户变换。
- 单位、坐标系、上轴、前轴和包围盒信息。
- UV Set、UDIM 和材质槽信息。
- 贴图色彩空间和尺寸。
- 模块 1 资产版本、生成来源和文件哈希。

模块 1 的具体 AI 上纹理能力由对应同学继续维护。模块 2、3 不直接修改模块 1 内部算法，只通过稳定资产协议接收结果。

### 2.2 模块 2：高低模烘焙与 PBR 处理

职责：

- 接收模块 1 的高模与颜色结果。
- 接收用户制作的带 UV 低模和手工 Metallic。
- 检查高低模是否满足烘焙要求。
- 通过统一 Bake Adapter 调用 Substance 3D Designer 或 Marmoset Toolbag 完成高模到低模烘焙；第一条生产执行链以 Substance 命令行 Baker 为主。
- 可选调用 ComfyUI 净化 BaseColor、生成或拆分 Roughness。
- 组装、预览、检查并发布标准低模 PBR 资产版本。

模块 2 第一版正式输出：

- 低模模型。
- BaseColor。
- Ambient Occlusion。
- Normal，可选。
- Roughness，可来自 ComfyUI、用户输入或后续人工处理。
- Metallic，优先保留用户手工输入。
- ORM 或其他目标通道打包图，可选。
- 缩略图和 PBR 预览图。
- 资产 manifest、烘焙报告、任务日志和文件哈希。

### 2.3 模块 3：DCC 工具与交付中心

职责：

- 管理 Blender、3ds Max、Maya、Unreal 等目标软件和连接器。
- 安装、修复、升级和检测 LI3D DCC 插件。
- 根据目标软件转换模型格式、法线方向、坐标、单位和贴图通道。
- 将模块 2 的已发布版本发送到目标 DCC。
- 在目标软件中创建或绑定材质并返回导入回执。
- 复用现有建模工具箱中的成熟脚本、桥接和辅助工具。

模块 3 只允许消费模块 2 的“已发布版本”，不能默认发送烘焙中的临时文件。

### 2.4 EXE 启动器

启动器不是模块 2、3 的生产操作界面。启动器是 LI3D 本地运行与外部连接控制中心，负责：

- 启动和停止 LI3D Runtime、后端、Web、本地任务 Worker 与 DCC Bridge。
- 检测 Substance、ComfyUI 和 DCC 软件。
- 安装、修复和升级 LI3D 自有连接器。
- 展示环境、版本、连接、端口和任务服务状态。
- 执行环境诊断并打开日志或工作目录。
- 提供模块 1、2、3 的快速入口。

真正的高低模选择、烘焙参数、结果检查、PBR 组装和 DCC 发送操作仍在 LI3D Web 工作台完成。

## 3. 端到端 PBR/3A 主流程

```text
模块 1：完成高模 AI 纹理
  -> 冻结高模资产版本
  -> 准备带 UV 的低模和手工 Metallic
  -> 模块 2 接收资产
  -> 环境检测
  -> 高低模预检
  -> 选择烘焙器并生成统一 Bake Job
       Substance 3D Designer（命令行 Baker）
       Marmoset Toolbag（Python Baker，可选适配器）
  -> 高模到低模烘焙
       BaseColor
       AO
       Normal（可选）
  -> 烘焙结果检查和按项重试
  -> ComfyUI PBR 处理（可选）
       净化 BaseColor
       生成或拆分 Roughness
  -> PBR 通道组装
       BaseColor
       Roughness
       Metallic
       AO
       Normal
       ORM（按目标可选）
  -> 低模 PBR 预览与验收
  -> 发布不可变的 LI3D 交付版本
  -> 模块 3 选择目标 DCC
  -> 目标预检和格式转换
  -> 发送到 Blender / 3ds Max / Maya / Unreal 等
  -> 目标插件导入模型、创建材质、绑定贴图
  -> 目标插件返回可验证的导入回执
```

## 4. 模块 2 详细流程

### 4.1 步骤 M2-01：接收模块 1 资产

输入：

- 模块 1 已保存的项目和资产版本。
- 高模文件。
- 高模 BaseColor 或颜色来源贴图。
- 模型、材质、UV、单位、坐标和变换元数据。

处理：

- 模块 2 通过项目内资产引用接收文件，不复制浏览器临时 Blob URL。
- 对所有输入计算或读取 SHA-256。
- 保存模块 1 来源版本，建立数据血缘关系。
- 记录用户是从模块 1 直接进入，还是独立打开模块 2 后选择已有资产。

检查：

- 文件是否存在且可读。
- 高模格式是否可识别。
- BaseColor 是否为有效图片。
- 高模贴图是否有明确的 UV 和材质槽对应关系。

输出：

- 模块 2 Draft 工作版本。
- 输入快照和接收记录。

失败恢复：

- 保留项目和资产元数据。
- 明确显示缺失文件，不自动删除已有记录。
- 允许用户重新定位文件，并记录替换前后的路径和哈希。

### 4.2 步骤 M2-02：添加低模和人工贴图

必需输入：

- 与高模位置、比例和坐标一致的低模。
- 低模 UV0。

可选输入：

- 手工 Metallic。
- 已有 Roughness。
- Cage 模型。
- 用户指定的材质槽映射。

低模准备约束：

- 低模必须具有可用 UV。
- 高低模必须使用同一空间基准。
- 禁止把经过 LI3D 显示归一化的高模直接与原始空间低模混合烘焙。
- 若导出前需要三角化，必须记录三角化阶段和软件，避免不同 DCC 重新三角化导致切线不一致。
- 硬边、平滑组和 UV 边界问题必须在预检中给出警告。

输出：

- 高模、低模和可选 Cage 的明确角色绑定。
- 用户贴图绑定记录。

### 4.3 步骤 M2-03：运行环境检测

必须检测：

- LI3D 本地后端是否在线。
- Bake Job Worker 是否在线。
- 项目目录是否可写。
- 临时目录和输出目录剩余空间。
- Substance 3D Designer 或可用命令行 Baker 的路径与版本。
- GPU 是否可用于当前 Baker。

可选检测：

- ComfyUI 地址、协议、工作流和队列状态。
- Blender、3ds Max、Maya、Unreal 等 DCC 安装情况。
- 对应 LI3D 连接器安装与在线情况。

环境状态统一为：

- `checking`
- `ready`
- `warning`
- `unavailable`
- `incompatible`
- `repair-required`

Substance 未安装时，模块 2 可以继续保存项目和准备资产，但不能启动正式烘焙。

### 4.4 步骤 M2-04：高低模预检

#### 4.4.1 阻塞错误

以下问题默认禁止进入正式烘焙：

- 高模或低模不存在、为空或无法解析。
- 低模没有可用 UV。
- 输出目录不可写。
- 高低模包围盒无空间交集，或偏差超过允许阈值。
- 输入颜色贴图损坏。
- 指定 UDIM 或 UV Set 不存在。
- Baker 不可用。

#### 4.4.2 警告

以下问题允许用户确认后继续：

- 高低模包围盒尺寸比例异常。
- 低模 UV 重叠或超出当前目标 Tile。
- 存在多个 UV Set、多个 UDIM 或多个材质槽。
- 高低模命名不能自动配对。
- 低模尚未三角化。
- 平滑组、硬边和 UV 切分可能产生接缝。
- 高模颜色贴图与高模 UV 的对应关系不明确。
- 用户 Metallic 或 Roughness 分辨率与目标分辨率不同。
- 预计显存或磁盘空间不足。

#### 4.4.3 预检报告

报告必须记录：

- 顶点数、三角形数、对象数、材质槽数。
- 原始和当前包围盒。
- 高低模中心点、尺寸、单位和变换差异。
- UV Set 和 UDIM 列表。
- 每张贴图尺寸、格式、色彩空间和哈希。
- 阻塞项、警告项和用户确认项。
- 检查器版本和检查时间。

### 4.5 步骤 M2-05：配置烘焙器与统一投射参数

LI3D 不把 Web 表单直接绑定到某一家软件的命令行。Web 保存统一的 Bake Job 参数，再由本地 Adapter 翻译到 Substance 或 Marmoset。公共参数包括：高模、低模、外部 Cage、前后投射距离、按名称匹配、分辨率、抗锯齿、Padding、Normal 方向、UV Set、UDIM、设备和输出地图。

烘焙体验的第一优先级不是参数数量，而是以下三个问题可视化并可诊断：

1. 高低模是否处于同一原始坐标、比例和中心基准。
2. Cage 是否完整包裹低模且不会造成错误命中、穿透和漏烘。
3. 任务参数是否与目标软件能力一致，并且能够保存到 Job 快照中准确复现。

中央匹配视图必须保持模型原始坐标和尺寸，支持高模、低模、叠加和 Cage 四种模式。任何仅用于显示的归一化都不得写回资产或参与正式烘焙。

#### 4.5.1 Substance 3D Designer Adapter

当前自动化原型来自：

```text
C:\Users\rentian\Downloads\substance-designer-bake-maps\SKILL.md
C:\Users\rentian\Downloads\substance-designer-bake-maps\scripts\bake_maps.py
```

该原型不是 LI3D 产品功能，也不操作 Designer/Painter 界面或已经打开的工程。它直接调用 Adobe Substance 3D Designer 安装目录中的命令行 Baker：

```text
C:\Program Files\Adobe\Adobe Substance 3D Designer\substance3d_baker.exe
```

当前原型已经具备：

- 验证高模、低模、颜色贴图和输出目录。
- 传递分辨率、Padding、采样、投射距离、Normal 方向、UDIM 和 GPU/CPU 参数。
- 生成 BaseColor 和 Tangent Space Normal。
- 验证输出 PNG 是否存在、可读取且尺寸正确。

当前原型尚不具备：

- AO 烘焙。
- 多 UDIM 自动处理。
- 高低模自动对齐和自动修复。
- Roughness、Metallic 和 ORM 组装。
- 将贴图应用到低模。
- 最终模型和完整 PBR 资产包导出。
- Bake Job 持久化、取消、重试、版本和日志协议。
- Web、启动器和 DCC Connector 接入。

因此产品化工作应把原型参数和命令构造拆成可测试的 Substance Adapter，并新增 AO 和 Job 管理；不能直接在 Web 中调用原始 Python 脚本，也不能把固定安装路径当成唯一有效路径。正式安装器还要单独确认 Adobe 命令行工具的许可和部署边界。

当前 Codex Skill 对应的基线默认值：

| 参数 | 基线默认值 |
| --- | --- |
| 分辨率 | 4096 x 4096 |
| Padding | 16 px |
| 抗锯齿 | 2x2 |
| 前/后投射距离 | 包围盒相对比例 0.1 |
| 命中策略 | 距离源表面最近的命中点 |
| Normal 类型 | Tangent Space |
| Normal 方向 | DirectX |
| 计算设备 | GPU |
| UV | UV0 |
| UDIM | 1001 |

手工截图中的参考设置为 2048 x 2048、4x4、Padding 16 和前后距离 0.1，与 Skill 默认值不完全相同。因此第一版不应把其中一套写死，而应提供预设：

| 预设 | 分辨率 | 抗锯齿 | Padding | 用途 |
| --- | --- | --- | --- | --- |
| 快速检查 | 2048 | 2x2 | 16 | 对齐和漏烘检查 |
| 手工流程对齐 | 2048 | 4x4 | 16 | 复现当前人工样例 |
| 正式生产 | 4096 | 4x4 | 16 或 32 | 最终交付 |
| 自定义 | 用户设置 | 用户设置 | 用户设置 | 特殊资产 |

第一版地图选择：

- BaseColor：必选。
- Ambient Occlusion：必选。
- Normal：可选。

高级参数必须折叠显示，不能在默认界面一次暴露全部专业参数。所有实际执行参数必须保存到 Bake Job 快照，后续修改 UI 设置不能改变已经提交任务的参数。

#### 4.5.2 Marmoset Toolbag Adapter

Marmoset 是模块 2 的第二烘焙执行目标，不属于模块 3 的普通资产交付目标。适配器采用 Toolbag Python API 管理 Bake Project，至少映射：

- 高低模导入和 Bake Group。
- 输出宽高、采样、Padding 和输出路径。
- 前后偏移或 Cage 最小/最大 Offset。
- 外部 Cage 与 Cage 可视化。
- 按名称匹配。
- `estimateOffset` 自动估算的建议值；建议值必须回填到 LI3D 参数并由用户确认，不能静默修改已提交任务。
- 单张地图重烘和全量烘焙。

若某一地图无法由 Toolbag 直接提供与 Substance 相同的颜色传递语义，LI3D 必须明确显示“由 LI3D 颜色转移阶段处理”，不得伪装为 Toolbag 原生输出。

两种 Adapter 输出必须归一为相同的 Bake Report、地图角色、错误码和日志结构，使后续 ComfyUI、PBR 发布和 DCC 交付不依赖具体烘焙器。

### 4.6 步骤 M2-06：执行烘焙任务

Web 前端只提交 Bake Job，不直接控制 Designer GUI。实际执行由本地服务中的 Substance Adapter 完成：

1. 验证输入路径和任务快照。
2. 为任务建立独立临时目录。
3. 构造命令行参数。
4. 启动命令行 Baker。
5. 采集标准输出、错误输出、退出码和执行时间。
6. 分地图收集输出。
7. 验证 PNG 文件、尺寸和基本可读性。
8. 把成功文件从临时目录原子移动到版本目录。
9. 生成烘焙报告。

用户在执行中必须能够看到：

- 当前地图。
- 总体进度和分项状态。
- GPU 或 CPU。
- 已用时间。
- 当前输出目录。
- 可取消状态。
- 简化日志和完整日志入口。

任务取消规则：

- 尝试停止本地子进程。
- 未完成的临时输出不能注册为正式资产。
- 已完成地图可以保留为任务附件，但不能自动发布。
- Job 记录状态为 `cancelled`，不得伪装为失败或成功。

失败规则：

- 一张地图失败不删除其他已成功地图。
- 支持只重试失败地图。
- 重试创建新的 Attempt，不覆盖原 Attempt 日志。
- GPU 失败后可向用户建议 CPU，但不能无提示自动改变生产参数。

### 4.7 步骤 M2-07：检查烘焙结果

中央 3D 视口需要支持：

- 高模。
- 低模。
- 高低模叠加。
- Cage 或投射距离预览。
- PBR 合成结果。
- BaseColor、AO、Normal、Roughness、Metallic 单通道结果。
- UV 和接缝显示。
- DirectX/OpenGL Normal 预览切换。

自动检查至少包括：

- 输出尺寸和格式。
- 图片是否全黑、全白、透明或无法解码。
- UV 覆盖率。
- 空洞和明显漏烘区域。
- 边缘 Padding 是否存在。
- Normal 通道是否具有合理分布。

用户可以：

- 接受地图。
- 标记需要重烘。
- 调整参数后创建新 Attempt。
- 只重烘指定地图。
- 保留并对比上一次成功结果。

### 4.8 步骤 M2-08：ComfyUI PBR 处理（可选）

ComfyUI 不是模块 2 的强依赖。不可用、失败或用户跳过时，流程必须能够继续。

第一版目标：

- 净化 BaseColor 中不应存在的烘焙光照、阴影、强高光和反射。
- 生成或拆分 Roughness。

Web 不直接暴露 ComfyUI 节点图，只暴露经过验证的工作流预设、少量艺术参数、任务状态和结果对比。

提交 Comfy Job 时必须冻结：

- 输入图片及哈希。
- 工作流 ID 和版本。
- ComfyUI 地址和服务版本。
- 节点映射版本。
- Prompt、负面 Prompt、Seed、Sampler 和用户参数。
- 提交时间、远程 Prompt ID 和本地 Job ID。

结果规则：

- Comfy 输出必须作为新候选版本，不能覆盖 Substance 原始输出。
- 用户必须明确选择使用原始版或 Comfy 版。
- 手工 Metallic 不能被 Comfy 结果无提示覆盖。
- 取消后返回的迟到结果不能自动应用。
- 远程失败时保留 Substance 已完成结果和所有本地记录。

### 4.9 步骤 M2-09：PBR 通道组装

标准通道定义：

| 通道 | 默认色彩空间 | 典型来源 | 备注 |
| --- | --- | --- | --- |
| BaseColor | sRGB | Substance 或 Comfy 净化结果 | 不应包含强光照和阴影 |
| AO | Linear | Substance | 默认独立保存 |
| Normal | Linear | Substance | 记录 DirectX/OpenGL |
| Roughness | Linear | Comfy、用户输入或人工处理 | 不与 Glossiness 混淆 |
| Metallic | Linear | 用户手工输入优先 | 缺失时不能默认生成灰色伪结果 |
| ORM | Linear | 通道打包工具 | 通常 R=AO、G=Roughness、B=Metallic |

所有通道重采样、位深转换、Normal 绿通道翻转和通道打包必须产生明确记录。

### 4.10 步骤 M2-10：PBR 验收与发布

发布前必须完成：

- 低模 PBR 材质预览。
- 单通道检查。
- 目标法线方向确认。
- 贴图分辨率和命名确认。
- 模型、材质槽和贴图对应确认。
- 阻塞问题清零。

发布行为：

- 创建不可变 Release ID。
- 固化模型和贴图文件。
- 生成 manifest、预检报告、Bake Report、Comfy Report 和缩略图。
- 计算最终 SHA-256。
- 标记来源 Draft、Job 和 Attempt。
- 不覆盖历史 Release。

发布后允许基于该版本创建新 Draft，但不能原地修改已发布文件。

## 5. 模块 3 详细流程

### 5.1 步骤 M3-01：选择已发布资产

输入必须是模块 2 Release，或通过同一资产协议导入的合格外部 Release。

界面需要显示：

- 低模缩略图和 PBR 预览。
- Release ID 和时间。
- 模型格式。
- 已有贴图。
- Normal 方向。
- 单位、坐标和材质槽。
- 是否已发送到其他 DCC。

### 5.2 步骤 M3-02：选择目标 DCC 与目标配置

目标配置至少包括：

- 软件类型。
- 软件安装和版本。
- 连接器版本。
- 目标工程或场景。
- 模型格式。
- 单位和坐标轴。
- Normal 方向。
- PBR 材质模板。
- 通道打包规则。
- 文件复制、引用或嵌入策略。

用户可以设置默认目标，但每次发送仍要保存本次实际 Target Profile 快照。

### 5.3 步骤 M3-03：目标预检

检查：

- DCC 是否安装。
- 版本是否在兼容矩阵内。
- LI3D 连接器是否安装、匹配并在线。
- 目标工程路径是否可用。
- 目标软件是否正在执行不兼容任务。
- 模型和贴图是否满足目标格式。
- 目标法线、坐标和通道规则是否明确。
- 发送包哈希是否完整。

检查结果统一为 `ready`、`warning`、`blocked`。允许继续的警告必须由用户确认并写入 Transfer Job。

### 5.4 步骤 M3-04：生成目标交付包

模块 3 根据 Target Profile 创建独立交付包：

- 不修改模块 2 Release。
- 必要时转换模型格式。
- 必要时翻转 Normal 绿色通道。
- 必要时生成 ORM 或目标专用通道图。
- 必要时复制、重命名或转换贴图。
- 写入目标侧 manifest。
- 对最终文件重新计算 SHA-256。

### 5.5 步骤 M3-05：发送和导入

DCC Connector 的统一能力接口至少包括：

- `detect`
- `install`
- `repair`
- `launch`
- `handshake`
- `heartbeat`
- `capabilities`
- `sendAsset`
- `cancel`
- `receipt`

首版采用“可靠的一次性发送”，不把实时双向同步作为前置条件。

目标插件应完成：

1. 接收 manifest 和文件列表。
2. 校验文件哈希。
3. 导入或更新模型。
4. 创建目标原生 PBR 材质。
5. 按通道和色彩空间绑定贴图。
6. 设置 Normal 方向和目标材质参数。
7. 返回导入对象、材质、贴图和错误列表。

### 5.6 步骤 M3-06：回执与历史

成功不能只显示“已发送”。回执至少记录：

- Transfer Job ID。
- Release ID。
- 目标 DCC、版本和插件版本。
- 目标工程或场景。
- 导入对象数量和名称。
- 创建或更新材质数量。
- 绑定贴图数量和角色。
- 转换过的坐标、单位、Normal 和通道。
- 开始、结束和耗时。
- 成功、警告和失败列表。
- 目标插件返回的 Receipt ID。

连接中断时，任务状态不得凭推测标记成功。重新连接后应通过 Receipt ID 或幂等键查询，避免重复导入。

## 6. DCC 工具箱复用计划

已检查的工具箱位于：

```text
C:\Users\rentian\Downloads\3d-tools-main
```

当前 manifest 版本为 `2.0.1`，已经包含文件哈希和工具元数据。这套 manifest 思路可以复用到 LI3D Connector Registry，但正式集成前仍需确认代码归属、许可证、发布权限、目标软件版本和安全边界。

### 6.1 可优先复用

| 现有能力 | 文件或工具 | LI3D 用途 | 复用方式 |
| --- | --- | --- | --- |
| Max 模型批量整理 | `MyTools-ModelToolbox.mcr` | 低模整理、检查、批量导出 | 封装为 3ds Max Connector 可调用能力 |
| Max UV 辅助与 Rizom 桥接 | `MyTools-UV_AuxTool.mcr` | 修复模块 2 预检发现的 UV 问题 | 保留 DCC 内操作，LI3D 展示启动入口和结果回执 |
| Max 桥接 Maya/Blender | `MyTools-MaxBridge.mcr` | 模块 3 DCC 间交付 | 提取协议、格式转换和启动逻辑，接入统一 Transfer Job |
| Max 面加权法线 | `MyTools-FaceWeightedNormals.mcr` | 低模法线准备 | 作为目标侧辅助动作，不在 Web 中重写算法 |
| Blender 桥接 Max | `blender桥接max_源码.py` / 更新版插件 | Blender 与 Max 联动 | 复用检测、导出、导入和桥接逻辑，适配统一协议 |
| 3ds Max Add-on | `liclick_3dsmax_addon.py` | Max 连接器基础 | 评估现有能力后接入统一 Connector Registry |

### 6.2 与模块 1 重叠的能力

| 现有能力 | 处理原则 |
| --- | --- |
| Max 批量图生 3D | 属于模块 1 范围，由模块 1 负责人决定是否继续复用 |
| Blender 批量图生 3D | 属于模块 1 范围，模块 2、3 只消费其输出资产 |

### 6.3 独立工具

现有独立通道工具能够进行 AO、Roughness、Metallic、Height 的打包和拆分，适合模块 2 的 ORM 输出。但当前交接包中没有看到该独立工具的完整源码，因此：

- 短期可以在确认安全和发布权限后作为外部工具调用。
- 未获得可维护源码前，不能把它视为 LI3D 内部稳定算法依赖。
- 第一版也可以依据公开且明确的通道规则实现一个小型、可测试的内部打包器，但要先确认这不与团队复用要求冲突。

降版本工具可以作为模块 3 的兼容辅助工具，但不能替代目标软件兼容矩阵和正式导入验证。

### 6.4 复用红线

- 不直接把整个工具箱仓库复制进 LI3D。
- 不通过 UI 自动化模拟点击 DCC 界面作为核心链路。
- 不绕过工具和插件的授权要求。
- 不让某一个 DCC 的脚本格式污染统一资产协议。
- 不把没有源码、没有版本、没有哈希的 EXE 当成不可替代核心依赖。
- 工具升级必须经过 manifest、SHA-256、兼容版本和回滚记录。

## 7. 资产、版本和目录规范

现有项目目录继续作为基础，模块 2、3 建议扩展为：

```text
workspace/projects/<projectSlug>/
  project.liclick.json
  assets/
    models/
      module-1/
      low/
    references/
    captures/
    generations/
    layers/
    baked/
      attempts/
      releases/
    pbr/
      candidates/
      releases/
    transfers/
  jobs/
    bake/
    comfy/
    dcc/
  reports/
  exports/
  thumbnails/
  autosave/
```

目录名称是第一版建议，最终实现前需要与现有 Workspace API 和迁移策略统一。

### 7.1 资产身份

最低身份层级：

```text
Project
  -> Asset
      -> Draft
          -> Job
              -> Attempt
      -> Release
          -> DCC Delivery
```

规则：

- Draft 可修改。
- 每次 Job 使用提交时冻结的参数快照。
- 每次重试创建独立 Attempt。
- Release 不可变。
- DCC Delivery 引用 Release，不复制来源身份。

### 7.2 Manifest 最低字段

```json
{
  "schemaVersion": "0.1",
  "projectId": "project-id",
  "assetId": "asset-id",
  "releaseId": "release-id",
  "createdAt": "ISO-8601",
  "source": {
    "module": "module-1",
    "versionId": "source-version-id"
  },
  "geometry": {
    "high": [],
    "low": [],
    "cage": [],
    "units": "centimeter",
    "upAxis": "Y",
    "frontAxis": "-Z",
    "transforms": [],
    "uvSets": [],
    "udims": [],
    "materialSlots": []
  },
  "textures": [],
  "jobs": {
    "preflight": [],
    "bake": [],
    "comfy": []
  },
  "files": [],
  "reports": [],
  "checksums": []
}
```

正式 schema 必须通过 Zod 或等价机制做深层验证，并提供 schema migration，不能只校验顶层字段。

### 7.3 文件写入规则

- 大模型和贴图以文件路径或流方式传递，不使用 Data URL 作为长期存储。
- 临时输出写入任务临时目录。
- 校验成功后通过临时文件加 rename 的方式注册正式文件。
- 文件名冲突不得静默覆盖。
- 用户替换输入必须保留旧记录和新哈希。
- 项目打开时发现文件缺失，应保留元数据并给出重新定位入口。

## 8. 任务状态、日志和错误记录

### 8.1 通用 Job 状态

```text
created
  -> validating
      -> blocked
          -> validating
      -> queued
          -> running
              -> cancelling
                  -> cancelled
              -> collecting
                  -> review-required
                  -> succeeded
                  -> failed
```

终态：

- `succeeded`
- `failed`
- `cancelled`
- `expired`

`blocked` 和 `review-required` 是需要用户处理的非终态。`published` 属于 Release 状态，不属于 Job 状态。详细定义以 `docs/41_PBR_JOB_STATE_LOG_AND_ERROR_SPEC_V0_1.md` 为准。


### 8.2 日志层级

- 用户日志：当前步骤、可理解的原因和下一步处理。
- 技术日志：命令行、进程、标准输出、错误输出、堆栈和耗时。
- 审计日志：谁在何时修改了输入、参数、结果选择和发布状态。

技术日志可能包含本地路径，导出给外部人员前应提供脱敏版本。

### 8.3 错误码范围建议

- `ENV-*`：环境与安装。
- `ASSET-*`：输入文件与资产。
- `MESH-*`：高低模、UV、材质和坐标。
- `BAKE-*`：Substance Baker。
- `COMFY-*`：ComfyUI。
- `PBR-*`：通道与组装。
- `DCC-*`：DCC 检测、连接和导入。
- `IO-*`：文件、目录和磁盘。
- `SEC-*`：鉴权、哈希和协议安全。

每个错误码必须包含：用户文案、技术原因、是否可重试、建议动作和相关日志位置。

## 9. DCC 连接协议与兼容策略

### 9.1 统一连接器协议

LI3D Web 不直接实现 Blender、Max 或 Maya 特例。所有目标通过本地 DCC Bridge 和适配器接入：

```text
LI3D Web
  -> LI3D Local Backend
  -> Job Worker / DCC Bridge
  -> Blender Adapter
  -> 3ds Max Adapter
  -> Maya Adapter
  -> Unreal Adapter
```

连接器需要：

- 本地身份和短期连接令牌。
- 协议版本。
- 插件版本。
- 心跳。
- 能力列表。
- 请求 ID、幂等键和 Receipt ID。
- 超时、取消和重连策略。

localhost 服务不能依赖“只有本机所以无需鉴权”的假设。

### 9.2 兼容矩阵

“支持某个 DCC”必须有测试证据，不能只表示文件能够打开。每个目标版本需要记录：

- 操作系统。
- DCC 版本。
- LI3D 插件版本。
- 模型格式。
- 多对象、多材质槽和多 UV 支持。
- 坐标轴和单位。
- Normal 方向。
- BaseColor、AO、Normal、Roughness、Metallic、ORM 绑定结果。
- 导入、更新、重复发送和取消结果。
- 已知限制。
- 最近验证日期。

首批优先级：

1. Blender。
2. 3ds Max。
3. Maya。
4. Unreal。
5. 其他 DCC 或引擎。

Blender 和 3ds Max 优先，是因为现有工具箱已经存在相关桥接、导入和辅助代码，可以更快建立第一条稳定闭环。

### 9.3 首版不承诺实时双向同步

第一版验收目标是：

- 可重复的一键发送。
- 明确的格式转换。
- 目标侧正确创建材质并绑定贴图。
- 可验证回执。
- 失败后可以安全重试且不重复导入。

实时同步、跨 DCC 协同编辑和冲突合并属于后续能力。没有稳定 Release、幂等传输和兼容矩阵之前，不进入实时同步开发。

## 10. Windows 启动器升级基线

### 10.1 导航

建议保留现有视觉并扩展导航：

```text
启动
服务
连接器
诊断
日志
高级选项
```

### 10.2 启动页

保留现有 Runtime、后端、前端、工作目录和“一键启动”。新增：

- Substance 烘焙引擎摘要。
- ComfyUI 摘要。
- DCC Bridge 摘要。
- 最近使用的 DCC 连接状态。
- 模块 1、2、3 快速入口。

首页只显示摘要。详细配置进入“服务”或“连接器”，避免首页堆积大量卡片。

### 10.3 服务页

管理：

- Runtime。
- Backend。
- Web Workspace。
- Bake Job Worker。
- DCC Bridge。
- ComfyUI Connection。

### 10.4 连接器页

每个 DCC 显示：

- 是否检测到软件。
- 已检测版本和可执行文件路径。
- LI3D 插件是否包含、已安装、需升级或需修复。
- 当前连接和最后心跳。
- 能力列表。
- 启动、安装/修复、测试连接和设置动作。

当前 Photoshop 卡片的检测、启动、安装/修复和状态展示可以作为连接器组件的第一份参考，但连接器数据和 UI 需要抽象为通用模型。

### 10.5 诊断页

建议顺序：

1. Runtime。
2. Backend。
3. Web。
4. 工作目录读写和磁盘空间。
5. Substance Baker。
6. GPU。
7. ComfyUI。
8. DCC Bridge。
9. DCC 软件和插件。
10. 本地协议、端口、哈希和资产包读写测试。

诊断失败必须给出可执行动作，例如“重新选择路径”“安装/修复插件”“打开日志”“切换 CPU”“重新测试连接”，不能只显示红点。

### 10.6 安装器和更新

- LI3D 安装包只打包 LI3D 自有 Runtime、适配器和获准分发的插件。
- 不重新分发 Substance、Blender、3ds Max、Maya、Unreal 或其他第三方软件。
- 外部软件由启动器检测，并引导用户使用官方安装方式。
- 插件更新使用版本化 manifest、SHA-256、兼容范围和回滚信息。
- 升级启动器和程序文件不得删除用户 Workspace、项目、Release、日志和连接器设置。
- 安装或更新完成后运行最小诊断。

## 11. UI 与使用体验基线

### 11.1 视觉一致性

模块 2、3 和启动器继续使用 LI3D 当前视觉：

- 深蓝黑背景和三维画布。
- 粉紫渐变用于主操作和当前选择。
- 橙色用于工具提示、空间辅助和局部警告强调。
- 半透明深色面板、细边框、轻微辉光。
- 6 到 8 px 圆角。
- Noto Sans SC / Inter 字体体系。
- Lucide 或相同线宽与几何风格的图标。

外部软件只作为交互参考，不复制它们的品牌、图标、文案或视觉资产。

### 11.2 模块 2 交互参考

- 参考 Marmoset Toolbag 的高低模分组、Cage、视口检查和结果预览。
- 参考 Substance Painter 的地图选择、参数预设、任务执行和结果列表。
- 继续使用 LI3D 的中央视口、左右 Dock、可折叠面板和底部主工具条。

### 11.3 模块 3 交互参考

- 参考 Fab/Bridge 的目标选择、默认导出配置、一键发送和进度队列。
- 参考 Creative Cloud 的软件和插件检测、安装、升级、修复和状态。
- 参考连接器软件的在线、离线、最后心跳和能力表达，但首版不实现复杂 Live Sync。

### 11.4 用户流程状态

系统在每一步都要回答：

1. 已经有什么？
2. 还缺什么？
3. 当前正在做什么？
4. 出问题的具体位置在哪里？
5. 用户现在能做什么？
6. 结果保存在哪里？
7. 是否可以安全继续或重试？

## 12. v0.1 开发范围

### 12.1 必须完成

- 完成本流程文档并保持更新。
- 定义模块 1 到模块 2、模块 2 到模块 3 的资产协议。
- 定义 Bake Job、Comfy Job、Transfer Job 和 Release 数据模型。
- 建立 Substance Adapter，先支持 BaseColor、AO 和可选 Normal。
- 建立模型预检最小闭环。
- 建立模块 2 基本 Web 工作流和结果检查。
- 建立模块 3 Connector Registry。
- 首先完成 Blender 或 3ds Max 中至少一个真实目标闭环，再完成另一个。
- 升级启动器，使其能检测 Substance、任务服务和首批 DCC 连接器。
- 建立 Golden Asset、兼容矩阵和导入回执。

### 12.2 可以延后

- 多 UDIM 完整生产支持。
- 复杂多材质槽自动匹配。
- Cage 和 Skew 的 Web 内绘制。
- ComfyUI 节点编辑器。
- 自动修复 UV。
- Maya、Unreal 以外的广泛目标覆盖。
- 实时双向 DCC 同步。
- 云端共享任务和多人协同。

### 12.3 第一版不做

- 自动点击或遥控 Substance Designer/Painter GUI。
- 为了“全自动”而无提示修改用户模型。
- 无记录覆盖高模、低模、手工 Metallic 或历史 Release。
- 在没有源码、版本、哈希和授权确认时深度嵌入第三方或独立 EXE。
- 宣称未经测试的软件版本“完美兼容”。

## 13. Golden Asset 与验收

### 13.1 Golden Asset

至少准备一套固定样例：

- LI3D 模块 1 输出高模。
- 对应高模 BaseColor。
- 与高模一致的带 UV 低模。
- 手工 Metallic。
- 手工 Substance 流程得到的 BaseColor、AO 和 Normal 标准结果。
- Blender 和 3ds Max 中人工正确绑定后的标准场景或截图。

后续每次修改都与 Golden Asset 比较。

### 13.2 模块 2 验收

- 高低模预检能够发现缺 UV、明显错位和缺文件。
- 同一输入与同一参数能够得到稳定命名、尺寸和格式的输出。
- BaseColor、AO 和 Normal 输出通过文件验证。
- 取消和失败不会发布半成品。
- 重试不会覆盖旧日志。
- 发布后能够恢复完整模型、贴图、参数和血缘记录。

### 13.3 模块 3 验收

- 能检测目标 DCC 和连接器状态。
- 能生成目标专用交付包。
- 能在目标侧导入低模。
- 能创建 PBR 材质并正确绑定贴图。
- Normal、坐标和单位符合目标配置。
- 返回对象、材质、贴图和错误回执。
- 重复发送遵守幂等策略，不产生无法控制的重复对象。

### 13.4 启动器验收

- 能检测所有必需本地服务。
- 能显示 Substance 和首批 DCC 连接器状态。
- 能安装/修复获准分发的 LI3D 插件。
- 诊断能够给出具体解决动作。
- 升级安装不会删除用户项目和 Release。
- 日志能够关联 Job ID、Release ID 和 Transfer Job ID。

## 14. 推荐实施顺序

1. 本文档评审和冻结 v0.1。
2. 资产 manifest、Release 和目录结构详细 schema。
3. Bake/Comfy/DCC Job 状态机、错误码和日志 schema。
4. 模块 2、3 完整低保真流程图。
5. 启动器和 Web 的完整视觉概念评审。
6. 使用 Golden Asset 手动复现 Substance 和 DCC 标准答案。
7. Substance Adapter 与本地 Bake Job Worker。
8. 模块 2 Web 最小闭环。
9. ComfyUI 可选链路。
10. Connector Registry 与工具箱复用封装。
11. Blender 首条真实闭环。
12. 3ds Max 真实闭环。
13. 启动器服务、连接器和诊断升级。
14. 扩展 Maya、Unreal 和其他目标。

## 15. 仍需在实施前确认的决策

以下问题不会阻止文档和 UI 设计，但必须在对应实现开始前确定：

- 第一条正式 DCC 闭环先做 Blender 还是 3ds Max。
- Substance 正式支持的安装版本和许可部署方式。
- AO Baker 的最终命令行参数和输出命名。
- 第一版是否支持多材质槽。
- 第一版是否只支持 UDIM 1001。
- 手工 Metallic 的标准输入格式和缺失处理。
- ComfyUI 远程服务的鉴权、工作流版本和文件传输限制。
- 工具箱代码和独立 EXE 的归属、许可证和再分发权限。
- Channel Tool 是作为外部程序调用，还是以可测试内部算法重新实现。
- DCC 插件更新地址、签名、回滚和离线安装策略。

在没有额外决定时，v0.1 默认采用：单个低模、UV0、UDIM 1001、GPU、BaseColor + AO + 可选 Normal、ComfyUI 可跳过、先完成可靠的一次性 DCC 发送。

## 16. 与现有文档的关系

- `docs/40_PBR_ASSET_MANIFEST_AND_RELEASE_SCHEMA_V0_1.md`：本文流程对应的资产、Draft、Candidate、Release、Delivery 和 Manifest 详细规范。
- `docs/41_PBR_JOB_STATE_LOG_AND_ERROR_SPEC_V0_1.md`：本文流程对应的 Job、Attempt、状态、日志、错误码、取消、重试和 DCC Receipt 详细规范。
- `docs/42_MODULE_2_3_LAUNCHER_UX_AND_LOFI_SPEC_V0_1.md`：本文流程对应的页面地图、关键状态、低保真布局、跨模块操作和首轮视觉概念。
- `docs/00_PRODUCT_GOAL.md`：继续定义 LI3D 的总体目标；本文扩展模块 2、3。
- `docs/02_TECH_ARCHITECTURE.md`：继续定义 Web、Server 和 3D 技术栈；本文新增本地适配器和 DCC Bridge 方向。
- `docs/04_PROJECT_SCHEMA.md`：当前项目 schema 基础；后续需要扩展 Asset、Job、Release 和 Delivery。
- `docs/14_PROJECT_WORKSPACE_AND_PACKAGE.md`：当前 Workspace 和 `.liclick3d` 规划基础；本文增加 PBR、Job、Report 和 Transfer 目录建议。
- `docs/15_EXPORT_MATRIX.md`：当前模型和贴图导出能力；模块 3 需要在其上增加目标配置和导入回执。
- `docs/30_LOCAL_DESKTOP_RELEASE_AND_AUDIT.md`：当前 Windows 启动器基线；本文定义启动器的下一阶段职责。
- `connectors/blender/README.md`、`connectors/3dsmax/README.md`：当前仍为占位连接器；实现时必须升级为真实连接器并遵守本文协议。

## 17. 变更记录

### v0.1 - 2026-07-20

- 首次建立模块 2、3 完整 PBR/3A 生产流程。
- 固定模块 1 到模块 2、模块 2 到模块 3 的交付边界。
- 记录 Substance、ComfyUI、PBR 组装、DCC 发送和回执要求。
- 建立工具箱复用分类和复用红线。
- 建立启动器升级方向、任务状态、版本、日志和 Golden Asset 验收原则。
