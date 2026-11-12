# 书童 Web 工作区 v0.2.0-rc.1

本页对应 GitHub 上已发布的候选镜像。开发分支 `0.2.0-dev.15` 的构建、备份和 schema 25 升级见 [当前部署说明](README.md#fnos-部署)。

此候选版面向 Intel J5005 / fnOS / Docker Compose。在小说工作区加入剧本改编，可按季、集和场次组织短剧或漫剧，编辑动作、对白、转场与字幕，确认剧本并导出 Markdown。分集关联明确的小说定稿版本，源章更新时仍可读原文。剧本编辑在浏览器自动暂存，由作者保存到 NAS。

部署 ZIP 包括 Compose 配置、应用源码、桌面作品转换工具和整库维护命令。镜像名为 `pagekin-web-novel:0.2.0-rc.1`，平台为 `linux/amd64`，使用 Web SQLite schema 11。可用随包提供的 `SHA256SUMS.txt` 核对部署包和镜像。

## fnOS 快速部署

1. 解压部署 ZIP，把 `.env.example` 复制为 `.env`，填写至少 12 个字符的唯一访问密码。模型配置可留空，此时可正常手写、导入和导出。
2. 正式使用时，经 HTTPS 反向代理访问，保留 `APP_SECURE_COOKIE=1` 并填写实际的 `APP_ORIGIN`。如果只在可信的局域网里临时实测，可将 `PAGEKIN_BIND` 设为 NAS 的内网 IP，`APP_ORIGIN` 设为实际访问地址（如 `http://192.168.1.10:3100`），并设置 `APP_SECURE_COOKIE=0`。HTTP 联调时请使用测试稿件和独立密码。
3. 将镜像文件放到解压后的 Compose 目录，在 NAS 终端进入该目录执行。

```sh
docker load -i pagekin-web-novel-0.2.0-rc.1-linux-amd64.tar.gz
docker compose config --quiet
docker compose up -d --no-build --pull never
docker compose ps
```

镜像载入后即可离线启动。也可仅用部署 ZIP 通过 `docker compose up -d --build` 构建，首次构建需下载 Node 基础镜像和编辑器构建依赖。Dockerfile 固定了基础镜像摘要。

浏览器访问所配置的地址，登录后页头会显示 `v0.2.0-rc.1`。也可访问同一地址的 `/healthz`，预期返回 `{"ok":true,"version":"0.2.0-rc.1"}`。完整配置见 [使用说明](README.md)。

## 从 v0.1.0-rc.2 升级

在原 Compose 目录运行以下命令，将升级前的整库快照复制到容器外，并停止旧服务。

```sh
docker compose exec -T pagekin node maintenance.mjs backup /data/backups/before-020-rc1.sqlite
docker compose cp pagekin:/data/backups/before-020-rc1.sqlite ./before-020-rc1.sqlite
docker compose stop pagekin
```

把原 `.env` 复制到新包目录，保留原端口、访问地址、项目名和 `PAGEKIN_VOLUME`，再按上面的命令载入和启动新镜像。新服务会将原数据卷从 schema 10 升到 11。需要回到 `v0.1.0-rc.2` 时，用升级前的快照恢复到独立卷，再用旧 Compose 和旧镜像启动。 [备份与恢复](README.md#fnos-部署)

## 已验证

Windows 和 Linux amd64 容器的 HTTP 回归各通过 4 项。Edge 在普通编辑器和 CodeMirror 两种模式下通过了小说与剧本全流程测试。离线镜像成功重新载入。在 Ubuntu WSL 上用 Docker Compose v2.40.3 验证了从 `v0.1.0-rc.2` 升级、SQLite schema 10 → 11、离线启动、重启和在线备份。独立卷恢复后，已确认剧本、关联定稿和剧本历史均可读。AI 流程使用模拟模型。

## 实机验收

- 电脑和 iPad／手机打开同一章。验证中文输入、自动保存、新版提示和冲突对比。
- 断开一台设备的网络后继续写作，刷新并恢复本机草稿，再联网同步。
- 导入 TXT／Markdown 整稿和一份实际桌面归档，检查章节历史、定稿和导出。
- 从已定稿章节新建剧本集，编辑场次后刷新页面，检查本机草稿恢复。保存、确认并导出剧本，再改写源章并核对旧定稿引用。
- 可选配置你的兼容模型，预览上下文，再尝试生成、审稿和应用候选。
- 重启服务后确认小说、历史、伏笔和剧本仍在。保存一份整库快照，并恢复到另一数据卷试读。

应用版本和测试证据可一并写入反馈。使用两种不同网络地址访问会对应不同的浏览器本机草稿区，测试期间请保持访问地址一致。
