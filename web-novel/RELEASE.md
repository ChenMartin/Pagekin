# 书童 Web 小说工作区 v0.1.0-rc.1

发布日期为 2026-11-09。此候选版面向 Intel J5005 / fnOS / Docker Compose 的小说工作区实机测试。剧本、分镜和制片属于后续阶段。

发布包包括 Compose 配置、应用源码、桌面作品转换工具和整库维护命令。镜像文件另行提供，镜像名为 `pagekin-web-novel:0.1.0-rc.1`，平台为 `linux/amd64`。应用使用 Web SQLite schema 5。

## fnOS 快速部署

1. 解压部署 ZIP，把 `.env.example` 复制为 `.env`，填写至少 12 个字符的唯一访问密码。模型配置可留空，此时可正常手写、导入和导出。
2. 正式使用时，经 HTTPS 反向代理访问，保留 `APP_SECURE_COOKIE=1` 并填写实际的 `APP_ORIGIN`。如果只在可信的局域网里临时实测，可将 `PAGEKIN_BIND` 设为 NAS 的内网 IP，`APP_ORIGIN` 设为实际访问地址（如 `http://192.168.1.10:3100`），并设置 `APP_SECURE_COOKIE=0`。HTTP 联调时请使用测试稿件和独立密码。
3. 将镜像文件放到解压后的 Compose 目录，在 NAS 终端进入该目录执行。

```sh
docker load -i pagekin-web-novel-0.1.0-rc.1-linux-amd64.tar.gz
docker compose config --quiet
docker compose up -d --no-build --pull never
docker compose ps
```

镜像载入后即可离线启动。也可仅用部署 ZIP 通过 `docker compose up -d --build` 构建，首次构建需要拉取官方 Node 基础镜像。Dockerfile 固定了基础镜像摘要。

浏览器访问所配置的地址，登录后页头会显示 `v0.1.0-rc.1`。也可访问同一地址的 `/healthz`，预期返回 `{"ok":true,"version":"0.1.0-rc.1"}`。完整配置及升级恢复见 [使用说明](README.md)。

## 已验证

在 Ubuntu WSL 的 linux/amd64 Docker 上构建镜像，容器使用 Node.js 24.22.2，以非 root 用户运行。压缩镜像通过 `docker load`。解压后的部署包通过 Compose v2.40.3 离线启动、重启、在线整库备份与新卷恢复测试。镜像内 4 项测试和部署 ZIP 的 Edge 回归通过。AI 请求使用模拟服务测试。

## 实机验收

- 电脑和 iPad／手机打开同一章。验证中文输入、自动保存、新版提示和冲突对比。
- 断开一台设备的网络后继续写作，刷新并恢复本机草稿，再联网同步。
- 导入 TXT／Markdown 整稿和一份实际桌面归档，检查章节历史、定稿和导出。
- 可选配置你的兼容模型，预览上下文，再尝试生成、审稿和应用候选。
- 重启服务后确认小说、版本和伏笔仍在。保存一份整库快照，并恢复到另一数据卷试读。

应用版本和测试证据可一并写入反馈。使用两种不同网络地址访问会对应不同的浏览器本机草稿区，测试期间请保持访问地址一致。
