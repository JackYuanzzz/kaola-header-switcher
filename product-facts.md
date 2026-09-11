# 发布文档事实依据

核验日期：2026-09-11。产品属于本仓库自身，事实以源文件、构建结果和 GitHub 实际页面为准，不用搜索缓存推断发布状态。

| 项目 | 已核验事实 | 依据 |
| --- | --- | --- |
| 名称与版本 | 有问题找kaola，1.0.2；包名 `kaola-header-switcher` | `public/manifest.json`、`package.json`、ZIP 中的 `manifest.json` |
| 公开源码 | `JackYuanzzz/kaola-header-switcher` | [GitHub 仓库](https://github.com/JackYuanzzz/kaola-header-switcher)，已通过 SSH 推送并在网页核验 |
| 平台 | Manifest V3，最低 Chrome 110；自动化运行于 Chromium | `public/manifest.json`、`playwright.config.ts` |
| 分发方式 | 源码独立构建；当前安装附件为 `kaola-header-switcher-1.0.2.zip`，可解压加载，不等于商店上架 | `scripts/package.mjs`；[GitHub Releases](https://github.com/JackYuanzzz/kaola-header-switcher/releases/latest)、[GitHub Release 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) |
| 请求修改 | 一个 Tab 一条规则；覆盖配置的同名字段，保留其余请求头；不限制目标域名 | `src/rules.ts`、`src/engine.ts` |
| 存储 | 规则在本地；Tab 绑定和表情在会话存储；没有规则云同步与分析上报 | `src/background.ts`、`src/engine.ts` |
| 验证 | v1.0.2 的 36 项单元测试、13 项 Chromium 端到端测试、类型检查、构建与 ZIP 完整性检查通过 | 本轮实际运行测试及打包命令的结果 |

截图中的地址、标题和规则均为演示数据。公开安装包只收录构建脚本列明的 11 个运行时文件，不收录浏览器存储、依赖目录、测试或文档素材。

设计初稿仅在本地保留，不纳入后续公开源码与 README。v1.0.2 统一分发命名与公开文档，保留已经推送的提交与标签，不更改旧标签指向。
