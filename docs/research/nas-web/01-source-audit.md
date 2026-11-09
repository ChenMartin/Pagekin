# 本地源码调研

基线与验证范围见 [README](README.md)。以下链接相对本目录，均指向实际源码；描述属于静态代码观察，未运行不等于已验证。

## 证据与改造入口

| 源码 | 发现 | 改造要求 |
| --- | --- | --- |
| [package.json](../../../package.json) | React 19、CodeMirror 6、Zustand、Vite；Electron 安装脚本；better-sqlite3、LanceDB 原生依赖 | 新增 Web/server 独立构建与依赖边界，生产镜像不安装 Electron |
| [vite.config.ts](../../../vite.config.ts) | 直接绑定 Electron main/preload 构建插件，开发服务绑定回环地址 | 独立 Web 配置，明确资源基路径和 SPA 回退 |
| [ipc-client.ts](../../../src/services/ipc-client.ts) | 无 aiNovelAPI 会抛错；大量通道附带活动项目会话；isElectron 根据桥存在判断 | 抽象能力与传输，不能伪造 Electron 环境让窗口接口进入浏览器 |
| [RendererStartup.tsx](../../../src/components/startup/RendererStartup.tsx) | 非 Electron 环境提前返回；启动依赖 startup IPC | 新增 Web 启动握手、登录、配置与工作区加载流程 |
| [database.ts](../../../electron/database.ts) | 模块级当前数据库与路径；打开项目会关闭旧项目 | ProjectContext 注册表，所有仓储显式注入项目数据库 |
| [project-access.ts](../../../electron/services/project-access.ts) | 单一 activeSession；路径键会转小写 | 区分用户会话与项目运行代次；Linux 路径保持大小写语义 |
| [windows-safe-file-system.ts](../../../electron/security/windows-safe-file-system.ts) | securePlatform 仅允许 win32/darwin，否则 SECURE_FS_UNSUPPORTED_PLATFORM | Linux 安全文件实现是必做项，不能靠容器解决 |
| [project-storage-preflight.ts](../../../electron/services/project-storage-preflight.ts) | Windows 路径长度校验在非 Windows 跳过 | 跳过路径长度检查不代表底层文件操作支持 Linux |
| [project-data-locator.ts](../../../electron/services/project-data-locator.ts) | 已有项目准入记录和规范化存储边界 | 保留格式校验，审计所有活动态与生命周期依赖 |
| [project-format.ts](../../../src/shared/project-format.ts) | 规范目录 .ai-novel，数据库 project.db；清单严格校验字段 | 不向旧 manifest 随意加 Web 字段，Web 元数据单独存储 |
| [generation-controller.ts](../../../electron/controllers/generation-controller.ts) | owner 按数据库组织，但授权仍取当前项目；订阅依赖 WebContents；关闭数据库暂停执行 | 独立于浏览器的 owner、显式上下文、事件发布接口 |
| [main-generation-owner.ts](../../../electron/services/main-generation-owner.ts) | 已有生成业务、预算与来源验证，同时引用当前项目函数 | 抽离依赖，保留业务约束和恢复语义 |
| [generation-run-repository.ts](../../../electron/repositories/generation-run-repository.ts) | 已有 run、attempt、artifact、预算、来源指纹；构造器支持注入 getDb，但默认使用全局数据库 | 复用账本；强制服务端显式注入，增加调度与事件元数据 |
| [generate-draft.command.ts](../../../src/services/workflows/commands/generate-draft.command.ts) | 前端 command 执行 runtime，之后调用 generation:commit-draft | 迁移完整工作流，不只替换一次 LLM 调用 |
| [main-generation-transport.ts](../../../src/services/generation/main-generation-transport.ts) | 冻结含项目路径的会话，校验 handle epoch | Web 使用服务端项目上下文；不把客户端声称的路径当权限 |
| [draft-version.ts](../../../electron/repositories/draft-version.ts) | 版本序号基于章节稿件 MAX(version) | 稿件业务版本不等于每次自动保存 revision，二者分离 |
| [ProseDocument.tsx](../../../src/components/stage/chapter/ProseDocument.tsx) | 恢复候选有保存与退出保存处理；修稿和项目文件可为只读；使用本地 contentRevision | 本地 revision 不等于服务端 CAS；分别审计各编辑入口，不将此组件等同全部正文编辑 |
| [lance-database.ts](../../../electron/lance-database.ts) | 固定 Lance 表数据格式 2.0，以维持回退可读性 | 不在迁移中顺便升级向量格式 |
| [pnpm-lock.yaml](../../../pnpm-lock.yaml) | 存在 LanceDB Linux x64/arm64、gnu/musl 包条目 | 上次仅凭根 optionalDependencies 推断缺 Linux 包不充分；仍需真实加载验证 |
| [pnpm-workspace.yaml](../../../pnpm-workspace.yaml) | 对原生依赖构建脚本有显式 allowBuilds 策略 | 核实目标 Node ABI、预编译包及安装策略，不能盲目允许全部脚本 |

## 对上一版方案的修正

1. Linux 安全文件层已确认拒绝，不再写成未知兼容性。
2. 并非所有后端仓储都必须推倒重写：生成仓储已有依赖注入入口，可逐步移除默认全局依赖。
3. 生成持久化已经存在。新增的是调度、执行归属和 Web 事件恢复，而不是替换全部生成记录。
4. “模型在主进程”并不意味着“完整工作流在服务端”。前端提交步骤必须随工作流迁移，否则关闭页面仍可能留在半完成状态。
5. 不能承诺手机界面现成可用；也不能由局部 UI 状态字段推断已有多设备同步保障。

## 下一轮全量审计项

- 非测试文件的 Electron 值导入、所有 IPC 调用、全局活动项目和配置单例依赖图。
- 草稿、架构、蓝图、人物、恢复候选各自的写入入口、事务及来源校验合同。
- 所有工作流中“等待用户确认”与“无人值守执行”边界。
- Linux 路径、符号链接、目录替换竞态、导入压缩包、头像、知识库及备份全链路。
- 模型凭据读写、代理设置、外部链接、原生选择器、更新与退出保护的替代策略。

这些属于实施前的审计交付，不在本次静态抽查后冒称已穷尽。没有可靠依据给出“可复用百分比”。
