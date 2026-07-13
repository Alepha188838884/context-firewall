# Context Firewall

[English README](./README.md)

**把 50+ 个 MCP 工具变成 3 个,再把工具输出瘦身最多 90%——适配任意 MCP 客户端、任意模型。**

Context Firewall 是一个本地 MCP 代理,坐在你的 AI agent(Claude Code、Claude Desktop、Cursor、Cline……)和你配置的每一个下游 MCP server 之间。不管下游有多少个工具,客户端始终只看到 4 个工具;在巨大的工具输出(原始 HTML、base64 大块、超长 JSON)进入模型上下文窗口之前,先把它们压缩掉。

## 它做什么

- **渐进式工具披露** —— 客户端不再在启动时加载所有下游工具的完整 schema,而是只看到 4 个元工具(`list_tool_categories`、`search_tools`、`invoke_tool`、`read_more`);只有真正搜索到某个工具时,才会为它的完整 schema 付出 token 成本。
- **输出压缩流水线** —— 大体积的工具结果依次经过 base64 剥离、HTML→Markdown 转换、JSON 结构感知摘要、最后是字符预算截断,才会被返回。
- **完整输出可通过 `read_more` 取回** —— 没有任何内容被静默丢弃。每一次被压缩的输出都会完整存入本地(内存中,配一个不透明句柄),可以用 `read_more(handle, offset, length)` 分页取回。
- **session 节省报告** —— 进程退出时,会打印一张可分享的终端卡片(也可选择写入 Markdown 文件),展示本次 session 工具定义和输出的 token 节省量,以及节省最多的工具排行。

## 快速开始

```bash
npx context-firewall --config context-firewall.json
```

最小化的 `context-firewall.json`(`downstreams` 块的写法就是你已经熟悉的 `mcpServers` 格式):

```json
{
  "downstreams": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

### Claude Code / Claude Desktop

把你现有的 `mcpServers` 配置指向 Context Firewall,让它作为**唯一**的 MCP server,由它接管所有下游连接:

```json
{
  "mcpServers": {
    "context-firewall": {
      "command": "npx",
      "args": ["-y", "context-firewall", "--config", "/absolute/path/to/context-firewall.json"]
    }
  }
}
```

这样你的 agent 看到的就是 4 个工具,而不是所有下游 server 工具数量的总和。

## 配置

### `downstreams`

每一项要么是 **stdio** server(和 `mcpServers` 写法一致),要么是 **Streamable HTTP** server:

```json
{
  "downstreams": {
    "local-tool": { "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "TOKEN": "${TOKEN}" } },
    "remote-tool": { "url": "https://mcp.example.com/mcp", "transport": "streamable-http" }
  }
}
```

任意字符串值中的 `${VAR_NAME}` 会从环境变量展开;缺失的变量会在加载配置时直接报出可读的错误。

### `compression`

策略解析顺序为 `default` < `perServer` < `perTool`(逐字段覆盖,后者优先):

```json
{
  "compression": {
    "default": {
      "maxOutputTokens": 2000,
      "htmlToMarkdown": true,
      "stripBase64": true,
      "jsonSummary": true,
      "bypass": false
    },
    "perServer": { "github": { "maxOutputTokens": 4000 } },
    "perTool": { "filesystem/read_file": { "maxOutputTokens": 8000 } }
  }
}
```

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `maxOutputTokens` | number | `2000` | 软预算(字符数 ≈ token 数 × 3.5),作为最后兜底,压缩后的输出会截断到此预算内。 |
| `htmlToMarkdown` | boolean | `true` | 将识别出的 HTML 标记转换为 Markdown。 |
| `stripBase64` | boolean | `true` | 把 base64 大块(data URI 和裸块)替换为可用 `read_more` 取回的句柄。 |
| `jsonSummary` | boolean | `true` | 折叠同构 JSON 数组、裁剪超长字符串字段,同时保持结果仍是合法 JSON。 |
| `bypass` | boolean | `false` | 对该 server/tool 完全跳过压缩流水线——输出原样透传。 |

### `report`

```json
{
  "report": {
    "enabled": true,
    "markdownPath": "./context-firewall-report.md"
  }
}
```

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 进程退出时把 session 报告打印到 stderr。 |
| `markdownPath` | string | *(无)* | 若设置,则同时把报告写入该路径的 Markdown 文件。 |

### `callToolTimeoutMs`

顶层字段(不嵌套在 `compression` 下)。传给下游 MCP SDK client 的单次 `invoke_tool` 超时(毫秒);下游挂起不响应时,`invoke_tool` 会在超时后返回 `isError` 结果而不是一直阻塞。不设置时使用 SDK 自身默认值(60,000ms)。

```json
{ "callToolTimeoutMs": 30000 }
```

## 工作原理

客户端先调用 `list_tool_categories()` 看看连接了哪些下游、大致有什么能力,再用 `search_tools(query)` 为候选工具拉取完整的输入 schema,然后用 `invoke_tool(server, tool, args)` 实际调用某个工具(返回前会经过压缩),最后可以用 `read_more(handle, offset, length)` 分页取回被压缩掉的部分。压缩一旦触发,顺序永远固定:base64 剥离 → HTML 转 Markdown → JSON 结构摘要 → 截断到预算内。安全相关的输出(错误信息、权限/警告/确认类提示)绝不会被静默压缩——它们会直接透传,仅在超过 50,000 字符时做硬性截断,防止单次异常的报错洪流把调用方的上下文撑爆。

## 定位说明

Context Firewall 与 Anthropic 官方的 Tool Search Tool 是**互补**关系,不是竞品。Tool Search 解决的是启动时的工具**定义**膨胀问题(工具被调用之前就加载进上下文的 schema),且仅限 Claude 系产品。Context Firewall 压缩的是调用时的工具**输出**——这正是 Tool Search 没有覆盖的另一半——并且适配任意 MCP 客户端、任意模型,不只是 Claude。

## 关于 token 计数的说明

本项目中的每一个 token 计数(截断预算、session 报告)都是按 `字符数 / 3.5` 估算得出的,从不是针对具体模型的精确计数。项目中没有任何代码路径会把你的工具输出内容发送给外部 API 来获取精确计数——那样会与下面的安全立场相冲突。正因如此,session 报告始终标注为"(estimated / 估算值)"。

## 安全性

- 工具参数和输出内容永远不会写入日志或 session 报告——只记录 server/tool 名称以及字符/token 计数。
- 安全相关的输出(错误、权限拒绝、警告、确认类提示)绝不会被静默压缩。
- 下游工具描述被视为不可信输入,只会被展示,永远不会被执行。

## License

MIT
