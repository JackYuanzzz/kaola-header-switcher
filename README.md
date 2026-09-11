# 有问题找kaola

给每个 Chrome 标签页单独选择一条请求头规则。同一个测试域名可以同时打开多个 Tab，分别使用不同的 `x-lane`。

在浏览器右上角的手绘风弹窗中直接新建、编辑、切换规则。界面使用 Rough.js 绘制真实 SVG 手绘线条，并配有卡通考拉图标。每条规则支持一组或多组请求头；只有每行的请求头内容必填，规则名称、规则简称及请求头名称都可以留空。

## 安装

这是一个可独立构建的浏览器扩展源码仓库，不需要安装其他项目。首次使用请先克隆并构建（需要 Node.js 22+、pnpm 9.15.0）：

```sh
git clone https://github.com/JackYuanzzz/kaola-header-switcher.git
cd kaola-header-switcher
pnpm install --frozen-lockfile
pnpm build
```

构建后会在仓库根目录生成可加载的 `dist/`。`dist/` 和 ZIP 不进入 Git，因此不能直接把 GitHub 下载的源码 ZIP 当作扩展安装。

1. Chrome 地址栏打开 `chrome://extensions`。
2. 打开右上角「开发者模式」，点击「加载已解压的扩展程序」。
3. 选择本仓库的 `dist/` 目录（不是其父目录，也不是 ZIP 文件）。
4. 在浏览器工具栏的扩展菜单中固定「有问题找kaola」（考拉图标）。
5. 打开需要联调的网页，点击扩展，新增规则：最少只需在「请求头内容」填写 `doc-20260910`，请求头名称会默认为 `x-lane`。也可以另外填写规则名称「文档联调」与简称 `DOC`。
6. 保存并启用到当前 Tab。首次 HTML 和已经加载的资源不会重发，需要时手动刷新页面。

最低支持 Chrome 110。Edge 等 Chromium 浏览器可尝试同样的开发者模式安装流程，但本项目的自动化验收使用 Chromium。

## 使用语义

- **一个 Tab 一条规则**：启用另一条会替换该 Tab 原来的规则。不同 Tab 互不影响。
- **最少只填请求头内容**：每行内容都必须有值，不能留空或只填空白。请求头名称留空时默认为 `x-lane`，重复字段仍会报错。规则名称和长度不限的规则简称可以留空；显示时自动取第一条非空请求头内容，之后修改内容时自动跟随。留空的名称与简称以空字符串保存，不会把自动显示值写死。
- **覆盖该 Tab 的所有可关联网络请求**：不限制请求域名，包括跨域接口、主页面、子框架、脚本、图片、样式、字体及 WebSocket 握手等。仅设置你配置的字段，其他请求头保留。非空请求头内容原样保存；派生的标题文案会合并多余空白，避免页面标题前缀重复。
- **局部停用**：停用仅移除当前 Tab 的修改，之后请求恢复网页自身提供的请求头。
- **共享规则编辑**：保存修改会更新所有正在使用该规则的 Tab；删除规则会解除这些 Tab 的绑定。
- **目录直接删除**：每条规则旁可直接点击「删除」，二次确认后才移除。删除其他规则会保留当前编辑区的未保存内容；若正在删除的规则有未保存修改，会先提示这些修改也将一并丢弃。
- **完整简称与醒目标识**：规则简称完整保存，网页标题使用 `🐨[完整简称] 原标题`，例如 `🐨[文档联调-20260910] 编辑器`。考拉和左方括号之间没有空格。仅工具栏角标受显示空间限制，显示简称的前 4 个可见字符（按字素分段，不拆开组合 emoji）。网页自己更新标题时保留完整前缀，停用后恢复原标题。
- **每个 Tab 自选标题表情**：在弹窗顶部的「标题表情」中填写一个表情，再点「保存表情」，标题会使用 `🦊[完整简称] 原标题` 等自选前缀。支持 `👩🏽‍💻` 这样的组合表情，留空保存恢复默认 `🐨`。表情只属于当前 Tab，即使两个 Tab 使用同一条规则也能选不同表情；不影响工具栏角标。未启用规则时也能先保存表情，停用规则后仍保留，重新启用时继续使用。保存表情不会丢失规则编辑区的未保存修改。
- **会话生命周期**：刷新、普通页面导航和扩展后台休眠保留 Tab 绑定及标题表情。关闭 Tab 自动清理。新建、复制 Tab 默认不继承规则，标题表情默认为 `🐨`。浏览器完全退出、扩展重新加载 / 更新后，需要重新选择 Tab 规则与标题表情；已保存规则仍然保留。

名称或简称留空会把请求头内容显示在目录或标签标题中；涉及敏感内容时，请显式填写不含敏感信息的规则名称和简称。

Chrome 内置页面、扩展页面、Chrome Web Store 不能启用。网页 Service Worker 的 CacheStorage 响应不经过网络，且没有关联 Tab 的后台请求无法按 Tab 分流。规则只作用于之后发出的请求，不能更改正在进行的请求、已建立的连接或网页缓存内容。不同 lane 共用同一浏览器 Profile 的 Cookie、站点缓存和登录状态；按 Tab 改头不会隔离这些数据。与其他改请求头扩展同时启用时，最终结果还受到 Chrome 的规则优先级影响。

规则不限制域名，因此配置的头也会发往当前 Tab 请求的第三方地址。此工具适合测试 lane；不要在全域规则中填写只应发送给某一个站点的密钥。

## 本地开发

这是一个独立 pnpm 项目，有自己的 workspace、依赖和 lockfile。Node.js 22+，pnpm 9.15.0。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck:e2e
pnpm exec playwright install chromium
pnpm test:e2e
pnpm package
```

修改源码后重新构建，再在 `chrome://extensions` 点击扩展的重新加载按钮。`pnpm package` 在插件目录生成 `lane-header-switcher-1.0.1.zip`，解压后按上述步骤加载。构建产物不包含设计原型、测试或依赖。

### 1.0.1 状态同步修复

关闭标签页与导航完成事件可能交错，旧版会将已关闭标签页的角标更新失败误报为「状态同步失败」。新版仅忽略对应标签页的原生 `No tab with id` 错误，仍完成绑定清理，并保留同批次其他异常。真正的失败会显示事件来源、初始化/执行阶段和错误类别，不记录请求头内容或网页 URL。

升级时重新加载 `dist/` 即可，无需卸载扩展或清空规则。错误页中的旧历史记录可手动清除后再观察；如果新版仍重复报错，请提供包含来源与类别的新提示。

## 实现与权限

- 严格 TypeScript + 原生 DOM，Rough.js 与扩展一起由 esbuild 本地打包；无远程脚本、CDN 请求或分析上报。
- `declarativeNetRequestWithHostAccess` + `<all_urls>`：由 Chrome 原生 `modifyHeaders` 会话规则执行请求头修改，`tabIds` 限定到当前 Tab；不代理、读取或上传响应内容。
- `storage`：规则保存在 `storage.local`，Tab 绑定、标题表情与中断恢复日志在 `storage.session`。请求头内容只允许扩展自己的可信页面读取；内容脚本只能读取所属 Tab 的规则简称和标题表情。规则未加密，不同步到云端。
- `tabs`：读取当前网页标题 / URL、定位 Tab、监听关闭与替换。`scripting` 和内容脚本用于添加 / 恢复标签标题前缀，并支持扩展安装前已打开的网页。
- 所有写操作在后台串行执行；DNR 原子替换，持久化失败回滚，Service Worker 重启时从会话日志恢复。

核心入口：`src/background.ts`（消息与生命周期）、`src/engine.ts`（状态同步）、`src/rules.ts`（校验与规则编译）、`src/content.ts`（Tab 标题）、`src/popup.ts`（交互）。

测试包括真实 Chromium 扩展加载与本地 HTTP 回显、相同 URL 多 Tab 隔离、主页面 / 子资源 / 跨域请求、多请求头、共享规则更新、目录删除确认与草稿保留、超长 / emoji 简称、每个 Tab 独立标题表情、手绘 SVG 与图标加载，以及状态写入失败、Worker 重启恢复和扩展重载后的标题清理。测试使用独立的临时浏览器配置，不读取日常浏览器 Profile。最新弹窗截图生成在 `artifacts/sketch-popup.png`。

参考：[Chrome DNR](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)、[Action 角标](https://developer.chrome.com/docs/extensions/reference/api/action)、[Storage](https://developer.chrome.com/docs/extensions/reference/api/storage)、[Rough.js](https://roughjs.com/)。视觉设计使用 [huashu-design](https://github.com/alchaincyf/huashu-design)，早期方案原型在 `design-demos/` 中保留。
