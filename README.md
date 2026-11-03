# Copilot Proxy Plugin for ChatGPT / Codex

把本机已有的 GitHub Copilot 账户接入 **本地 Codex 桌面会话**。插件负责账户选择、provider 配置和代理进程启动，不需要每次打开终端启动代理，也不强制重新登录。

适用于支持本地插件和 hooks 的 Codex 桌面端，以及桌面应用中的本地 Codex 模式。**不能替换普通 ChatGPT 云端聊天的主模型**。这是社区 Copilot API 适配器，不是 GitHub 或 OpenAI 的官方 provider。

## 安装

需要 Node.js **22+**、Codex CLI，以及支持本地插件的桌面端。仓库已包含可直接运行的 bundle，使用者无需 `npm install`。

```powershell
codex plugin marketplace add yishanby/CopilotProxyPluginForChatGPT
codex plugin add copilot-provider@yishanby-copilot
```

也可在桌面端 **Plugins Directory → Yishanby Copilot** 中安装。开发时，在 checkout 中运行 `./scripts/install.ps1`，或将第一条命令的仓库名替换为 checkout 的绝对路径。

1. 重启桌面端，启用 **Copilot Provider**，运行插件的 Setup 流程（也可以要求它使用 `$copilot-setup`）。
2. 插件打开本地账户选择页，选择 **账号 + 主机 + 凭据来源**。选择后会验证该账号的 Copilot 权限并列出可用的 Responses 模型。
3. 点击 **Use this account and model**，完成一次性 provider 配置；重启 Codex 开始新会话。
4. 在 **Settings → Hooks / Review hooks** 中审阅并信任插件的启动钩子。插件不能替用户授予该信任。

首次 Setup 必须从**安装后的插件**执行，避免 provider 指向后来被移动的源码目录。首次配置前仍需一个可用的 Codex 会话来运行 onboarding。

## 已有账号与 GHE

自动检测以下已知本地来源，不扫描所有用户文件或 VS Code 私有数据库：

| 来源 | 读取方式 |
| --- | --- |
| GitHub CLI | 枚举全部主机和账户；通过明确的 `--hostname`、`--user` 获取指定账户的凭据 |
| GitHub Copilot CLI | 当前账户配置、对应系统 keyring，以及 CLI 的账户专用明文存储选项 |
| 旧 Copilot 客户端 | 已知配置目录中的 `hosts.json` / `apps.json` |
| DevMoor | 本地账户索引和各账户的授权文件，含旧版只读 DPAPI 格式 |
| 显式添加的凭据文件 | 使用 `add-credential-file` 登记已有 JSON 授权导出；不复制 token |

支持 `github.com` 与 GitHub Enterprise Cloud 数据驻留主机，例如 `company.ghe.com`。GHE 使用 `https://api.company.ghe.com` 交换 token，且只能使用该租户返回的 Copilot endpoint；不会失败后切换到公共 GitHub。自建 GHES 域名不属于这个支持范围。

同一个用户名出现在不同凭据来源中会分别显示。普通 GitHub CLI 登录不保证有 Copilot 权限；验证失败会明确显示，用户可选择已经有 Copilot 授权的来源，例如 DevMoor。切换只影响此插件，不调用 `gh auth switch`，也不切换 DevMoor 的活动账号。

源凭据完全只读，GitHub token 不写入插件状态、网页、日志或 Codex 配置。插件在使用时重新读取源凭据，短期 Copilot token 仅存在内存中。源 OAuth token 过期时应在原应用中刷新；插件不会抢用其它应用的 refresh token。

## 自动启动与模型

```text
Codex → 本机 127.0.0.1 上的私有代理 → 所选账户的 Copilot 模型
```

- `SessionStart` 钩子在开始或恢复会话时确保代理就绪；它不是应用进程的全局启动事件。
- provider 的 command-backed authentication 也会确保代理已启动，覆盖早于会话钩子的模型请求。它只向 Codex 输出本地随机网关 key，不输出上游凭据。
- 多会话共用一个进程；启动使用锁和健康检查。不会因关闭一条聊天而终止所有其它聊天的代理。
- 插件包路径或 build 变化时检查正在运行的版本。空闲旧版本可以切换；仍有请求时先完成请求再重试，避免中途替换。
- Responses、SSE 和工具调用交给 Codex 执行；本项目不启动第二层 Copilot agent。
- 只列出账户实际声明支持 `/responses` 的模型。模型选择在插件设置页进行，不承诺改写宿主原生模型选择器。Codex 使用自身已有的模型元数据；不认识的模型会使用客户端的通用 fallback，并可能显示警告。
- 不使用 `service_tier`；保留工具调用 ID、工具结果和历史。参考 DevMoor 修复流式 output item ID 与多代理明文消息兼容问题。

## 配置、切换与卸载

再次运行 Setup 即可选择另一个账号或模型。当前已发出的请求保持原账号；后续请求使用新选择，建议新建会话以避免跨账号重放不可解密的历史。

默认数据目录为 `CODEX_HOME/copilot-proxy`；未设置 `CODEX_HOME` 时为用户的 `.codex/copilot-proxy`。测试或独立实例可用 `COPILOT_PROXY_HOME` 指定数据目录。默认端口为 `43128`，仅监听 `127.0.0.1`。

配置只修改用户 `config.toml` 中的 `model`、`model_provider` 和自有 `copilot-local` 表，不改沙箱、审批设置、`auth.json` 或其它 provider。原文件会先备份，并记录可恢复的修改；后续无关编辑会保留。如果用户修改了插件拥有的字段，恢复会停止并提示冲突。

如果保存账号/模型时磁盘写入失败或进程中断，新推理请求会暂停，避免把新模型配置发到旧账号。修复写入问题后重新打开 Setup 并再次应用选择即可完成恢复；未完成的选择需要先处理，再卸载。

以下命令中的 `<CLI>` 是安装后插件中的 `dist/cli.mjs` **绝对路径**：

```text
node <CLI> setup                       打开账号/模型选择页
node <CLI> accounts                    只列账号元数据
node <CLI> add-credential-file <路径>   登记额外的已有凭据文件
node <CLI> status                      查看服务和选择状态
node <CLI> stop                        停止本插件的服务
node <CLI> restore                     恢复 provider 配置，再停止服务
```

卸载前先运行 `restore`，然后在应用里移除插件，或使用 `codex plugin remove copilot-provider@yishanby-copilot`。删除插件本身不会自动修复指向它的 provider 配置。配置端口需要变更时，先恢复配置，再使用 `setup --port <端口>` 重新设置。

本地管理页需要每次 Setup 带入的本地授权，不开放跨站访问。上游 token 不进入浏览器；本地网关 key 通过 URL fragment 交给页面并立即从地址栏移除。不要分享整个已打开的浏览器会话。

## 开发与验证

```powershell
npm ci
npm run check
```

`npm run build` 把代码和 TOML parser 打成单个运行文件，提交时应包含更新后的 `plugins/copilot-provider/dist/cli.mjs`。CI 在 Windows 和 Linux 上运行离线测试并检查 bundle 是否同步。

测试覆盖账户/主机隔离、只读凭据来源、注销与过期、配置备份和恢复、并发启动、请求取消、SSE、工具调用和真实配置模块集成。在线推理需要自己的有效 Copilot 账户，不在 CI 中运行，也不在仓库保存测试凭据。

公开插件目录目前不接受包含 lifecycle hooks 的插件，因此使用手动安装的本地/私有插件源。

## 参考与许可

- [OpenAI 插件安装和打包](https://developers.openai.com/plugins/build/plugins)
- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Codex 自定义网关](https://developers.openai.com/codex/enterprise/connect-to-a-gateway)
- [DevMoor](https://github.com/yishanby/DevMoor)：账户存储、GHE 与 Responses 兼容处理参考。

MIT；打包依赖及参考实现的版权说明见 [THIRD_PARTY_NOTICES.md](plugins/copilot-provider/THIRD_PARTY_NOTICES.md)。
