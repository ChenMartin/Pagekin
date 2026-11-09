# 书童 Web 小说工作区 v0.1.0-rc.2

此候选版面向 Intel J5005 / fnOS / Docker Compose。包括参考资料语义检索、写前细纲、逐条审稿、按段应用修订、批量写作、分阶段写作 Skill 和中断续跑。

部署 ZIP 包括 Compose 配置、应用源码、桌面作品转换工具和整库维护命令。镜像名为 `pagekin-web-novel:0.1.0-rc.2`，平台为 `linux/amd64`，使用 Web SQLite schema 10。可用随包提供的 `SHA256SUMS.txt` 核对两个文件。

## fnOS 快速部署

1. 解压部署 ZIP，把 `.env.example` 复制为 `.env`，填写至少 12 个字符的唯一访问密码。模型配置可留空，此时可正常手写、导入和导出。
2. 正式使用时，经 HTTPS 反向代理访问，保留 `APP_SECURE_COOKIE=1` 并填写实际的 `APP_ORIGIN`。如果只在可信的局域网里临时实测，可将 `PAGEKIN_BIND` 设为 NAS 的内网 IP，`APP_ORIGIN` 设为实际访问地址（如 `http://192.168.1.10:3100`），并设置 `APP_SECURE_COOKIE=0`。HTTP 联调时请使用测试稿件和独立密码。
3. 将镜像文件放到解压后的 Compose 目录，在 NAS 终端进入该目录执行。

```sh
docker load -i pagekin-web-novel-0.1.0-rc.2-linux-amd64.tar.gz
docker compose config --quiet
docker compose up -d --no-build --pull never
docker compose ps
```

镜像载入后即可离线启动。也可仅用部署 ZIP 通过 `docker compose up -d --build` 构建，首次构建需要拉取官方 Node 基础镜像。Dockerfile 固定了基础镜像摘要。

浏览器访问所配置的地址，登录后页头会显示 `v0.1.0-rc.2`。也可访问同一地址的 `/healthz`，预期返回 `{"ok":true,"version":"0.1.0-rc.2"}`。完整配置见 [使用说明](README.md)。

## 从 v0.1.0-rc.1 升级

在原 Compose 目录运行以下命令，将升级前的整库快照复制到容器外，并停止旧服务。

```sh
docker compose exec -T pagekin node maintenance.mjs backup /data/backups/before-rc2.sqlite
docker compose cp pagekin:/data/backups/before-rc2.sqlite ./before-rc2.sqlite
docker compose stop pagekin
```

把原 `.env` 复制到新包目录，保留原端口、访问地址、项目名和 `PAGEKIN_VOLUME`，再按上面的命令载入和启动新镜像。新服务启动时会升级原卷。需要回到 rc.1 时，用升级前的快照恢复到独立卷，再用旧 Compose 和旧镜像启动。 [备份与恢复](README.md#fnos-部署)

## 已验证

在 Ubuntu WSL 用 Docker Compose v2.40.3，从 rc.1 升级到 rc.2，SQLite 从 schema 5 升至 10，原正文和历史可读。离线镜像重新载入、服务重启、在线备份和独立卷恢复均通过。Windows 和 Linux amd64 容器的 HTTP 回归各通过 4 项，Edge 普通编辑器与 CodeMirror 的全流程回归均通过。AI 流程使用模拟模型。

## 实机验收

- 电脑和 iPad／手机打开同一章。验证中文输入、自动保存、新版提示和冲突对比。
- 断开一台设备的网络后继续写作，刷新并恢复本机草稿，再联网同步。
- 导入 TXT／Markdown 整稿和一份实际桌面归档，检查章节历史、定稿和导出。
- 可选配置你的兼容模型，预览上下文，再尝试生成、审稿和应用候选。
- 重启服务后确认小说、版本和伏笔仍在。保存一份整库快照，并恢复到另一数据卷试读。

应用版本和测试证据可一并写入反馈。使用两种不同网络地址访问会对应不同的浏览器本机草稿区，测试期间请保持访问地址一致。
