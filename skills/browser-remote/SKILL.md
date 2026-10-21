---
name: browser-remote
description: >
  通过 Hermes Remote Control 插件远程接管 Chrome/Edge 浏览器：打开页面、截图理解、
  点击/键入/滚动、注入并执行 JS 脚本、抓取数据、多设备路由。当用户要求"打开某网站"、
  "帮我在浏览器里操作/搜索/填表"、"抓取网页内容"、"截图看看页面"、"控制我的浏览器"、
  或任何需要真实浏览器环境的任务时使用此技能。
version: 1.0.0
---

# Browser Remote — 浏览器远程接管技能

## 前置检查

所有操作通过本地 HTTP API 完成，基址固定：

```
http://127.0.0.1:8766
```

**开始任何任务前，先确认浏览器在线：**

```
GET /status
```

- 返回 `extensionConnected: true` → 继续
- 返回 `false` → 告诉用户：需要启动中转服务（`node <项目>/server/relay.js`）
  并确认浏览器扩展已启用（工具栏图标显示绿色 ON 徽章），不要盲目重试

多设备时用 `GET /devices` 查看在线设备列表；任何 POST 请求 body 中加
`"device": "<设备名>"` 可指定目标设备；不指定时默认操作最近连接的设备。

## 核心 API 速查

所有 POST 请求：`Content-Type: application/json`，body 为 JSON。
除特殊说明，`tabId` 均可省略 = 使用当前活动标签页。

| 意图 | 调用 |
|---|---|
| 看有哪些设备 | `GET /devices` |
| 列出标签页 | `GET /tabs` 或 `POST /tabs` `{"device":"..."}` |
| 打开新页面（前台） | `POST /tab/new` `{"url":"https://..."}` → 记住返回的 `tabId` |
| 本页跳转 | `POST /navigate` `{"url":"..."}` |
| 关闭标签页 | `POST /tab/close` `{"tabId":N}` |
| 切换到某标签页 | `POST /tab/activate` `{"tabId":N}` |
| **截图（看页面）** | `POST /screenshot` `{}` → 返回 `image` 字段（data URL） |
| **执行 JS 脚本** | `POST /evaluate` `{"expression":"..."} → result` |
| 定位元素坐标 | `POST /find` `{"selector":"#id"}` → `x,y,rect,tag,text` |
| 点击坐标 | `POST /click` `{"x":N,"y":N}` |
| 键入文本 | `POST /type` `{"text":"..."}` |
| 按键 | `POST /key` `{"key":"Enter"}` |
| 滚动 | `POST /scroll` `{"dy":600}`（正值向下） |
| 等待 | `POST /wait` `{"ms":2000}` |
| 任意 CDP 命令 | `POST /command` `{"command":"...","params":{...}}` |

## 标准工作流（严格执行）

```
1. GET  /status                      ← 确认在线
2. POST /tab/new  {"url": "..."}     ← 打开页面，拿到 tabId
3. POST /wait     {"ms": 2000}       ← 等渲染（或用脚本等元素）
4. POST /evaluate {"expression":"JSON.stringify({title:document.title, ...})"}
                                     ← 用 JS 感知页面状态
5. 操作（click / type / evaluate 注入脚本）
6. POST /evaluate 或 /screenshot     ← 验证结果，失败则回到 4
7. 完成后 POST /tab/close（除非用户需要保留页面）
```

**感知优先原则**：连续操作之间必须插入感知步骤（evaluate / screenshot / find）。
绝不连续盲发 3 个以上操作指令。

## JS 脚本模式库（/evaluate 的 expression）

**读页面状态（第一步永远是这个）：**
```js
JSON.stringify({title: document.title, url: location.href.slice(0,100)})
```

**抓取列表数据：**
```js
JSON.stringify([...document.querySelectorAll('a')].slice(0,10).map(a=>({t:a.innerText.trim().slice(0,50), href:a.href})))
```

**等待元素出现（异步，插件已支持 awaitPromise）：**
```js
new Promise(res=>{let n=0; const t=setInterval(()=>{ document.querySelector('选择器') ? (clearInterval(t),res('found')) : (++n>50&&(clearInterval(t),res('timeout'))) },200)})
```

**填表单（比模拟键入更可靠）：**
```js
(function(){var el=document.querySelector('选择器'); el.value='文本'; el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'})()
```

**滚动到元素：**
```js
(function(){var el=document.querySelector('选择器'); el.scrollIntoView({block:'center'}); return 'ok'})()
```

## 关键规则（踩坑总结）

1. **动态渲染页面**：`/find` 返回坐标 0×0 或 `w:0,h:0` = 元素存在但不可见
   （未渲染完/被收起）。对策：`/wait` 后重试，或改用 `/evaluate` 直接操作 DOM。
2. **点击无效**：元素中心可能被 fixed 弹窗/导航栏遮挡。先截图看，或用
   `elementFromPoint(x,y)` 检查实际命中的元素。
3. **浏览器内部页面**：`chrome://`、`edge://`、`about:` 页面无法操作，
   错误信息为 `Cannot access chrome:// URLs`。先 `/tab/new` 打开普通页面。
4. **截图超时** (`Extension response timeout`)：浏览器窗口最小化会导致
   `captureVisibleTab` 失败。请用户不要最小化浏览器窗口。
5. **导航后脚本环境重置**：页面跳转后，之前 `window` 上暂存的变量全部丢失，
   且需重新等待元素。tabId 不变。
6. **中文/特殊字符**：写入 JSON body 时无需转义 unicode，API 原生支持 UTF-8。
   但 shell 命令行内嵌 JSON 时注意引号层级，复杂 payload 建议写临时文件。
7. **iframe 内元素**：`/find` 和 `/evaluate` 都够不到跨域 iframe。
   同域 iframe 需先切换执行环境（CDP `Page.getFrameTree` + 指定 executionContext）。
8. **懒加载列表**：抓不全时先循环 `POST /scroll {"dy":800}` +
   `/wait`，再抓取。
9. **优先级**：读数据 → `/evaluate`；模拟真人 → `/click`+`/type`；
   前者失败换后者，反之亦然。

## 错误处理决策树

```
请求失败？
├─ "No browser extension connected" / extensionConnected:false
│    → 停止，请用户启动 relay 服务 + 检查扩展
├─ "Extension response timeout"
│    → GET /status 确认在线 → 页面可能卡死或窗口最小化 → 换 /evaluate 诊断
├─ "Cannot access chrome:// URLs"
│    → /tab/new 打开普通页面再操作
├─ "element not found" (404)
│    → /evaluate 列出 DOM：[...document.querySelectorAll('*')].slice(0,50).map(e=>e.tagName+'.'+e.className)
│    → 可能是选择器错误 / 未渲染完 / 在 iframe 里
└─ 返回坐标 w:0 h:0
     → 元素隐藏：/wait 后重试，或改用 evaluate 直接改 DOM
```

## 完整示例：搜索并打开第一个结果

```python
import json, time, urllib.request

BASE = "http://127.0.0.1:8766"

def call(path, data=None):
    req = urllib.request.Request(
        BASE + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

# 1. 检查在线
assert call("/status")["extensionConnected"], "扩展未连接"

# 2. 打开搜索页（直接用 URL 参数搜索比模拟键入更稳）
tab = call("/tab/new", {"url": "https://www.bilibili.com"})["tabId"]

# 3. 等待 + 等搜索框
time.sleep(2)
call("/evaluate", {"expression":
    "new Promise(r=>{let n=0;const t=setInterval(()=>{document.querySelector('.nav-search-input')?(clearInterval(t),r('ok')):(++n>40&&r('timeout'))},200)})"})

# 4. 跳转到搜索结果
call("/navigate", {"tabId": tab, "url": "https://search.bilibili.com/all?keyword=弹珠传说"})
time.sleep(3)

# 5. 抓取结果验证
r = call("/evaluate", {"expression":
    'JSON.stringify([...document.querySelectorAll(".bili-video-card")].slice(0,5).map(c=>c.querySelector("h3")?.innerText))'})
print("搜索结果:", r["result"])

# 6. 截图给用户看
shot = call("/screenshot", {"tabId": tab})
# shot["image"] 是 data:image/png;base64,... 可保存为 png
```

## 服务器与安装速查（用户问起时）

- 启动中转服务：`node <项目目录>/server/relay.js`（零依赖，需 Node 16+）
  - WS `ws://127.0.0.1:8765` ← 扩展连接；HTTP `http://127.0.0.1:8766` ← 本技能调用
- 安装扩展：`chrome://extensions` / `edge://extensions` → 开发者模式 →
  加载解压缩的扩展 → 选 `extension/` 目录
- 扩展弹窗可设置：服务器地址、设备名（多台电脑时用）
- 安全：API 只监听 127.0.0.1，本机任何程序都能调用，勿在不受信机器上运行
- 完整文档：项目 `README.md`
