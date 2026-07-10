# proxy-toggle

`proxy-toggle` 是一个面向 macOS 的命令行工具，用来快速切换系统 HTTP/HTTPS 代理，默认适配本地代理场景（例如 whistle）。

## 功能特性

- 一条命令完成代理开启、关闭、切换、状态查看与网络服务列表查看。
- 同步管理 HTTP 与 HTTPS 代理状态。
- 省略网络服务参数时自动选择当前活动网络服务。
- 每次变更前自动保存快照，失败时自动回滚。
- 进程中断后自动执行上次未完成操作的恢复。
- 固定系统命令绝对路径并收敛子进程 `PATH`，执行链路更可控。

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
# 1) 如果使用 Whistle，先安装并启动本地代理服务
npm i -g whistle
w2 start -p 8899

# 2) 查看全部网络服务和当前代理状态
proxy-toggle list

# 3) 对活动网络服务开启代理
proxy-toggle on

# 4) 查看活动网络服务代理状态
proxy-toggle status

# 5) 对指定网络服务执行操作（服务名含空格时使用引号）
proxy-toggle on "Wi-Fi"
proxy-toggle status "Wi-Fi"

# 6) 关闭代理并恢复默认 bypass 列表
proxy-toggle off
```

## 命令说明

命令格式：

```bash
proxy-toggle <command> [service]
```

| 命令 | 说明 | `service` 参数 |
| --- | --- | --- |
| `on` | 开启 HTTP + HTTPS 代理（`127.0.0.1:8899`） | 可选 |
| `off` | 关闭 HTTP + HTTPS 代理，并恢复默认 bypass 列表 | 可选 |
| `toggle` | 切换代理状态：任一协议处于开启态时走关闭流程 | 可选 |
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

`proxy-toggle` 只修改 macOS 系统代理设置，不会安装或启动 `whistle` / `w2`。如果 `127.0.0.1:8899` 没有本地代理服务在监听，浏览器也无法打开 `http://127.0.0.1:8899/#rules`。

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
- 子进程 `PATH` 固定为 `/usr/sbin:/usr/bin:/bin:/sbin`。

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
