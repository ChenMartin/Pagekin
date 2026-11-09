# Reveric 对照调研与整合优化

日期：2026-11-08。Pagekin 基线见 README；本地 reveric 为 unstable 分支，提交 `e3408d8acf66a50e7ab533c360007f9ff589b12b`，pubspec 版本 0.8.1。仅进行了源码静态检查，没有构建或运行 Flutter、插件或 NAS 服务。Git status 遇到部分 .claude/skills 路径不可访问警告，不据此声称整个 Reveric 工作树完全核验。

## 结论与边界

推荐“Pagekin Web 主体 + Reveric 设计经验 + 统一领域命令层”，不推荐直接合并两个应用或同时在 NAS 运行两个写作后端。总体范围已扩展为 J5005 / fnOS / Docker Compose 上的小说到成片工作区，完整功能与阶段以 [全流程设计](06-novel-to-film.md) 为准。

Reveric 是 Flutter/Dart、Riverpod、Drift 应用，包含文件选择、窗口管理、原生媒体和本地 JS 插件运行能力；与 Pagekin 的 React/TypeScript/Electron 技术栈不同。把 Flutter 页面放进 React 或运行一个 Dart sidecar 都不能自动解决平台依赖、数据一致性和浏览器编辑问题。

以下源码链接固定到调研时使用的 Reveric 上游提交。

## 已检查证据

| 本地源码 | 已确认事实 | 可吸收内容与限制 |
| --- | --- | --- |
| [pubspec.yaml](https://github.com/looplj/reveric/blob/e3408d8acf66a50e7ab533c360007f9ff589b12b/pubspec.yaml) | Flutter/Dart、Drift、Riverpod、媒体及桌面依赖 | 不具备直接复用 React 组件的条件；不能由存在 iOS/web 目录判断支持已完成 |
| [AGENTS.md](https://github.com/looplj/reveric/blob/e3408d8acf66a50e7ab533c360007f9ff589b12b/AGENTS.md) | 当前支持范围为 Windows、macOS、Android | 不能据此承诺 Linux 服务端或 iPad 浏览器已支持 |
| [移动章节编辑](https://github.com/looplj/reveric/blob/e3408d8acf66a50e7ab533c360007f9ff589b12b/lib/mobile/pages/chapter_editor_page.dart) | 800ms Timer 防抖；session.saveQueue 串行保存；保存后 markPersisted；包含 flushPendingEdit | 可借鉴队列、编辑会话隔离和离开页面冲刷；本地应用保存不等于 HTTP 幂等和多设备 CAS |
| [章节保存服务](https://github.com/looplj/reveric/blob/e3408d8acf66a50e7ab533c360007f9ff589b12b/lib/shared/services/chapter_save.dart) | 读数据库最新基线，按 title/outline/content 实际差异记录变更，无变化不提交 | 借鉴字段级历史与无变化去重；“读最新基线”不能替代客户端原始 baseRevision 校验，否则可能覆盖另一设备 |
| [WorkingOverlay](https://github.com/looplj/reveric/blob/e3408d8acf66a50e7ab533c360007f9ff589b12b/lib/shared/services/working_overlay.dart) | patch/commit、接受、回滚，注释明确为真实写入后的处理流程 | 借鉴可追溯变更；不要直接替换 Pagekin 的“候选确认后应用”语义 |
| [工具审批](https://github.com/looplj/reveric/blob/e3408d8acf66a50e7ab533c360007f9ff589b12b/lib/shared/agent/tool_approval.dart) | 冻结参数；独立 approvalId；单 broker；一次性决策；pending 为内存 Map/Completer | 借鉴冻结与唯一决策；Web 版审批需要落库、过期、来源复核及跨设备事务裁决 |
| [会话持久化](https://github.com/looplj/reveric/blob/e3408d8acf66a50e7ab533c360007f9ff589b12b/lib/shared/services/ai/session_persistence.dart) | 聊天会话和消息落库，连接本地数据库与文件服务 | 聊天历史不等于工作流执行账本；保持 Pagekin run/attempt/artifact 为生成事实源 |
| [远程桥](https://github.com/looplj/reveric/blob/e3408d8acf66a50e7ab533c360007f9ff589b12b/lib/shared/services/remote/remote_bridge_service.dart) | 编排 WeChatAdapter，按 chatId 串行路由入站消息 | 不能把 remote_bridge 名称理解成已有完整 B/S REST 后端 |
| [插件宿主](https://github.com/looplj/reveric/blob/e3408d8acf66a50e7ab533c360007f9ff589b12b/lib/shared/services/plugins/host.dart) | 依赖 dart:io、Flutter services、path_provider、DAO 和运行时 | SDK 为 TypeScript 不代表宿主可直接跑 Node；不能把本地插件复制到 server 后直接执行 |
| [Web 插件说明](https://github.com/looplj/reveric/blob/e3408d8acf66a50e7ab533c360007f9ff589b12b/plugins/web/README.md) | WebFetch/WebSearch 插件，涉及 fjs 与宿主桥 | web 指网页检索，不是整款产品的浏览器版 |

仓库包含远程访问方案，但方案不是实现证明；本报告对“已有能力”的判断以上述实际代码为主，不将设计归档中的 Relay、配对和远程视图当作已交付服务。

## 整合路线比较

| 路线 | 成本与结果 | 决策 |
| --- | --- | --- |
| 合并 Flutter 与 React UI，直接共享 SQLite | 两套状态管理和 schema，写入约束冲突，维护复杂 | 不采用 |
| Dart/Flutter 后端作为 sidecar | 还需剥离 Flutter/本地依赖、定义 RPC、同步身份与任务；增加运维 | 当前不采用 |
| Pagekin 内实现经过选择的设计模式 | 一套前端、领域服务、持久化与部署 | 推荐 |
| 后续中立格式导入/导出 | 适合用户有 Reveric 存量作品时迁移；不要求持续双写 | 可选二期 |

## 优化 1：统一变更入口，而不是再加一套 Agent 写库接口

人工编辑、自动保存、AI 候选应用、历史恢复和导入替换都调用同一领域命令层。命令至少包含 projectId、resourceId、operation、baseRevision、mutationId、actor、来源 runId（适用时）。

命令层统一完成授权、生命周期校验、来源版本校验、写入事务、审计和事件 outbox。AI 工具只组合受控命令，不执行任意 SQL，不直接改项目文件。

单事务落库：领域数据 + 编辑 revision + 幂等收据 + 最小审计记录 + 待发布事件。SSE 发布器消费 outbox；重启后可补发，客户端按 eventId 去重。交付语义是可重复投递加幂等消费，不声称跨模型供应商与数据库实现严格 exactly-once。

## 优化 2：自动保存与修改历史分层

保留原方案的本地草稿、1.5 秒防抖、10 秒周期兜底；这些为可调默认值，不因 Reveric 使用 800ms 就直接替换。借鉴其串行队列和仅记录实际差异的设计。

细化三种版本：

- editRevision：每次实际持久化编辑推进，用于并发冲突。
- historyCheckpoint：用户可见历史，按时间、显式保存和关键操作合并，不每 10 秒制造一份新稿。
- domainVersion：Pagekin 草稿、修稿、定稿等业务版本，沿用现有流程。

标题、大纲、正文可记录字段级差异。首版仍用文档级 CAS，明确提示冲突；后续仅对基线可证明且字段互不相交的修改考虑自动合并。同一正文字段不按时间自动覆盖。

AI 改稿继续先生成候选，确认时提交。不要照搬另一项目“已写入后再回滚”的模型，以免改变 Pagekin 的作者确认边界。

## 优化 3：跨设备审批和等待用户

AI 工具修改设定、应用候选等可复用统一审批设计。审批表存 approvalId、projectId、runId、冻结参数及 hash、expectedRevision、status、expiresAt 和决策收据。

电脑批准与手机拒绝同时发生时，只允许一次 pending → resolved 条件更新成功。执行前重新检查来源版本；即使审批成功，如果正文已修改也必须重新比较，不能沿用旧审批覆盖新文本。审批过期或任务取消后拒绝新决策。

需要用户输入时进入 awaiting_user 并持久化提问；客户端退出不自动回答，服务器重启也不默认批准。与原有修稿/定稿确认整合，避免在每个无风险读取动作前弹审批。

## 优化 4：受控的“作品助手”后续能力

借鉴 Reveric“按需读取作品并使用工具”的交互方向，后续可提供只读优先的作品助手：查人物、找章节、解释伏笔、生成修改建议。Pagekin 已有 agent/workflow 相关代码，先审计其可复用能力，再补接口，避免新增第二套 Agent 框架。

工具按能力分层：读取资料 → 生成候选 → 请求应用。上下文携带章节、来源版本、引用位置与 token 预算；工具结果限制大小，优先按需查询，不能每次把整部小说注入上下文。

作品文本、外部网页、写作 Skill 都按不可信内容处理，不得借提示词提升文件或网络权限。首版继续支持提示词型 Skill；执行代码的插件属于另一期单独评估，不能把 Node vm 当安全沙箱。

## 优化 5：J5005 上保持轻量

一个 Web 应用服务、SQLite、可选向量索引即可；核心应用保持轻量，媒体转码与 3D 渲染通过可选 worker 执行，详见全流程设计。模型推理位置仍待用户确认。

保留一个生成任务的默认并发；后台导入/索引采用有界执行，正文保存有独立优先级。SSE 合并 token 更新，变更事件仅传资源 ID、revision 与必要摘要，避免把整本书反复广播到手机。

## 许可证与源码移植边界

本地 Pagekin 根 LICENSE 为 GPL-3.0；Reveric 根 LICENSE 为 AGPL-3.0；Reveric plugins/sdk/LICENSE 单独为 MIT。上述为文件事实，不能以 SDK 的 MIT 推断主程序也是 MIT。

本轮只提出设计，没有复制 Reveric 实现代码、提示词或资产。若后续直接移植，逐文件记录来源、许可证与修改范围，保留通知，并依据实际组合方式核对分发和网络提供源码义务；不能认为“拆成 sidecar”就自动免除义务。法律义务应以许可证原文及具体使用方式确认，本报告不作完整法律结论。

## 优先级与验收增量

P0（并入首版）：统一领域命令、保存队列、三类版本区分、事务 outbox、跨设备一次性审批。它们是原系统设计的细化，应替代重复机制，不再平行新建。

P1（稳定版后）：只读作品助手、结构化变更面板、按需工具检索；先验证现有 Pagekin agent 能力。P2：Reveric 数据交换适配器、受控插件。影音与 3D 已纳入后续 B/C/D 阶段总体交付，按全流程设计验收。Relay 和微信接入维持后续独立评估。

新增验收：AI 与手工保存竞争；两设备同时审批；提交后发布前崩溃仍可补发事件；历史检查点不随自动保存失控增长；候选未批准不改变正文；重放命令不重复产生领域效果。

若需要存量迁移，先定义中立 JSON 清单、稳定 ID 映射、正文/人物/蓝图字段映射与不支持字段报告，导入新副本并让用户核对；两个应用不能直接共写数据库。当前没有要求迁移 Reveric 的真实作品，因此只保留设计入口。
