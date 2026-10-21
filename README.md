# HRC — Hermes Remote Control

> 让 AI Agent（Hermes / Claude 等）**远程接管你的 Chrome / Edge 浏览器**的完整方案。
> 一个扩展 + 一个零依赖中转服务，把真实的浏览器变成 Agent 可编程的双手和眼睛。

<p align="center">
  <img src="extension/icon.png" width="128" alt="HRC icon"/>
</p>

## ✨ 特性

- 🖱️ **真实事件级控制** — 点击、键入、滚动通过 CDP `Input.*` 派发真实输入事件，非 JS 注入模拟，与真人操作无差别
- 👁️ **视觉 + DOM 双通道感知** — 整页截图（给多模态模型看）与任意 JS 执行（拿结构化数据）自由切换
- 📜 **脚本注入执行** — 在页面环境运行任意 JS，支持 async/await 与返回值，等价于一个可编程 DevTools Console
- 🖥️ **多设备管理** — 每台电脑的浏览器可自定义设备名，Agent 按 `device` 参数精准路由，互不干扰
- 🔌 **零依赖部署** — 中转服务仅用 Node.js 标准库，无需 `npm install`，一个文件跑起来
- 🔄 **断线自愈** — 扩展自动重连、同名设备自动接管、请求级超时与错误分类
- 🎯 **前台默认** — 新标签页默认在前台打开，远程操作全程可见可干预

## 🏗️ 架构

```
┌─────────────┐   HTTP API     ┌──────────────┐   WebSocket    ┌─────────────────┐
│ Hermes 等    │ ────────────→ │  Relay 服务   │ ────────────→ │ Chrome / Edge    │
│ AI Agent    │  :8766        │  relay.js    │  :8765        │ 扩展 (CDP 接管)   │
└─────────────┘               └──────────────┘               └─────────────────┘
```

- **Agent 面向 HTTP API 编程**，与浏览器完全解耦，跨语言可用（Python / curl / 任意 HTTP 客户端）
- **扩展通过 `chrome.debugger`（CDP）执行指令**，具备与 Puppeteer 同级的控制能力
- 两者通过 WebSocket 长连接通信，请求带 `reqId` 做异步关联，超时与断线有明确错误语义

## 📦 快速开始

### 1. 安装扩展

打开 `chrome://extensions`（Edge 为 `edge://extensions`）→ 右上角开启「开发者模式」→
「加载解压缩的扩展」→ 选择本项目的 `extension/` 目录。

> 扩展使用 `debugger` 权限，接管页面时浏览器顶部会出现
> 「已开始调试此浏览器」的提示条，这是 CDP 的正常行为，可点击 ✕ 隐藏。

### 2. 启动中转服务

需要 Node.js 16+：

```bash
node server/relay.js
```

```
[WS]   listening for extensions on ws://127.0.0.1:8765
[HTTP] API for Hermes on http://127.0.0.1:8766
```

扩展会自动连接。工具栏图标徽章显示绿色 **ON** 即为就绪。

### 3. 发出第一条指令

```bash
# 确认在线
curl http://127.0.0.1:8766/status

# 在前台打开一个页面
curl -X POST http://127.0.0.1:8766/tab/new \
     -H "Content-Type: application/json" \
     -d '{"url":"https://github.com"}'
```

## 📖 API 手册

基址 `http://127.0.0.1:8766`。所有 POST 请求体为 JSON；除特殊说明 `tabId` 可省略
（默认当前活动标签页）。多设备时任意请求可加 `"device": "<设备名>"`。

### 会话与设备

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 扩展连接状态与设备列表 |
| GET | `/devices` | 在线设备列表（名称 / UA / 连接时间） |
| GET | `/tabs` | 列出所有标签页 |

### 页面导航

| 方法 | 路径 | Body | 说明 |
|---|---|---|---|
| POST | `/tab/new` | `{url, active?}` | 新建标签页（默认前台），返回 `tabId` |
| POST | `/navigate` | `{url, tabId?}` | 当前页跳转 |
| POST | `/tab/activate` | `{tabId}` | 激活某标签页 |
| POST | `/tab/close` | `{tabId}` | 关闭标签页 |

### 感知

| 方法 | 路径 | Body | 说明 |
|---|---|---|---|
| POST | `/screenshot` | `{tabId?}` | 截图，返回 `image`（PNG data URL） |
| POST | `/evaluate` | `{expression, tabId?}` | 执行 JS，返回值；支持 Promise（自动 await） |
| POST | `/find` | `{selector, tabId?}` | 返回元素中心坐标 / 包围盒 / 文本 |
| POST | `/wait` | `{ms}` | 等待指定毫秒 |

### 操作

| 方法 | 路径 | Body | 说明 |
|---|---|---|---|
| POST | `/click` | `{x, y, double?, tabId?}` | 真实鼠标点击 |
| POST | `/move` | `{x, y, tabId?}` | 鼠标移动 |
| POST | `/type` | `{text, tabId?}` | 逐字符真实键入 |
| POST | `/key` | `{key, tabId?}` | Enter / Tab / ArrowDown / Escape … |
| POST | `/scroll` | `{dy, dx?, x?, y?, tabId?}` | 滚动 |
| POST | `/command` | `{command, params, tabId?}` | 透传任意 CDP 命令（完整控制力） |

### 调用示例

```bash
# 打开 B 站搜索"弹珠传说"并截图
curl -X POST http://127.0.0.1:8766/tab/new -d '{"url":"https://www.bilibili.com"}'
curl -X POST http://127.0.0.1:8766/navigate -d '{"tabId":123,"url":"https://search.bilibili.com/all?keyword=弹珠传说"}'
curl -X POST http://127.0.0.1:8766/screenshot -d '{"tabId":123}' | jq -r '.image' | cut -d, -f2 | base64 -d > shot.png

# 多设备：指定"书房台式机"打开页面
curl -X POST http://127.0.0.1:8766/tab/new -d '{"device":"书房台式机","url":"https://example.com"}'
```

## 🤖 给 AI Agent 使用

`skills/browser-remote/SKILL.md` 是一张**即插即用的 Agent 技能卡**（兼容
Agent Skills 规范），涵盖：感知先行工作流、JS 脚本模式库、9 条实战踩坑规则、
错误处理决策树。把它放进你的 Agent 技能目录，或直接贴进 system prompt。

```text
skills/browser-remote/SKILL.md   ← Agent 学会这一篇就会用
```

## 🔒 安全模型

- 中转服务只监听 `127.0.0.1`，**不暴露局域网/公网**
- ⚠️ 本机任何程序都能调用 8766 端口控制浏览器——与 DevTools 远程端口同级别的能力，
  请勿在不受信任的机器上运行
- 如需跨机使用，请在前面加带鉴权的反向代理（HTTPS + Token）
- 扩展只在收到本地中转服务指令时激活 CDP，不常驻注入任何页面

## 🧪 冒烟测试

```bash
node server/relay.js        # 终端 1
python -I test_smoke.py     # 终端 2：自动开页→执行JS→截图→关页，全链路自检
```

## 📁 目录结构

```
hrc/
├── extension/            # Chrome/Edge 扩展 (Manifest V3)
│   ├── manifest.json
│   ├── background.js     # Service Worker：WS 客户端 + CDP 执行器
│   ├── popup.html/js     # 设备名 & 服务器地址设置
│   ├── icon.png / icon16.png
│   └── icon.svg          # 图标源文件
├── server/
│   └── relay.js          # 零依赖中转服务 (WS 8765 / HTTP 8766)
├── skills/
│   └── browser-remote/
│       └── SKILL.md      # AI Agent 技能卡
├── test_smoke.py         # 端到端冒烟测试
└── README.md
```

## 🗺️ Roadmap

- [ ] CDP `Page.captureScreenshot` 全页截图（窗口最小化时也可用）
- [ ] iframe 穿透执行（同域 frame 上下文切换）
- [ ] WebSocket 指令流式回传（长任务进度）
- [ ] 设备配对二维码 + Token 鉴权
- [ ] 网络请求拦截（`Fetch.enable`）与 Mock

---

**HRC** · 把浏览器交给 Agent，把控制权留给自己。
