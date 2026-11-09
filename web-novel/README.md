# 书童 Web 小说工作区

fnOS 候选版的镜像载入、配置和验收步骤见 [v0.1.0-rc.1 发布说明](RELEASE.md)。

这是第一阶段可运行的 Web 版本。书房内可管理多个作品，维护设定与架构、人物卡、章节蓝图和正文。正文支持版本历史、定稿与重新打开。支持 UTF-8 TXT/Markdown 的单章和整稿导入、Markdown 导出，以及 Web 作品 JSON 备份和恢复。章节重开后，导出定稿和后续写作仍使用上一次定稿，确认新定稿时才换版。

## 本机启动

使用 Node.js 24。在 PowerShell 中从本目录执行，访问 http://127.0.0.1:3100。直接启动可使用普通文本编辑器。

```powershell
$env:APP_PASSWORD = Read-Host "设置一个至少 12 字符的访问密码"
$env:APP_SECURE_COOKIE = '0'
node server.mjs
```

本机数据默认位于 `web-novel/data`。通过 `APP_DATA_DIR` 可指定独立目录。一个数据目录对应一个运行实例。

如需从源码在本机使用增强编辑器，在启动前运行 `npm ci --ignore-scripts` 和 `npm run build:editor`。从当前源码构建 Docker 镜像时会自动完成这一步，首次构建需访问 npm registry。设置 `APP_EDITOR=plain` 可为输入法兼容排查启用普通文本编辑器。

## fnOS 部署

在 J5005 的 `linux/amd64` Docker 主机上，将本目录作为 Compose 项目，复制 `.env.example` 为 `.env` 并填写密码。在目录中执行以下命令。

```sh
docker compose up -d --build
docker compose ps
```

Compose 默认监听 NAS 宿主机的回环地址。用宿主机上的 HTTPS 反向代理转发到 `127.0.0.1:3100`，将 `APP_ORIGIN` 填为浏览器实际使用的 HTTPS 地址。若代理运行在容器内，可将代理接到同一个 Docker 网络并转发到 `pagekin:3100`。

反向代理需要允许项目事件流持续连接。对 `/api/projects/<id>/events` 关闭响应缓冲，将读取超时设置为至少 60 秒。服务每 15 秒发送一次保活消息。

受信任局域网内临时联调时，可将 `PAGEKIN_BIND` 设为 NAS 的内网地址，`APP_ORIGIN` 设为实际 HTTP 地址及端口，`APP_SECURE_COOKIE` 设为 `0`。HTTP 会明文传输密码和正文，正式使用请配置 HTTPS。

作品和登录会话存放在 `PAGEKIN_VOLUME` 指定的命名卷，默认名称为 `web-novel_novels`。升级时保留原卷名和 `.env`，避免换目录后连到空库。若已有测试部署，先确认旧容器的实际数据卷名称，再填入 `PAGEKIN_VOLUME`。应用内 JSON 备份适合单部作品，恢复上限为 24 MB。整库备份可在服务运行时生成。

## 整库备份和恢复

在 NAS 的 Compose 目录执行。快照文件名应选未使用的名称，建议复制一份到 NAS 之外。

```sh
docker compose exec -T pagekin node maintenance.mjs backup /data/backups/before-upgrade.sqlite
docker compose exec -T pagekin cat /data/backups/before-upgrade.sqlite > before-upgrade.sqlite
```

整库恢复使用新的空数据卷。先备份并停止原服务，然后运行下面的命令。确认返回的作品数量符合预期后，将 `.env` 中的 `PAGEKIN_VOLUME` 改为新卷名称，再启动服务并重新登录。

```sh
docker compose stop pagekin
PAGEKIN_VOLUME=web-novel_novels_recovered docker compose run --rm --no-deps -T pagekin node maintenance.mjs restore < before-upgrade.sqlite
```

确认结果并更新 `.env` 后，再执行 `docker compose up -d --no-build --pull never`。恢复工具会检查数据库版本和完整性，并清除恢复副本中的旧登录会话。原卷保留，可停服务后换回原卷。若回滚涉及数据库升级，应同时使用升级前的快照和相应版本的镜像。

首次部署后，用电脑和另一台设备分别打开同一测试章节。先在电脑保存，确认另一台收到新版提示，再在两端修改同一章，核对冲突对比中的两份正文。最后重启 Compose 服务，确认作品和历史版本仍能打开，并做一次备份恢复。iPad 和手机可一并验证中文输入、旋转屏幕和切回前台后的保存。

## 保存与 AI

正文上方可打开“查找／替换”，也可按 Ctrl+F 或 Cmd+F。支持跳到上一处或下一处、区分大小写、替换当前或全部匹配。替换按普通文本处理，全部替换会显示确认；继续编辑前可通过“撤销替换”还原最近一次替换。定稿允许查找。正文可用“上一章”和“下一章”切换，未同步稿件沿用本机草稿保护。

构建增强编辑器资源后，正文默认使用 CodeMirror 6，提供 Markdown 语法高亮、自动换行和键盘撤销／重做。切换文档会重置编辑器内的撤销记录，各章持久化版本可从“历史版本”查看。

编辑时写入 IndexedDB 本机草稿。停止输入约 1.5 秒后提交，前台持续输入每 10 秒兜底提交。状态栏在收到服务器确认后显示已保存到 NAS。断网重新连接会重试。刷新后打开对应文档，点“查看本机草稿”比较和恢复。同一章节被另一设备更新时，界面提示比较两稿，服务端保留较新的版本，直到作者选择如何处理。

其他设备保存后，已打开的章节会显示“NAS 上有更新，查看最新版本”。点击可加载新版。有未同步编辑时会保留本机稿，并提供冲突对比。短暂掉线后可补收事件，超出保留窗口时重新读取目录和版本。书名可在作品菜单中修改。

在 `.env` 中配置 `LLM_BASE_URL`、`LLM_MODEL` 和所需的 `LLM_API_KEY` 后，打开未定稿章节使用写稿、审稿或修稿。模型服务需支持 OpenAI Chat Completions 的 SSE 流式响应，地址填写 API 根路径，例如 `https://api.openai.com/v1`。携带密钥的模型请求要求 HTTPS。模型收到章节正文及本次选取的作品资料。

任务在 NAS 上执行，浏览器轮询已保存的结果。AI 写稿及修稿输出先保留为候选，应用时校验正文和引用资料版本。可在审稿结果中选中文字，通过“加入修稿要求”用于后续修稿。服务重启会保留已收到的输出，任务标为中断。

用“预览发送内容”检查本次模型输入。默认上限为 64,000 字符，可用 `LLM_CONTEXT_CHARS` 配置。它是应用侧字符预算，模型自身的 token 上限仍适用。预览和正式任务都保留当前正文全文，按预算取本章蓝图、最近定稿节选、选定资料、相关伏笔及人物设定。若正文和作者要求本身已超出预算，服务会在发起模型请求前提示。

在“参考资料”中导入 UTF-8 TXT 或 Markdown。“搜索作品”按标题或原文检索本作品的正文、设定、人物、蓝图与资料。打开未定稿章节后可选最多五份参考资料用于本次 AI 任务，每份最多取 1500 字符。可填定位词提取匹配位置附近的内容，并在预览中检查。作品备份包含参考资料。

在“剧情线索与伏笔”中记录埋设章、预计回收章和实际回收章，按计划埋设、待回收、已回收和已归档筛选。写稿、审稿和修稿可读取当前章相关的线索，旧候选在所引用的线索变化后需重新生成。作品备份包含线索和回收记录。

## 从 Pagekin 桌面版导入

用 Pagekin 桌面版导出作品备份，在 Web 书房点击“恢复备份”并选择 `.ainovel` 文件。支持 Pagekin 原始归档格式 v1 和桌面数据库 schema 7–9。单个归档上限为 48 MB，转换后的作品上限为 24 MB。通过 HTTPS 反向代理访问时，代理的上传限制也要允许对应大小。导入时会检查归档清单、各文件校验值和数据库版本，然后创建独立的 Web 作品。

如果手上只有项目文件夹，可以退出桌面版，从本目录用转换工具处理其中的 `.ai-novel/project.db`，再在 Web 书房恢复生成的 JSON。

```powershell
node desktop-copy.mjs 'D:\作品\我的小说\.ai-novel\project.db' '.\我的小说-Web.json'
```

两种方式都导入设定、人物卡、蓝图、正文和草稿历史，保留定稿与重开稿的关系。头像、桌面知识库、模型配置和运行记录需另行处理。数据库文件仍有 WAL 或回滚日志时，转换工具会提示关闭桌面版后重试。原归档和源数据库可继续在桌面版使用。

升级时保留完整数据卷备份。新版启动会将 Web SQLite schema 升级到 v5，增加整稿导入回执、同步事件和剧情线索。

## 导入 TXT 或 Markdown 整稿

在作品里点击“导入整稿”并选择 UTF-8 文件。可识别“第十二章”“第 12 章”“Chapter 12”等独立标题及其 Markdown 写法。预览可展开查看每章开头、逐章勾选，选择保留原章号或从指定章号连续编号。首个章标题之前的文字归入首章。没有章标题的文件作为一章预览。

导入后的章节为草稿。若提交时有章号被占用，整批撤回，可调整编号后重试。同一份预览在连接中断后按原选择重试，会复用原回执。每次可选 1–500 章，文件上限 8 MB，单章上限 180,000 字符。

## 当前实现范围

此版本使用独立 Web 入口和 Web SQLite schema。从当前源码构建的镜像含增强编辑器，v0.1.0-rc.1 已发布的离线镜像使用普通文本编辑器。原有生成流程的完整复用、知识库语义检索和移动真机验收仍在后续范围。

```sh
node --test smoke.test.mjs
```

可选浏览器回归检查。将 `BROWSER_EXE` 指向 Edge 或 Chromium 的可执行文件，再运行 `node browser-smoke.mjs`。可设置 `PAGEKIN_TEST_EDITOR=enhanced` 或 `plain` 强制检查对应模式。增强模式测试包括浏览器合成中文输入事件。测试使用独立的临时浏览器配置和 SQLite 数据库。
