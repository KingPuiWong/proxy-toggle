# proxy-toggle

`proxy-toggle` 是一个面向 macOS 的命令行工具，用来快速切换系统 HTTP/HTTPS 代理，默认适配本地代理场景（例如 whistle）。

## 功能特性

- 一条命令完成代理开启、关闭、切换、状态查看与网络服务列表查看。
- 同步管理 HTTP 与 HTTPS 代理状态。
- `on/off/toggle` 联动 `w2`，让系统代理与 whistle 服务状态保持一致。
- 省略网络服务参数时自动选择当前活动网络服务。
- 每次变更前自动保存快照，失败时自动回滚。
- 进程中断后自动执行上次未完成操作的恢复。
- 固定系统命令绝对路径并收敛子进程 `PATH`，执行链路更可控。

## 前置依赖

- macOS（依赖 `/usr/sbin/networksetup` 与 `/sbin/route`）。
- Node.js（终端可直接执行 `node`）。
- whistle CLI（`w2`，终端可直接执行 `w2`）。
- `127.0.0.1:8899` 可用（系统代理与 whistle UI 默认端口）。

## 安装

### 方式一：`npm link`（本地开发）

```bash
git clone https://github.com/KingPuiWong/proxy-toggle.git
cd proxy-toggle
npm link

proxy-toggle --help
```

### 方式二：`npm -g`（全局安装）

```bash
git clone https://github.com/KingPuiWong/proxy-toggle.git
cd proxy-toggle
npm install -g .

proxy-toggle --help
```

## 快速开始

```bash
# 1) 查看全部网络服务和当前代理状态
proxy-toggle list

# 2) 对指定网络服务开启代理（会联动启动 w2）
proxy-toggle on "Wi-Fi"

# 3) 打开 whistle UI
open http://localhost:8899/

# 4) 查看当前代理状态
proxy-toggle status "Wi-Fi"

# 5) 关闭代理并联动停止 w2，同时恢复默认 bypass 列表
proxy-toggle off "Wi-Fi"
```

## 命令说明

命令格式：

```bash
proxy-toggle <command> [service]
```

| 命令 | 说明 | `service` 参数 |
| --- | --- | --- |
| `on` | 开启 HTTP + HTTPS 代理（`127.0.0.1:8899`），并联动启动 w2（默认模式）与启用 Rules | 可选 |
| `off` | 关闭 HTTP + HTTPS 代理、恢复默认 bypass 列表，并联动停止 w2 | 可选 |
| `toggle` | 切换代理状态；复用 `on/off` 的同一套 w2 联动流程 | 可选 |
| `status` | 查看代理状态（enabled / partially enabled / disabled） | 可选 |
| `list` | 列出所有网络服务及其代理状态 | 固定为空 |
| `reset-bypass` | 将 bypass 列表恢复为默认值 | 可选 |

帮助命令：

```bash
proxy-toggle help
proxy-toggle -h
proxy-toggle --help
```

## 默认行为

### 默认代理地址

- Host: `127.0.0.1`
- Port: `8899`

### w2 联动行为

- `proxy-toggle on [service]` 会先执行 `w2 stop`，再执行 `w2 start --no-prev-options -p 8899`，随后调用 whistle CGI 将 `disabledAllRules` 置为 `0`（启用规则）。
- `proxy-toggle off [service]` 会在系统代理关闭后执行 `w2 stop`。
- `proxy-toggle toggle [service]` 复用 `on/off` 的同一套联动流程。

### 活动网络服务选择逻辑（省略 `service` 参数时）

1. 读取默认路由接口（`route -n get default`）。
2. 从 `networksetup -listnetworkserviceorder` 中匹配接口对应的服务。
3. 选择服务顺序列表中的第一个可用服务。
4. 选择 `networksetup -listallnetworkservices` 返回的第一个服务。

### 默认 bypass 列表

`off` 与 `reset-bypass` 会恢复为以下列表：

- `127.0.0.1`
- `192.168.0.0/16`
- `10.0.0.0/8`
- `172.16.0.0/12`
- `172.29.0.0/16`
- `localhost`
- `*.local`
- `<local>`

## 错误恢复与安全设计

- 每次执行 `on` / `off` / `reset-bypass` 时先采集快照（HTTP、HTTPS、bypass）。
- 操作失败时立即回滚到操作前状态。
- 崩溃恢复文件写入系统临时目录：`$TMPDIR/proxy-toggle-pending-<uid>.json`，权限为 `0600`。
- 下次运行命令时若发现未完成动作，会先自动恢复上一次状态再继续执行。
- 系统命令路径固定为 `/usr/sbin/networksetup` 与 `/sbin/route`。
- 系统命令执行使用受控 `PATH`：`/usr/sbin:/usr/bin:/bin:/sbin`。
- `w2` 执行使用扩展 `PATH`（当前终端 `PATH`、`w2` 所在目录、`/opt/homebrew/bin`、`/usr/local/bin` 与安全 `PATH`），保证 `w2` 脚本可找到 `node`。

## 常见问题（FAQ）

### 1) `Unknown service` 报错如何处理？

先运行 `proxy-toggle list` 获取精确服务名，再把服务名作为第二个参数传入。服务名包含空格时使用引号，例如 `"Wi-Fi"`。

### 2) `status` 显示 `partially enabled` 代表什么？

当前网络服务中 HTTP 与 HTTPS 代理存在一开一关状态。

### 3) 出现 `AuthorizationCreate() failed` 怎么办？

在有系统网络设置权限的终端会话中执行命令，然后再次运行 `proxy-toggle`。

### 4) 如何修改默认代理端口 `8899`？

编辑仓库根目录 `index.js` 中的 `PROXY_HOST` / `PROXY_PORT` 常量，然后重新执行安装流程（`npm link` 或 `npm install -g .`）。

### 5) 如何单独恢复 bypass 列表？

执行：

```bash
proxy-toggle reset-bypass
# 或指定网络服务
proxy-toggle reset-bypass "Wi-Fi"
```
