# Auth setup — 配置登录

> Deployers read this; developers read
> [docs/contracts.md](contracts.md) §"Identity & login (P1-B)".
> 登录是**可选功能**：不配任何登录参数，房间照常匿名运行。

**Languages:** [English](#english) · [中文](#中文)

---

## English

Open Study Room works fully **anonymous** — no login is required. P1-B adds
*optional* lightweight login (GitHub OAuth, email magic link) to raise the
cost of abuse and bind focus streaks to accounts. Everything is driven by
environment variables; unset means *off*.

### 1. GitHub OAuth App — create it

1. Go to **github.com → Settings → Developer settings → OAuth Apps →
   New OAuth App**.
2. Fill in:
   - **Application name**: e.g. `My Open Study Room`
   - **Homepage URL**: your public server origin, e.g. `https://study.example.com`
   - **Authorization callback URL** (must match exactly):
     ```
     ${BASE_URL}/v1/auth/github/callback
     ```
     e.g. `https://study.example.com/v1/auth/github/callback`.
     > The OAuth App must be created **per deployment** — localhost and
     > production need separate apps (different callback URLs).
3. After creating, copy the **Client ID**, then **Generate a new client
   secret** and copy the **Client secret**.
4. Set in the server environment:
   ```bash
   GITHUB_CLIENT_ID=<client id>
   GITHUB_CLIENT_SECRET=<client secret>   # never in logs / git / frontend
   BASE_URL=https://study.example.com     # public origin, must equal the callback's origin
   ```
5. (Optional) For local development use `BASE_URL=http://localhost:8787`
   and a separate OAuth App whose callback is
   `http://localhost:8787/v1/auth/github/callback`. GitHub allows
   `http://localhost` callback URLs for dev apps.

Requested scopes: `read:user user:email` (identity + primary verified
email only). The client secret and the GitHub access token never leave the
server; the token exchange is server-to-server.

### 2. Email magic link — configure SMTP

The server sends the sign-in link via plain SMTP (STARTTLS on 587 by
default). Example values:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587          # default 587
SMTP_USER=bot@example.com
SMTP_PASS=<app password>   # never in logs / git / frontend
SMTP_FROM=noreply@example.com   # must be set, together with SMTP_HOST
```

> **Honest note — 诚实说明**: if `SMTP_HOST` or `SMTP_FROM` is not set,
> email login is **not available**. `POST /v1/auth/email/request` returns
> `501 { "error": "email_not_configured" }` and the web client hides the
> email entry on the join screen. This is intentional — the contract refuses
> to pretend email works when it cannot send mail (see contracts.md §4).

### 3. All auth environment variables

| Variable | Required? | Default | Effect |
|---|---|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | — | Both set ⇒ GitHub login on; either missing ⇒ off: `GET /v1/auth/github` → `503 { error: "github_not_configured" }`, and `GET /v1/auth/config` reports `{"github": false}` (web hides the button). |
| `BASE_URL` | yes when any login is on | — | Public server origin, e.g. `https://study.example.com`. Builds `redirect_uri` and magic-link URLs. If login is off it can stay empty. |
| `WEB_BASE_URL` | no | `http://localhost:8080` | Where auth callbacks 302 the browser (login token travels in the `#token=` fragment, which browsers never send to a server). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | no | — | `SMTP_HOST` + `SMTP_FROM` set ⇒ email login on; otherwise `501 { error: "email_not_configured" }` (web hides the entry). `SMTP_PORT` defaults to 587. |
| `ADMIN_GITHUB_USERS` | no | — | Comma-separated GitHub login names (case-insensitive). Evaluated server-side at auth time; **there is no grant endpoint**. |
| `ADMIN_EMAILS` | no | — | Comma-separated emails (lowercased before compare). |
| `LOGIN_SESSION_TTL_DAYS` | no | `30` | Lifetime of the login-session bearer token (distinct from the 1 h LiveKit JWT). |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | no | `10` / `60000` | Per-IP rate limit for `/v1/auth/*`, separate from the `/v1/sessions` limiter. |

All secrets travel **only as environment variables** — never in logs,
error bodies, git history, or the web bundle.

### 4. Minimal local development (no GitHub, no SMTP)

For local development you can leave GitHub and SMTP unset entirely:

```bash
# server/.env (copy from server/.env.example)
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=<redacted>
LIVEKIT_API_SECRET=<redacted>
PORT=8787
DB_PATH=./data/syncle.db
WEB_BASE_URL=http://localhost:8080
# GITHUB_CLIENT_ID / SMTP_HOST left empty — login is off
```

What happens when nothing is configured:

- `GET /v1/auth/config` → `200 { "github": false, "email": false }`.
- The join screen shows **no login buttons at all** (entries are hidden,
  not disabled).
- `GET /v1/auth/github` → `503 { error: "github_not_configured" }`.
- `POST /v1/auth/email/request` → `501 { error: "email_not_configured" }`.
- `POST /v1/sessions` (anonymous flow) is **unchanged** — the room works
  exactly as in M1–M4.

The anonymous flow is the supported default; login is additive.

---

## 中文

自习室**默认完全匿名运行**，登录不是必需的。P1-B 增加的轻量登录（GitHub
OAuth、邮箱 magic link）是可选功能，目的是提高作恶成本、把专注 streak
绑定到账号。所有开关都是环境变量；不设置 = 关闭。

### 1. 创建 GitHub OAuth App

1. 打开 **github.com → Settings → Developer settings → OAuth Apps →
   New OAuth App**。
2. 填写：
   - **Application name**：如 `My Open Study Room`
   - **Homepage URL**：服务器的公网地址，如 `https://study.example.com`
   - **Authorization callback URL**（必须精确匹配）：
     ```
     ${BASE_URL}/v1/auth/github/callback
     ```
     如 `https://study.example.com/v1/auth/github/callback`。
     > 每个部署环境都要单独建一个 OAuth App——本地开发和生产环境的
     > callback URL 不同，必须分开建。
3. 建好后复制 **Client ID**，再 **Generate a new client secret** 复制
   **Client secret**。
4. 写进 server 的环境变量：
   ```bash
   GITHUB_CLIENT_ID=<client id>
   GITHUB_CLIENT_SECRET=<client secret>   # 只进环境变量，不进日志/git/前端
   BASE_URL=https://study.example.com     # 公网 origin，必须和 callback 的 origin 一致
   ```
5. （可选）本地开发用 `BASE_URL=http://localhost:8787`，并建一个
   callback 为 `http://localhost:8787/v1/auth/github/callback` 的开发用
   App。GitHub 允许开发 App 用 `http://localhost` 回调。

请求 scope：`read:user user:email`（仅身份 + 主验证邮箱）。client secret
和 GitHub access token 永不离开服务器；code 换 token 是 server-to-server。

### 2. 邮箱 magic link — 配置 SMTP

服务器用普通 SMTP（默认 587 + STARTTLS）发送登录链接。示例：

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587          # 默认 587
SMTP_USER=bot@example.com
SMTP_PASS=<应用专用密码>   # 只进环境变量，不进日志/git/前端
SMTP_FROM=noreply@example.com   # 必须和 SMTP_HOST 一起设置
```

> **诚实说明**: `SMTP_HOST` 或 `SMTP_FROM` 没设置时，**邮箱登录不可用**。
> `POST /v1/auth/email/request` 返回
> `501 { "error": "email_not_configured" }`，加入页面的邮箱入口会自动隐藏。
> 这是故意的——发不出邮件就不假装能用（见 contracts.md §4）。

### 3. 全部登录相关环境变量

| 变量 | 是否必填 | 默认值 | 效果 |
|---|---|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 否 | — | 都设置 ⇒ GitHub 登录开启；缺任一个 ⇒ 关闭：`GET /v1/auth/github` → `503 { error: "github_not_configured" }`，`GET /v1/auth/config` 返回 `{"github": false}`（网页隐藏按钮）。 |
| `BASE_URL` | 任一登录开启时必填 | — | 服务器公网 origin，如 `https://study.example.com`。用于拼 `redirect_uri` 和 magic link。不开登录可留空。 |
| `WEB_BASE_URL` | 否 | `http://localhost:8080` | 登录回调 302 跳回浏览器的地址（登录 token 只放在 `#token=` fragment 里，浏览器不会把它发给服务器）。 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | 否 | — | 设置 `SMTP_HOST` + `SMTP_FROM` ⇒ 邮箱登录开启；否则 `501 { error: "email_not_configured" }`（网页隐藏入口）。`SMTP_PORT` 默认 587。 |
| `ADMIN_GITHUB_USERS` | 否 | — | 逗号分隔的 GitHub 用户名（不区分大小写）。登录时服务器端判定；**没有授权接口**。 |
| `ADMIN_EMAILS` | 否 | — | 逗号分隔的邮箱（比较前转小写）。 |
| `LOGIN_SESSION_TTL_DAYS` | 否 | `30` | 登录会话 bearer token 有效期（和 1 小时的 LiveKit JWT 是两回事）。 |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | 否 | `10` / `60000` | `/v1/auth/*` 的按 IP 限流，和 `/v1/sessions` 限流器独立。 |

所有密钥**只走环境变量**——不进日志、不进错误返回体、不进 git、不进前端
打包产物。

### 4. 本地开发最小配置（不配 GitHub / SMTP）

本地开发可以直接把 GitHub 和 SMTP 留空：

```bash
# server/.env（从 server/.env.example 复制）
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=<redacted>
LIVEKIT_API_SECRET=<redacted>
PORT=8787
DB_PATH=./data/syncle.db
WEB_BASE_URL=http://localhost:8080
# GITHUB_CLIENT_ID / SMTP_HOST 留空 —— 登录关闭
```

什么都不配时的行为：

- `GET /v1/auth/config` → `200 { "github": false, "email": false }`。
- 加入页面**完全不显示登录按钮**（入口隐藏，不是置灰）。
- `GET /v1/auth/github` → `503 { error: "github_not_configured" }`。
- `POST /v1/auth/email/request` → `501 { error: "email_not_configured" }`。
- `POST /v1/sessions` 匿名流程**零变化**——房间和 M1–M4 时代完全一样。

匿名流程是官方支持的默认形态；登录是叠加其上的可选层。

---

*Related: [docs/contracts.md](contracts.md) §"Identity & login (P1-B)" is the
normative spec; this file is the deployer's how-to. If they disagree, the
contract wins.*
