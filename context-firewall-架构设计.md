# Context Firewall — 架构设计文档

> MCP 上下文防火墙:面向所有 MCP 客户端的工具输出压缩 + 渐进式工具披露代理
>
> 版本:v0.1(设计稿) | 作者:Eric | 日期:2026-07

---

## 1. 项目定位

### 1.1 一句话描述

Context Firewall 是一个本地 MCP 代理,坐在 AI agent(Claude Code / Claude Desktop / Cursor / Cline 等)和 N 个下游 MCP server 之间,把 50+ 个原始工具收敛为 3 个元工具,压缩冗长的工具输出(原始 HTML、base64、巨型 JSON),并生成可分享的 token 节省报告。

### 1.2 解决什么问题

MCP 工具泛滥是 2026 年被反复记录的头号痛点:

- 7 个 MCP server 的工具定义就能吃掉 67,300 token,占 200K 上下文窗口的 33.7%(claude-code issue #11364,2025-11)
- GitHub 官方 MCP server 单独暴露 94 个工具,约 17,600 token
- 工具超过 50 个后,agent 的工具选择准确率显著下降

### 1.3 关键定位:与官方功能互补,不竞争

**必须清楚的边界:** Anthropic 的 Tool Search Tool(`defer_loading: true`)已于 2026-01-14 成为 Claude Code 默认行为,它解决的是工具**定义**膨胀(启动时加载的名称/描述/schema)。

**它没有解决、而我们拥有的空白:**

| 维度 | Tool Search(官方) | Context Firewall(本项目) |
|---|---|---|
| 工具定义懒加载 | ✅ 已解决 | ✅ 通过 3 元工具实现 |
| 工具**输出**压缩 | ❌ 未覆盖 | ✅ **核心卖点** |
| 跨客户端 | 仅 Claude 系产品 | ✅ 任意 MCP 客户端、任意模型 |
| 跨 server 聚合 | ❌ | ✅ N 个 server 一个入口 |
| 可分享的节省报告 | ❌ | ✅ 截图级传播产物 |

所有文案统一口径:"complements Tool Search"(补全 Tool Search 没做的那一半)。

### 1.4 竞品基准(2026-07 star 数)

| 项目 | star | 主打 | 与我们的差异 |
|---|---|---|---|
| MetaMCP | ~2.5K | 聚合 + 治理(auth/RBAC) | 不做输出压缩 |
| MCPJungle | ~1.1K | 网关/注册 | 企业向,重 |
| TBXark/mcp-proxy | ~695 | 传输桥接 | 无压缩、无报告 |
| microsoft/mcp-gateway | ~634 | 企业网关 | 同上 |
| Atlassian mcp-compressor | ~79 | **定义**压缩(70–97%) | 不碰输出 |
| mcp_trunc_proxy | ~5 | 输出截断(~98%) | 无元工具、无报告、无打磨 |

**结论:聚合和定义压缩已经拥挤;"输出压缩 + 渐进披露 + 可分享报告"三合一、面向个人 Claude Code 用户的定位无人占据。**

---

## 2. 总体架构

### 2.1 架构图

```
┌──────────────────┐
│   MCP 客户端      │  Claude Code / Claude Desktop / Cursor / Cline
│  (任意模型)       │
└────────┬─────────┘
         │ stdio(主要)
         ▼
┌─────────────────────────────────────────────┐
│           Context Firewall(本项目)          │
│                                             │
│  ┌───────────┐  ┌────────────┐  ┌────────┐  │
│  │ 元工具层   │  │ 压缩引擎    │  │ 计量器  │  │
│  │ 3 个工具   │  │ 输出瘦身    │  │ token  │  │
│  └───────────┘  └────────────┘  └────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │ 下游连接池(MCP client 角色)           │  │
│  └──┬──────────┬──────────┬──────────────┘  │
└─────┼──────────┼──────────┼─────────────────┘
      │ stdio    │ stdio    │ Streamable HTTP
      ▼          ▼          ▼
 ┌────────┐ ┌────────┐ ┌────────┐
 │filesystem│ │ github │ │ fetch  │  … N 个下游 MCP server
 └────────┘ └────────┘ └────────┘
```

### 2.2 双重身份

Context Firewall 同时是:

- **对上游(客户端):一个 MCP server**,通过 stdio 暴露 3 个元工具
- **对下游(N 个 server):一个 MCP client**,按配置拉起/连接下游 server

### 2.3 传输层策略

- **客户端侧:stdio 优先**——这是 Claude Desktop / Claude Code 本地配置的标准方式,`npx` 一行命令即可接入
- **下游侧:stdio + Streamable HTTP 双支持**——本地 server 走 stdio,远程 server 走 Streamable HTTP 桥接

---

## 3. 核心模块设计

### 3.1 元工具层(渐进式披露)

只向客户端暴露 3 个工具:

**① `list_tool_categories()`**
- 返回下游 server 和能力分组的紧凑索引
- 目标体积:总计 100–300 token
- 输出示例:
```json
{
  "servers": [
    { "name": "github", "categories": ["repo", "issues", "pr"], "tools": 94 },
    { "name": "filesystem", "categories": ["read", "write", "search"], "tools": 11 }
  ]
}
```

**② `search_tools(query)`**
- 语义/关键词搜索,按需返回匹配工具的完整 schema
- 只在这一刻才付出 schema 的 token 成本
- MVP 用关键词匹配(name + description),v1.0 可加本地 embedding

**③ `invoke_tool(server, tool, args)`**
- 代理实际调用,返回前先过压缩引擎
- 参数校验:转发前对照下游 schema 做基本校验,减少无效往返

### 3.2 压缩引擎(护城河所在)

针对工具**输出**的可配置压缩流水线,按顺序:

1. **base64 剥离** → 检测 base64 大块(图片/文件),替换为引用 ID + 元信息(类型、大小)
2. **HTML → Markdown** → 原始 HTML 转 Markdown,通常可砍 60–90%
3. **JSON 结构感知摘要** → 保留 key 和结构形状,折叠重复数组行(如 500 行结果保留前 N 行 + "…另有 492 行,可用 get_slice 取回"),支持分页
4. **字符/token 上限截断** → 兜底,默认上限可配置(参考:mcp_trunc_proxy 默认截断,MCPProxy 默认 20,000 字符)

**产物存储模式(artifact store):**
- 完整原始输出存入本地临时存储(内存 + 可选磁盘)
- 返回紧凑预览 + 取回句柄
- 配套隐藏工具 `read_more(handle, offset, length)` / `get_slice(handle, query)`,agent 需要细节时再拉

**安全红线(写进文档也写进代码注释):**
- 每条压缩规则均可按 server / 按 tool 配置或关闭
- **绝不静默丢弃安全相关输出**(错误信息、权限提示、警告),这类内容白名单直通

### 3.3 Token 计量器与节省报告

**计量方式:**
- 用 Anthropic 官方 `messages.count_tokens` API(免费)做前后对比
- **禁止用 tiktoken**——它对 Claude token 少算 15–20%(代码/非英文更严重)
- 注意新版 Claude tokenizer(Opus 4.7+)对同样文本产出多约 30% 的 token,计数必须对准目标模型

**节省报告(可分享产物 = 自然传播引擎):**

```
┌─────────────────────────────────────┐
│  🔥 Context Firewall Session Report │
│                                     │
│  工具暴露:52 → 3                    │
│  启动定义节省:41,200 tokens         │
│  单次调用平均输出节省:3,850 tokens   │
│  本 session 累计节省:61,000 tokens  │
│                                     │
│  ≈ 省下 30.5% 的 200K 上下文窗口     │
└─────────────────────────────────────┘
```

- 输出格式:终端渲染 + Markdown + PNG(截图友好)
- 这张卡片就是发布时 X / Reddit 上让用户主动晒图的钩子(复刻 ccusage 的 #ccusage 回路)

### 3.4 配置格式

单个 JSON 文件,镜像用户已熟悉的 `mcpServers` 块:

```json
{
  "downstreams": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "internal-api": {
      "url": "https://mcp.example.com/mcp",
      "transport": "streamable-http"
    }
  },
  "compression": {
    "default": { "maxOutputTokens": 2000, "htmlToMarkdown": true, "stripBase64": true },
    "perTool": {
      "github/get_file_contents": { "maxOutputTokens": 8000 }
    }
  },
  "report": { "enabled": true, "format": ["terminal", "png"] }
}
```

---

## 4. 技术栈

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | **TypeScript** | MCP 的"母语";生态与官方 SDK 同步最快 |
| SDK | `@modelcontextprotocol/sdk`(官方) | 代理/网关类基础设施需要底层传输控制,官方 SDK 提供 |
| 分发 | **npx 一行命令** | Claude Code 用户接入 MCP server 的既定习惯,零安装摩擦 |
| HTML→MD | turndown 或同类 | 成熟稳定 |
| token 计数 | Anthropic `count_tokens` API | 唯一准确来源 |
| 测试 | vitest + 真实下游 server 集成测试 | 对着 filesystem/github/fetch 等真 server 测 |

> 备选:Python FastMCP 有现成的 `from_client` / `mount` 代理原语,如果更熟 Python 是合法选项;但 `uvx` 分发对目标受众摩擦略高,且社区共识是 MCP 基础设施类项目用官方 SDK 拿底层控制权。**结论:TypeScript。**

---

## 5. 安全设计

Context Firewall 是所有工具流量的必经关口,安全姿态必须明确:

1. **默认不记录工具参数**(可能含密钥),日志脱敏,debug 模式需显式开启
2. **下游工具描述视为不可信输入**——tool-poisoning 是已记录的 MCP 攻击面;描述只透传不执行
3. **凭证只存在于环境变量/下游配置**,绝不进入节省报告或任何产物
4. **截断不得吞掉安全相关输出**(见 3.2)
5. 文档中明确威胁模型:本项目是本地单用户代理,不做多租户隔离(那是 MCPJungle 们的赛道)

---

## 6. 范围划分

### MVP(Week 1–2 完成)

- [x] stdio 代理:按 JSON 配置包裹 N 个下游 server
- [x] 3 个元工具(search_tools 用关键词匹配)
- [x] 输出截断 + `read_more` 取回工具
- [x] 基础 token 计数(前后对比)

**MVP 验收标准:** 对着 5 个真实 server(filesystem、github、fetch 等)跑通,`count_tokens` 前后对比显示有意义的节省。

### v1.0(Week 3–4 完成)

- [ ] HTML→Markdown、JSON 结构感知摘要、base64 剥离
- [ ] 按 server / 按 tool 的压缩策略
- [ ] Streamable HTTP 下游桥接
- [ ] 打磨版节省报告(终端 + PNG)
- [ ] 响应缓存(相同调用直接命中)

### 明确不做(v1.0 内)

- 多租户 / RBAC / 审计(企业网关赛道,不碰)
- 远程托管版本
- 语义搜索 embedding(v1.1 再说)

---

## 7. 风险与应对

| 风险 | 预警信号 | 应对 |
|---|---|---|
| Anthropic 官方推出一方输出截断 | 官方 changelog / 发布会 | 立即转向"报告/可观测性 + 跨客户端广度"角度;文案本来就是互补定位,损伤可控 |
| 赛道被大厂网关吸走注意力 | MetaMCP 等加输出压缩功能 | 打"个人开发者零配置 + 晒图报告"的轻量定位,他们做不了这么轻 |
| 发布一周 <30 star | star-history 曲线平 | 是定位/README 问题不是代码问题:重写首屏,换第二渠道重发 |

---

## 8. 发布物料要点

- **README 首屏:** 一句话("把 52 个 MCP 工具变成 3 个,再把输出瘦身 90%——任何客户端、任何模型")+ demo GIF + npx 一行 quickstart + 徽章行
- **Demo GIF 分镜:** Claude Code 显示 52 个工具 → 启动 firewall → 变 3 个 → 调用一个会吐巨型 HTML 的工具 → 返回紧凑预览 + 取回句柄 → 结尾卡片"本 session 节省 61,000 tokens"
- **双语 README**(中/英),中文版单独开 V2EX / 掘金渠道
- **提交目录:** mcp.so(~20K server,单次提交杠杆最大)、官方 MCP Registry、punkpeye / wong2 / appcypher / TensorBlock 各 awesome-mcp-servers、glama.ai、smithery.ai、PulseMCP
