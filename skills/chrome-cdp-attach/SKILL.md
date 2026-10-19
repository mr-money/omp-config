---
name: chrome-cdp-attach
description: >
  Use when a task must drive a site the user is already signed into (admin consoles, internal
  dashboards, any logged-in app) and re-login or a fresh profile is not an option: control the
  user's already-running Chrome from omp, per Chrome profile, without the per-connection
  "allow remote debugging?" consent dialog. Primary path: the omp Browser Relay — an unpacked
  chrome.debugger extension dialing the loopback CDP relay, driven through browser.open's
  app.relay option (install, health checks, profile/instance selection, SPA readiness, DOM reads,
  clicks, screenshots, clean release). Fallback: a dependency-free raw-WebSocket CDP client on
  machines where the extension cannot be installed.
---

# 用 omp 操控用户已登录的 Chrome

> 不绑定机器 / Chrome Profile / 账户 / 站点：文中出现的路径、端口、页面子串都是示例，实际值从当前环境探测
> （omp home、relay 端口、`/json` 的可用页面清单、目标站点的加载态标志）。

## 选路（先判断，再动手）

| 情况 | 走哪条 |
|---|---|
| 常规情况：要读/操作用户已登录的页面 | **路线 A：OMP Browser Relay**（默认，0 弹窗，区分 Profile） |
| `omp config get browser.relay` = `true` 且扩展已装在目标 Profile | 路线 A，直接在 `eval` 里用 `browser` 全局 |
| 扩展没装、用户不想装，但接受"每次连接点一次允许" | 路线 B：直连 CDP over WebSocket（文末） |
| 只是抓公开静态网页 | 两条都别用，`read` 或普通 `browser.open({url})` 即可 |

---

# 路线 A：OMP Browser Relay（首选）

原理：扩展用 `chrome.debugger` 把用户真实标签页接进一个本地 relay（`omp browser-relay`），relay 对
外伪装成标准 CDP 端点。**不经过 Chrome 的远程调试端口，因此没有逐次授权弹窗**；`chrome.debugger` 只
会带来每个被调试标签页顶部一条"正在调试此浏览器"信息条。

## A1. 一次性安装（每个要驱动的 Profile 各一次）

```bash
omp browser-relay install                 # 写扩展文件到 <omp home>/browser-relay/extension（--dir 可指定）
omp config set browser.relay true         # 之后所有 omp 会话默认走 relay
omp config get browser.relay              # 校验 → true
```

然后在 **Chrome**（要驱动的那个 Profile）里人工完成三步——**这一步无法脚本化**，本地扩展只能手动加载：

1. 地址栏打开 `chrome://extensions` → 右上角打开 **开发者模式**
2. **加载已解压的扩展程序** → 选 `omp browser-relay install` 打印出的目录
   （默认 `<omp home>/browser-relay/extension`：Windows `%USERPROFILE%\.omp\browser-relay\extension`，
   macOS/Linux `~/.omp/browser-relay/extension`）
3. 工具栏 **OMP Browser Relay** 徽章显示 **on** = 已连上 relay

扩展 options 页（徽章右键 → 选项）只有两项：relay 端口（默认 `9224`）与可选 token，必须与 relay 启动参数一致。

relay 端点本身可配置：`omp config set browser.relayUrl http://127.0.0.1:<port>`（或 `omp browser-relay -p <port>` 手动起）；
`PI_BROWSER_RELAY=0` 是最终关闭开关（覆盖 `browser.relay`）。

## A2. 健康检查（先查状态，别盲试）

```bash
curl -s --max-time 5 http://127.0.0.1:9224/json/version   # 200=扩展在线；503=服务在等扩展
curl -s --max-time 5 http://127.0.0.1:9224/json           # 标签页清单（含 id/title/url/active/discarded）
```

判读：

| 响应 | 含义 | 处置 |
|---|---|---|
| `200` + `"ompExtensionDiscardedTabsProtocol":"1"` | 扩展在线且版本兼容 | 直接用 |
| `503` + `"extensionSeen":true` | 连过又断了（Chrome 回收了 MV3 service worker 或 Chrome 退出） | 等一个 30s keepalive 周期；仍不来就查 Chrome/徽章 |
| `503` + `"extensionSeen":false` | 从未连上 | 扩展没装/没加载/端口不匹配 → 回 A1 |
| `503` 且 `ompRelayVersion` 与当前 omp 版本不符 | relay 版本不一致 | 退出所有 omp 会话让 broker 回收后重开；工具侧会报 `out of date` |
| 连接被拒（curl exit 7） | relay 没在跑 | 无需手动起：下一次浏览器调用会自动拉起；也可 `omp browser-relay` 手动起 |
| `No page target matched …`（工具报错） | 子串没命中 | 报错里会列出所有可用页面，照抄一个子串 |
| `… was discarded by Chrome` | 标签页被 Chrome 休眠 | 让用户点一下该标签页让它重载，再重试 |

relay 生命周期：由 omp 的 **machine-global broker** 按需拉起（`persist:false`）。所有 omp 会话退出后
broker 空闲回收、监听端口消失，下次用到浏览器时自动重启；扩展按 30s 心跳自动重拨，工具侧的等待窗口是
35s——**不需要人工干预**。

## A3. 配方（`eval` js）

工具面：`open` / `evaluate` / `observe` / `screenshot` / `tabs` / `close` 是最常用的一组；`click` / `fill` /
`waitFor*` 同属浏览器工具 API。**任何交互前必须先拿到用户确认。**

### 打开用户已经开着的页面（不要 navigate）

```javascript
// app.target = URL/标题的稳定子串（如后台路由名、页面标题关键词）；命中第一个未被 Chrome 休眠的页面
const tab = await browser.open({ name: "site-admin", app: { relay: true, target: "<url-or-title-substring>" }, timeout: 25 });
// 不带 target → 采用"当前可见标签页"；⚠️ 此时若再传 url 会把用户正在看的页面导航走，除非用户明确要求
```

子串怎么选：先 `curl -s http://127.0.0.1:9224/json` 列出现有页面；或故意用一个不会命中的 `target` 触发工具
报错，报错里会列出全部可用页面，照抄其中一个片段。取稳定、且不同 Profile 之间不冲突的子串。

### 读页面（只读默认）

```javascript
const info = await tab.evaluate(
  `(() => ({ title: document.title, url: location.href,
             rows: document.querySelectorAll("tr").length,
             head: document.body.innerText.replace(/\\s+/g," ").slice(0,220) }))()`
);
```

`tab.evaluate(string)` 在**页面世界**执行；`tab.run(fn)` 在**独立 JS 运行时**执行（那里没有 `document`，
要读 DOM 就在里面 `await tab.evaluate(...)`）。

### 结构化观察 + 交互（要动页面时先跟用户确认）

```javascript
const obs = await tab.observe({ compact: true });   // {url,title,viewport,scroll,elements:[{id,role,name,states}]}
await tab.id(obs.elements[3].id).click();           // 数字 id 与 observe 同一次调用内有效
await tab.fill("aria/名称", "示例值");              // 选择器支持 css / aria/ / text/ / role/ / placeholder/ 等
await tab.waitForText("保存成功", { timeout: 15000 });
```

### 截图（返回落盘路径，不会把 base64 灌进上下文）

```javascript
const p = await tab.screenshot({ format: "png", silent: true });   // → 本机绝对路径（omp 临时目录下 omp-sshots-xxxx.png）
```

### 等 SPA 真正渲染完（关键）

`document.readyState === "complete"` 之后列表通常还在 XHR 里，必须轮询**该站点自己的**业务标志：

```javascript
// "tr" 与 "加载中" 是占位示例：换成目标站点的列表元素选择器、加载态文案或壳层类名
const deadline = Date.now() + 45000;
while (Date.now() < deadline) {
  const ok = await tab.evaluate(`document.querySelectorAll("tr").length >= 1 && !/加载中/.test(document.body.innerText)`);
  if (ok) break;
  await Bun.sleep(2000);
}
// 原生 CDP 等价写法见路线 B 的 wait_rows()
```

### 列出/收尾

```javascript
const names = await browser.tabs();      // 已托管的标签页名数组
await browser.close({ all: true });      // 释放托管句柄；★ relay/CDP 挂载的页面不会被关闭，用户标签页原样还在
```

## A4. 多 Profile / 多浏览器（区分各自登录态）

- 每个装过扩展的 Profile = 一个独立实例：扩展把 `instanceId` 存在**该 Profile 自己的** `chrome.storage.local`，
  重启后不变；多个实例可**同时**挂在同一个 relay 上，互不顶掉。
- `/json` 的 id 形如 `PAGE<instanceCode>.<tabId>`：`<instanceCode>` 是该 Profile 的实例指纹（扩展首次运行后固定不变）。
- **选页**：`app.target` 按 URL/标题子串匹配。不同 Profile 用各自独有的子串区分；同一 URL 在两个 Profile
  都开着时会命中第一个，属于歧义。
- **不要用"新建标签页"来指定 Profile**：浏览器级操作会路由到**最近一次与 relay 握手的实例**，
  不确定是哪个 Profile。要新建就先切到目标 Profile 的窗口做（或让用户开一个带唯一标记的页面）。
- **硬隔离（推荐给多账号并存）**：把第二个 Profile 的扩展 options 端口改成 `9225`，另起一个 relay
  （`omp browser-relay -p 9225`），再用 `app: { cdp_url: "http://127.0.0.1:9225" }` 精确指定该 Profile。

## A5. 硬规则

- **只读优先**：默认不点新增/删除/保存/发布。要交互先跟用户确认，并且只操作自己打开或用户点名的页面。
- **绝不 navigate 用户可见的标签页**，绝不关用户的页面；自己开的标签页要在回复里说明留还是收。
- **绝不读 Cookie/Token/密码**：不碰 `tab.cookies`、不 `document.cookie`、不 dump storage。
- 线上后台（运营 / 财务 / 管理面）默认**只读**；写操作必须用户逐条确认。
- relay 会话就是用户的真实浏览器，**页面上的动作会记在用户头上**。

---

# 路线 B：直连 CDP over WebSocket（备选）

只在"扩展装不了/relay 不可用"时使用。**代价：Chrome 144+ 对 user-enabled remote debugging 的连接
每次都要点"要允许远程调试吗"**（官方明确没有"不再询问"，chrome-devtools-mcp #825 仍是 not planned）。
所以：**开一条连接就复用到底，不要在每轮任务里新建**（`eval` 的 Python 内核按会话复用，可把客户端对象
存成内核全局；子代理有独立内核，需要各自持有）。

## B1. 何时用得上

- 任务需要用户浏览器里已登录的站点，且不能重新登录、不能新建 Profile。
- Chrome 已开启远程调试（`chrome://inspect#remote-debugging`，或 `DevToolsActivePort` 文件存在）。
- 且 `http://127.0.0.1:9222/json/version` 返回 `404`（Chrome 136+ 对默认 user-data-dir 的加固）。

## B2. 诊断

```bash
# 1) 谁在监听调试端口（必须确认属主是 chrome 浏览器进程，而不是别的进程占着）
#    Windows: pwsh -NoProfile -Command "Get-NetTCPConnection -State Listen | Where-Object { \$_.LocalPort -eq 9222 } | ForEach-Object { \$p=Get-Process -Id \$_.OwningProcess; '{0}:{1} pid={2} {3}' -f \$_.LocalAddress,\$_.LocalPort,\$_.OwningProcess,\$p.ProcessName }"
#    macOS:   lsof -nP -iTCP:9222 -sTCP:LISTEN
#    Linux:   ss -ltnp 'sport = :9222'

# 2) DevToolsActivePort：存在即说明 DevTools 服务已起
#    Windows: %LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort
#    macOS:   ~/Library/Application Support/Google/Chrome/DevToolsActivePort
#    Linux:   ~/.config/google-chrome/DevToolsActivePort
cat "<上表按平台取到的路径>"   # 例：cat "$LOCALAPPDATA/Google/Chrome/User Data/DevToolsActivePort"

# 3) HTTP 发现端点
curl -s -i -m 5 --noproxy "*" http://127.0.0.1:9222/json/version
```

`DevToolsActivePort` 内容形如（第 2 行的 uuid **每次 Chrome 重启都会变**）：

```
9222
/devtools/browser/1d18a417-8933-4460-a63c-0fefc9de670f
```

| 现象 | 含义 | 结论 |
|---|---|---|
| `/json/version` 返回 JSON | 标准端点可用 | 直接用 `http://127.0.0.1:9222`，任何标准 CDP 客户端都行 |
| 端口 LISTENING + 所有路径 `404` + `Content-Length: 0` | 默认 user-data-dir 加固 | 走 WebSocket（本节） |
| 端口没人监听 | 没开调试 | 让用户自己在 `chrome://inspect#remote-debugging` 打开，不要替用户启动 |

## B3. 客户端：零依赖 Python CDP（原始 WebSocket）

只用标准库，不需要 `pip install`。粘到 `eval`（py）或存成 `cdp_attach.py`。

```python
import socket, base64, os, sys, json, itertools, struct, time

class CDP:
    """极简 CDP 客户端：直连 ws://host:port/devtools/browser/<uuid>，不发 Origin 头。"""

    def __init__(self, host, port, path, timeout=60):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            c = self.sock.recv(4096)
            if not c:
                raise RuntimeError("handshake closed")
            buf += c
        head, _, tail = buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise RuntimeError("handshake failed: " + head.decode(errors="replace")[:300])
        self.raw = bytearray(tail)
        self.ids = itertools.count(1)
        self.events = []

    def _send_frame(self, opcode, payload):
        n = len(payload)
        hdr = bytearray([0x80 | opcode])
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
        mask = os.urandom(4)
        hdr += mask
        self.sock.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _read_exact(self, n):
        while len(self.raw) < n:
            c = self.sock.recv(65536)
            if not c:
                raise RuntimeError("connection closed")
            self.raw += c
        out = bytes(self.raw[:n]); del self.raw[:n]
        return out

    def _read_frame(self):
        b0, b1 = self._read_exact(2)
        fin, opcode, ln = b0 & 0x80, b0 & 0x0F, b1 & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", self._read_exact(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", self._read_exact(8))[0]
        return fin, opcode, (self._read_exact(ln) if ln else b"")

    def send(self, method, params=None, session_id=None, timeout=60):
        mid = next(self.ids)
        msg = {"id": mid, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        self._send_frame(0x1, json.dumps(msg).encode())
        deadline = time.time() + timeout
        parts = []
        while True:
            if time.time() > deadline:
                raise TimeoutError(f"timeout waiting {method} (id={mid})")
            fin, opcode, payload = self._read_frame()
            if opcode == 0x9:            # ping -> pong
                self._send_frame(0xA, payload); continue
            if opcode == 0x8:
                raise RuntimeError("ws closed by peer")
            if opcode in (0x1, 0x2, 0x0):  # text / binary / continuation
                parts.append(payload)
                if not fin:
                    continue
                data = b"".join(parts); parts = []
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                if obj.get("id") == mid:
                    if "error" in obj:
                        raise RuntimeError(f"{method}: {obj['error']}")
                    return obj.get("result", {})
                if "method" in obj:
                    self.events.append(obj)

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass

def default_devtools_active_port_file():
    """各平台 Chrome 默认 user-data-dir 下的 DevToolsActivePort。"""
    home = os.path.expanduser("~")
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        return os.path.join(base, "Google", "Chrome", "User Data", "DevToolsActivePort")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort")
    return os.path.join(home, ".config", "google-chrome", "DevToolsActivePort")

def attach(devtools_active_port_file):
    """读取 DevToolsActivePort，返回已握手的 CDP 客户端。"""
    lines = open(devtools_active_port_file, encoding="ascii").read().splitlines()
    port, path = int(lines[0].strip()), lines[1].strip()
    return CDP("127.0.0.1", port, path)

if __name__ == "__main__":
    cdp = attach(sys.argv[1] if len(sys.argv) > 1 else default_devtools_active_port_file())
    print(cdp.send("Browser.getVersion")["product"])
    for t in cdp.send("Target.getTargets")["targetInfos"]:
        if t["type"] == "page":
            print(t.get("title", "")[:60], "|", t.get("url", "")[:100])
    cdp.close()
```

## B4. 配方

### 复用已有标签页 vs 开新标签页

```python
t = cdp.send("Target.getTargets")
pages = [x for x in t["targetInfos"] if x["type"] == "page"]

def attach_to(cdp, target_id):
    return cdp.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})["sessionId"]

# 优先匹配已打开的页面，避免打断用户；只在必要时新建（子串从 /json 或工具报错里取）
hit = next((x for x in pages if "<url-substring>" in x["url"]), None)
tid = hit["targetId"] if hit else cdp.send("Target.createTarget", {"url": url})["targetId"]
sid = attach_to(cdp, tid)
cdp.send("Page.enable", session_id=sid)
```

`flatten: True` 让事件与回复带上 `sessionId`，一个 WebSocket 就能管多个标签页。

### 等 SPA 真正渲染完

```python
def wait_rows(cdp, sid, want=1, timeout=45):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = cdp.send("Runtime.evaluate", {
            "expression": "({rows: document.querySelectorAll('table tbody tr, .el-table__row, [class*=tableBody] [class*=row], [class*=TableBody] [class*=Row]').length,"
                          " loading: /加载中|页面加载中/.test(document.body.innerText)})",
            "returnByValue": True}, session_id=sid)["result"]["value"]
        if st["rows"] >= want and not st["loading"]:
            return st
        time.sleep(2)
    return st
```

### 读 DOM / 截图

```python
def ev(cdp, sid, expr):
    return cdp.send("Runtime.evaluate", {"expression": expr, "returnByValue": True},
                    session_id=sid)["result"]["value"]

info = ev(cdp, sid, """(function(){
  const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const txt = document.body.innerText;
  return { ready: document.readyState, title: document.title, href: location.href,
           textHead: txt.replace(/\\s+/g, ' ').slice(0, 260),
           buttons: [...new Set([...document.querySelectorAll('button, a[role=button], .btn, [class*=btn]')]
                     .filter(vis).map(e => (e.innerText || '').trim()).filter(t => t && t.length < 12))].slice(0, 25),
           hasLoginWord: /登录|立即登录|请登录|扫码登录/.test(txt),
           hasVerify: /验证码|安全验证|滑动验证|人机/.test(txt),
           loginForm: !!document.querySelector('input[type=password], [class*=loginForm]') };
})()""")

shot = cdp.send("Page.captureScreenshot", {"format": "png"}, session_id=sid)["data"]
open("page.png", "wb").write(base64.b64decode(shot))   # 记得 import base64
```

### 收尾

```python
for sid in all_sessions:
    try: cdp.send("Target.detachFromTarget", {"sessionId": sid}, timeout=5)
    except Exception: pass
cdp.close()   # 关 socket 会自动清理该连接残留的会话
```

## B5. 坑（别再试一遍）

1. **HTTP 404 不等于连不上。** Chrome 136 起，用默认 user-data-dir 时 `--remote-debugging-port` 被忽略：
   端口照常监听，但 `/json/version`、`/json/list`、`/` 全 `404`。换 Host（`localhost`/`127.0.0.1`/`[::1]`）
   都一样。**WebSocket 端点仍可用**：`ws://127.0.0.1:9222/devtools/browser/<uuid>` 握手 `101`。
2. **不要发送 `Origin` 头。** 带 `Origin:` 会被拒 `403 ... --remote-allow-origins=`。手写 socket 握手天生不带，正好可用。
3. **`browser.open({app:{cdp_url}})` 在这里没用**：它要求 HTTP 发现端点，传 `ws://` 直接报错，传
   `http://127.0.0.1:9222` 则 404 超时。要驱动用户 Chrome 请走路线 A。
4. **Bun/Node 的 `WebSocket` 容易静默挂住**：握手被拒时 `onerror` 可能不触发，只表现为超时假象。诊断一律用 Python 原始 socket。
5. **握手偶发无响应**：可能遇到 `TimeoutError`（服务端既不应答也不关闭）。包一层"最多重试 2 次、每次 15s"，
   不要因为一次超时判定端口不可用。
6. **截图证据**：base64 落盘后要真正打开确认不是空白（后台标签页可能不渲染）。同一页面只截一张。
7. **多实例**：同机可能有多个 Chrome 通道（Stable/Beta/Canary），`DevToolsActivePort` 只覆盖默认数据目录；
   多实例时按端口属主与命令行区分。

---

## 兼容性与假设

- 扩展与 relay 的协议版本在每次连接时自动校验（`/json/version` 自带 `ompExtensionDiscardedTabsProtocol` /
  `ompRelayVersion`）：不匹配时工具直接报 `out of date`，按 A2 表格处置即可，**不需要手工比对版本号**。
- 路线 A 依赖 `chrome.debugger`（MV3 扩展，权限 `debugger` / `tabs` / `tabGroups` / `storage` / `alarms`）；
  被调试标签页顶部会出现一条"正在调试此浏览器"信息条，属预期现象。
- 路线 B 的"每次连接都要点允许"来自 Chrome 144+ 对 user-enabled remote debugging 的收紧；这与 Chrome 136+
  起默认 user-data-dir 的 HTTP 发现端点 `404`（B5-1）是两件独立的事，不要混为一谈。
