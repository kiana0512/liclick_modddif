# CHG-20260922-DOC-PROGRESSIVE-DISCLOSURE

> Status: Migrated to master; documentation validation passed; not pushed
> Owner：仓库维护者
> Reviewer：待补
> 日期：2026-09-22
> Branch: shaoyangZhou/develop-docs
> Baseline commit: c2ef76672a28e494fcf8322042d2cb96996b50fe
> Original experiment baseline: e27df85a; measurements below are historical, not rerun on this master baseline.
> Final commit: see the Git history for this change card

## 1. 问题与证据

- 实际现象：`AGENTS.md` 第 3 行要求修改前**完整阅读** `docs/00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md`。该文件当时 1,676 行 / 503,434 字节，第一个二级标题在第 423 行，最长单行 1,067 字符。改一处 UI 文案也要加载全部领域知识。
- 期望结果：入口给出按任务的读取路由与停止条件，只加载本次改动涉及的章节。
- 复现步骤：打开 `AGENTS.md` → 按第 3 行指示读取唯一准则 → 前 422 行为无标题变更流水，读到第 423 行才出现第一条规则。
- 指标：唯一准则中以日期开头的变更条目 283 行 / 197,719 字节；真正的规范正文（第 2–17 节）仅约 128 KB，占全文 25%。仓库同时已有 `docs/changes/` 268 张变更卡承担历史职责。

## 2. 范围

- 变更等级：L1（文档治理，无代码与运行时改动）
- 主模块 ID：M15
- 影响模块 ID：无代码模块受影响
- 计划修改文件：`AGENTS.md`、`CLAUDE.md`（新增）、`docs/00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md`、`docs/00_SYSTEM_REVISION_LOG.md`（新增）、`docs/README.md`
- 明确不做：不修改任何源码、算法、Schema、门禁脚本或 CI 配置；不删除任何历史文字。

## 3. 当前契约与根因

- 当前输入：agent 读取 `AGENTS.md` 作为唯一入口。
- 当前算法/状态转换：入口把"路由"表述为"全量加载"，唯一准则同时承担当前规范、变更流水和修订历史三种角色。
- 当前输出：上下文被历史流水占满，规范正文反而容易被截断。
- 根因：`docs/README.md` 自己定义了"当前规范 / 历史快照 / 设计输入三类不能混用"，但唯一准则本身违反该分类；入口缺少读取触发条件与停止条件。

## 4. 方案

- 修改点：
  1. `AGENTS.md` 重写为"阅读路径 + 硬约束"两段。阅读路径给出分节加载顺序、跨路径追加要求和历史读取时机。
  2. `AGENTS.md` 硬约束第 3 条增加豁免：纯文案、样式、文档改动记录"无算法变更"，不要求定位 algorithm ID。
  3. 唯一准则新增第 0 节「如何按任务读取本文档」，含任务→章节映射表与停止信号，并补目录与锚点。
  4. 唯一准则的历史流水（原第 2–422 行、第 1 节内的变更卡记录、第 18 节修订历史）整体移入 `docs/00_SYSTEM_REVISION_LOG.md`，逐行保留。
  5. 第 14 节审批触发由"跨模块数 / 5 文件 / 300 行"改为风险维度判定，规模降级为自查提示。
  6. 新增 `CLAUDE.md`，以 `@AGENTS.md` 导入同一份规则，避免 Claude Code 因无 `CLAUDE.md` 而完全不加载仓库规则。
- 保持不变的行为：第 1（1.1/1.2/1.3）、2–13、15–17 节正文逐字不变；硬约束 1、2、4–9 不变；`scripts/check-*.mjs` 门禁与包体预算不变。
- 明确改变语义的部分：硬约束第 3 条增加豁免；第 14 节审批触发由规模改为风险维度，旧条款逐字归档于 `../00_SYSTEM_REVISION_LOG.md` 的「2026-09-22 已被取代的条款」。
- 失败/fallback 行为：不适用（纯文档）。
- 旧工程兼容：不适用。
- 数据或版本升级：唯一准则文档版本 `2.21.2` → `2.22.0`（Minor，结构重整 + 审批触发语义变更）。

## 5. 风险与回退

- 主要风险：第 14 节审批触发改为风险维度后，超过 5 文件 / 300 行但不触及风险维度的改动不再自动需要批准。缓解：风险维度清单显式列出投影矩阵、UV 权重阈值、局部重绘阈值、深度编码、颜色空间、四类契约、持久化与 Revision 语义、默认分辨率、Cloud 边界、目录移动与兼容删除。
- 次要风险：分节读取可能让 agent 漏读跨路径要求。缓解：第 0 节与 `AGENTS.md` 第 4 条各写一遍六路审计要求。
- 性能/显存/内存影响：无。
- 回退步骤：`git revert` 本次提交即可；或将 `docs/00_SYSTEM_REVISION_LOG.md` 去掉文件头后按原顺序拼回唯一准则。
- 回退后数据是否兼容：兼容，无数据产物。

## 6. 验证

| 验证项     | 修改前 | 修改后 | 结果 |
| ---------- | ------ | ------ | ---- |
| 唯一准则体量 | 1,676 行 / 503,434 bytes | 710 行 / 137,053 bytes | 通过 |
| 第一条规则出现位置 | 第 423 行 | 第 9 行（第 0 节路由指示，节标题在第 7 行） | 通过 |
| 切分阶段文字是否丢失 | — | 1,674 行逐行排序比对 identical | 通过 |
| 第 14 节旧审批条款去向 | 在正文 | 已逐字归档至修订流水，正文替换为新条款 | 通过 |
| 入口引用关系 | 无 `CLAUDE.md` | `CLAUDE.md` 以 `@AGENTS.md` 导入，引用关系已检查 | 通过 |
| 新会话是否真正自动加载入口 | 本会话启动时 `AGENTS.md` 未进入上下文 | 未实测 | 待验证 |
| 格式检查 | — | `git diff --check` 退出码 0 | 通过 |
| 源码/门禁 | — | 未修改 | 通过 |

执行命令与结果：

```text
切分后逐行完整性比对（此步在第 14 节替换之前执行）：
  原始行数: 1674  切分后行数: 1674
  diff → Files are identical

第 14 节旧审批条款归档核验：
  grep -c "默认一次修复只跨一个大模块" docs/00_SYSTEM_REVISION_LOG.md → 1
```

未覆盖项：`CLAUDE.md` 的自动加载只检查了引用关系，尚未在新会话中实测，需另起一次会话确认 `AGENTS.md` 内容确实进入上下文后再改判。未运行 `pnpm verify:prepush`。本次不含源码、依赖或构建配置改动，预期不影响包体预算，但第 1.3 节要求每次人工或代理推送前都运行该入口，推送前仍须执行并记录最终 SHA。Reviewer 尚未复核。

二轮复核修正（2026-09-22）：外部复核指出六处问题，已全部修正 —— 入口必读范围与第 1.3 节发布流程分离；路由表补第 11 节捕获登记与第 15 节验收行；停止判据改为"已定位当前契约、受影响路径与验收要求"，不再混入实现后验证，也不再预设语义不变；六路审计触发恢复为投影/UV/局部重绘，纯持久化改动不再自动触发并允许记录"不适用及原因"；`docs/README.md` 的性能审计由全局必读改为按任务读取；本卡状态、逐字不变声明与发布门禁结论按实际情况更正。

## 7. 文档与评审

- [x] 已更新唯一准则中的当前实现/参数/文件位置
- [x] 已更新 `CHANGELOG.md`
- [x] 已判断并更新算法/Schema/Workspace 版本（文档版本 2.22.0；无算法/Schema 变更）
- [ ] Reviewer 已检查 diff 范围
- [ ] Reviewer 已检查真实输出，而不仅是 typecheck

## 8. 结论

- 合并/发布决定：文档治理变更，不改变构建产物；但不豁免第 1.3 节的推送前检查，推送时仍按该节执行 `pnpm verify:prepush` 并跟踪远端流水线到结果。
- 遗留问题：第 5–11 节算法登记仍集中在单文件（约 128 KB）。下一步可拆为 `docs/algorithms/ALG-*.md`，唯一准则只保留 ID→文件索引表，实现真正的按 ALG ID 加载。本次不做。
- 关联 ADR/后续 CHG：无。

## 9. Reading-scope clarification (2026-09-22)

At the user's request, absolute reading restrictions were replaced with: "Read these sections first; expand the scope when cross-module dependencies, contract changes or insufficient evidence require it." AGENTS.md, section 0 and docs/README.md were updated, raising the standard to 2.22.1. M15; no algorithm, schema or runtime change, and no data migration. Rollback restores only this wording without rewriting the earlier 2.22.0 test snapshots or measurements. A full-standard and historical-archive audit was added as a boundary case with little opportunity to skip reading; the Feishu report contains its results and raw counts. The affected guidance was later translated into English without changing its meaning or reverting subsequent revisions.

## 10. Measurement evidence

[Feishu test report and data attachments](https://lilithgames.feishu.cn/docx/UpFxdn2jKoBhclx0A0GcVJc1nhf) record two independent before/after code-task comparisons using gpt-6-astra / medium. Case A changes one import-error title; case B adds an identifier index for the complete current and historical documentation. Each condition was measured once; these are scenario results, not average savings.

| Metric | Case A before / after | Case B before / after |
| --- | --- | --- |
| Pre-edit reading total tokens | 4,164,499 / 502,283 | 4,308,466 / 4,038,807 |
| Whole-task total tokens | 5,681,403 / 893,323 | 5,382,246 / 5,334,659 |
| Peak request input tokens | 218,889 / 58,741 | 217,093 / 218,908 |

Both implementations passed their checks. Case A produced identical one-line patches; case B produced matching inventories of 15 modules and 58 algorithm IDs. Context figures come from the original per-request logs; the reported effective window was 828,400 tokens. Test worktrees, credentials, runtime assets and full session logs are excluded from the repository commit. This documentation change does not waive the pre-push checks in section 1.3.

## 11. Migration onto current master (2026-09-22)

Only the seven Markdown files from `1b9d1ac0` were migrated onto `c2ef76672a28e494fcf8322042d2cb96996b50fe`, on `shaoyangZhou/develop-docs`. M15; no algorithm change. Neither `093ce4e0` nor `0beef04a` is imported. Source, dependencies, build settings and CI remain identical to this master baseline. Master already contains its own lint/build fixes.

Upstream standard additions are preserved verbatim in the revision log; current contracts are summarized in sections 6, 8, 11 and 15, raising the document version to 2.22.2. This covers reference routing/de-lighting, repaint masks and preparation, projection coverage, eraser lifecycle, return-background QA and inherited build budgets. The earlier file-size and token tables describe the original experiment only. Claude automatic loading remains unverified. Rollback: revert this documentation commit; do not restore an older master tree.
