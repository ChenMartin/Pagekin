# 小说工作区优化清单

对照原版纸墨界面、创作流程及选段／审稿演示。 [原版实机图文](https://www.orz.md/ai-novel-writer/#project-readme) · [选段与审稿演示](https://www.orz.md/ai-novel-writer/demo/) · [原版源码](https://github.com/EthanYoQ/Pagekin)

- [x] 将小说工作区改为章节目录、稿纸和写作助手。目录可按标题或章号定位、筛选和分页，移动端可折叠。
- [x] 在蓝图提供“写第 N 章”，可为本次写稿选模型。正文选段直接提供续写、润色、扩写和改成对话，比较局部改动后由作者应用。
- [x] 重开章节可恢复待处理的审稿或修稿。并排显示差异，支持保留原稿、采用修稿和手动编辑单处差异。
- [x] Edge 普通编辑器和 CodeMirror 验证目录、窄屏、离线草稿、选段、分页合并和蓝图写稿。Windows 和 Linux amd64 各通过 8 项 HTTP 回归。Compose 验证从 `dev.14` 升级并恢复独立数据卷，部署 ZIP 解包构建通过。
