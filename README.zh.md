# Context Firewall

[English README](./README.md)

[![npm](https://img.shields.io/npm/v/context-firewall)](https://www.npmjs.com/package/context-firewall) [![CI](https://github.com/Alepha188838884/context-firewall/actions/workflows/ci.yml/badge.svg)](https://github.com/Alepha188838884/context-firewall/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/context-firewall)](./LICENSE) [![Glama score](https://glama.ai/mcp/servers/Alepha188838884/context-firewall/badges/score.svg)](https://glama.ai/mcp/servers/Alepha188838884/context-firewall)

**在大体积 MCP 工具输出进入模型上下文窗口之前,先把它瘦身 60–95%——同时把 50+ 个工具定义收敛成 4 个。** 真实 HTML/JSON 实测,见 [benchmarks](https://github.com/Alepha188838884/context-firewall/blob/main/docs/BENCHMARKS.md)。适配任意 MCP 客户端、任意模型。压缩后仍超出你配置的 token 预算的输出,会被硬截断到该预算以内,完整原文始终可通过 `read_more` 取回。

![真实 session 的节省报告卡片:27 个工具收敛为 4 个,节省约 143,391 tokens,约占 200K 上下文窗口的 71.7%](https://raw.githubusercontent.com/Alepha188838884/context-firewall/main/docs/assets/report-card.svg)

*进程退出时打印的 session 报告——这张来自一次真实的 3 调用 session(两次大文件读取、一次 echo)。每个数字都是实测,没有模拟。*

Context Firewall 是一个本地 MCP 代理,坐在你的 AI agent(Claude Code、Claude Desktop、Cursor、Cline……)和你配置的每一个下游 MCP server 之间。巨大的工具输出(原始 HTML、base64 大块、超长 JSON)在进入模型上下文窗口之前会先被压缩;不管下游有多少个工具,客户端始终只看到 4 个。

## 实测数据

| 指标 | 结果 |
| --- | --- |
| 输出压缩 | 真实 HTML 页面 **70–94%**、大体积结构化 JSON **约 97%**(智能压缩阶段本身的数字,不含预算截断)——例如通过 `fetch` 工具实时抓取的 Wikipedia 页面:232,391 → 6,907 字符(**97.0%**,实测);经 `jsonSummary` 阶段处理的 GitHub issues JSON:186,810 → 3,480 字符(**98.1%**,实测) |
| 工具收敛 | **122 → 4** 个暴露的元工具(5 个真实下游 server,含官方 GitHub `github-mcp-server`,85 个工具) |
| 工具定义节省 | **约 28,600 tokens**(*估算值,字符数 ÷ 3.5*)—— 原始定义 102,158 字符 vs. 暴露后 2,146 字符 |

以上数字均基于真实下游 MCP server 实测,非合成数据——完整方法论与数据表见 [docs/BENCHMARKS.md](https://github.com/Alepha188838884/context-firewall/blob/main/docs/BENCHMARKS.md)。

## 它做什么

- **渐进式工具披露** —— 客户端不再在启动时加载所有下游工具的完整 schema,而是只看到 4 个元工具(`list_tool_categories`、`search_tools`、`invoke_tool`、`read_more`);只有真正搜索到某个工具时,才会为它的完整 schema 付出 token 成本。
- **输出压缩流水线** —— 大体积的工具结果依次经过 base64 剥离、正文提取 + HTML→Markdown 转换(当页面存在可识别的正文区域时,导航、站点页眉/页脚等 chrome 会被剥离,让 token 预算花在真正的内容而不是导航链接上)、JSON 结构感知摘要、最后是字符预算截断,才会被返回。
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
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

(上面的 `${GITHUB_TOKEN}` 只是本例选用的环境变量*名字*——用你 shell 里已有的变量名即可;它会被展开进 `GITHUB_PERSONAL_ACCESS_TOKEN`,这才是下游 server 自己实际读取的环境变量名。)

**该用哪个 GitHub server?** 有两种选择,工具数量不同:

- **`@modelcontextprotocol/server-github`**(上面用的这个)—— 最早的 npm 包,26 个工具,一行 `npx -y` 即可用,无需额外安装。上游已归档/不再维护,但仍可正常工作。
- **[`github/github-mcp-server`](https://github.com/github/github-mcp-server)** —— 官方持续维护的 server,44 个工具(默认 toolset)到 85 个(`GITHUB_TOOLSETS=all`)。以 Go 二进制或 Docker 镜像形式发布,不是 npm 包:

  ```json
  "github": {
    "command": "docker",
    "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
  }
  ```

  或者直接运行本地编译/下载好的二进制:`"command": "/path/to/github-mcp-server", "args": ["stdio"]`(同样的 `env` 块;加上 `GITHUB_TOOLSETS` 可以限定 85 个工具里实际暴露哪些)。

**按工具粒度的允许/拒绝策略。** 在任意下游配置项上加 `allowTools`/`denyTools`(元素为精确名称或带 `*` 的 glob),即可限制该 server 上哪些工具可被调用:

```json
"github": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "denyTools": ["delete_*"]
}
```

拒绝始终优先于允许。设置了 `allowTools` 后,只有匹配到的工具才被放行,该 server 上其余工具一律拒绝。空数组 `allowTools: []` 等同于不设置(即全部允许),而不是"全部拒绝"。被拒绝的工具不会出现在 `search_tools` 的结果里,`invoke_tool` 也会在派发到下游 server 之前就拒绝调用。`list_tool_categories` 里的工具计数以及元工具描述里的数字都是未经策略过滤的全量计数——策略只在 `search_tools`/`invoke_tool` 时才会生效。

## 客户端配置

**把 Context Firewall 设为你唯一的 MCP server**——把你目前直接挂的所有下游 server(filesystem、github、everything……)统统搬进 `context-firewall.json` 的 `downstreams` 块。这样你的 agent 看到的就是 4 个工具,而不是所有下游 server 工具数量的总和;如果只是把 Context Firewall *额外*加在现有 server 旁边,是拿不到工具收敛和压缩这两项收益的。

下面每个客户端用的都是同一段 server 配置:

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

### Claude Code

项目级 `.mcp.json`(放在仓库根目录,格式同上),或者用 CLI:

```bash
claude mcp add --transport stdio context-firewall -- npx -y context-firewall --config /absolute/path/to/context-firewall.json
```

### Claude Desktop

`claude_desktop_config.json`(macOS:`~/Library/Application Support/Claude/claude_desktop_config.json`;Windows:`%APPDATA%\Claude\claude_desktop_config.json`)——`mcpServers` 块同上。

### Cursor

`.cursor/mcp.json`(项目级)或 `~/.cursor/mcp.json`(全局)——`mcpServers` 块同上。

### Cline

`cline_mcp_settings.json`(VS Code 扩展存储目录;macOS:`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`)——`mcpServers` 块同上。

### 兼容性状态

| 客户端 | 状态 |
| --- | --- |
| Claude Code | **真实 agent 会话实测通过** —— 自主 list → search → invoke → read_more 工作流端到端验证 |
| Claude Desktop | 协议级验证* |
| Cursor | 配置格式已核实文档,欢迎社区实测反馈 |
| Cline | 配置格式已核实文档,欢迎社区实测反馈 |

\* 通过 MCP 协议集成测试验证(236 个自动化测试,含针对真实下游 server 的完整 stdio 协议往返,[每次 push 都在 CI 上运行](https://github.com/Alepha188838884/context-firewall/actions/workflows/ci.yml))。欢迎真实客户端使用反馈。

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
      "llmSummary": false,
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
| `htmlToMarkdown` | boolean | `true` | 将识别出的 HTML 转换为 Markdown,并在可识别正文区域时先做正文提取(剥离 nav/页眉/页脚 chrome)。 |
| `stripBase64` | boolean | `true` | 把 base64 大块(data URI 和裸块)替换为可用 `read_more` 取回的句柄。 |
| `jsonSummary` | boolean | `true` | 折叠同构 JSON 数组、裁剪超长字符串字段,同时保持结果仍是合法 JSON。 |
| `llmSummary` | boolean | `false` | 用你自选的 LLM 对超预算输出做语义摘要。需要配合顶层 `llm` 配置块——见 [LLM 语义摘要(可选启用)](#llm-语义摘要可选启用)。 |
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

客户端先调用 `list_tool_categories()` 看看连接了哪些下游、大致有什么能力,再用 `search_tools(query)` 为候选工具拉取完整的输入 schema,然后用 `invoke_tool(server, tool, args)` 实际调用某个工具(返回前会经过压缩),最后可以用 `read_more(handle, offset, length)` 分页取回被压缩掉的部分。压缩一旦触发,顺序永远固定:base64 剥离 → 正文提取 + HTML 转 Markdown → JSON 结构摘要 → 截断到预算内(若启用了下面的可选 LLM 语义摘要阶段,它会紧挨在截断之前运行)。正文提取在设计上是保守的:只有当页面存在可识别的语义正文区域(`<article>`/`<main>`),或被剥离的明显不是页面的实际内容时才会剥离 chrome,否则回退到整页转换——无论哪条路径,完整原文始终可通过 `read_more` 取回。安全相关的输出(错误信息、权限/警告/确认类提示)绝不会被静默压缩——它们会直接透传,仅在超过 50,000 字符时做硬性截断,防止单次异常的报错洪流把调用方的上下文撑爆。

## LLM 语义摘要(可选启用)

确定性流水线能剥离标记、折叠重复结构、做截断——但它无法对一段很长的自然语言输出(日志文件、文章、报告)做*语义级*压缩:确定性阶段跑完之后,仍然超预算的部分只能被硬生生切掉。这个可选阶段正是补这个缺口的:它把超预算的文本发给你自选的模型做事实性摘要(保留 ID、路径、URL、数字和错误信息),在结果后附上指向完整原文的 `read_more` 句柄,截断仍然作为最后的兜底保留。它**默认关闭**,且需要在两个独立层面显式启用:顶层 `llm` 配置块*和*压缩策略里的 `llmSummary: true`。任何 OpenAI 兼容的 `/chat/completions` 端点都可以用——既可以选一个服务商预设,也可以用 `baseUrl` 指向任意端点。

```json
{
  "llm": {
    "provider": "openrouter",
    "model": "your-model-name"
  },
  "compression": {
    "default": { "llmSummary": true }
  }
}
```

`provider` 是一个简写,展开为预设的基础 URL 加一个约定俗成的 API 密钥环境变量:

| 服务商 | 基础 URL | 密钥环境变量 |
| --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `orcarouter` | `https://api.orcarouter.ai/v1` | `ORCAROUTER_API_KEY` |
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |

其他任意 OpenAI 兼容端点改用 `baseUrl`(此时 `apiKey` 必填):

```json
{
  "llm": {
    "baseUrl": "https://api.your-provider.example/v1",
    "apiKey": "${LLM_API_KEY}",
    "model": "your-model-name"
  },
  "compression": {
    "default": { "llmSummary": true }
  }
}
```

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `provider` | string | *(无)* | 上表中的某个预设名。`provider` 和 `baseUrl` 二选一必填;两者都设置时,显式的 `baseUrl` 优先(并给出警告)。 |
| `baseUrl` | string | *(来自预设)* | 任意 OpenAI 兼容端点的基础 URL;本阶段会 POST 到 `<baseUrl>/chat/completions`。未设置 `provider` 时必填。 |
| `apiKey` | string | *(来自预设环境变量)* | 以 `Authorization: Bearer ...` 发送。设置了 `provider` 时,默认读取该预设的密钥环境变量;显式设置的值(请用 `${ENV_VAR}` 展开——永远不要写明文密钥)会覆盖它。只用 `baseUrl` 时必填。 |
| `model` | string | *(必填)* | 原样传给端点的模型名。 |
| `timeoutMs` | number | `20000` | 超过此时长中止请求;超时后本阶段直接跳过。 |
| `maxInputChars` | number | `120000` | 发给 API 的文本从头部截断到此字符数(硬性绝对上限 400,000,不受配置影响——成本保护)。 |

[OrcaRouter](https://orcarouter.ai) 配置示例——搭配免费模型效果很好(`orcarouter/free` 是他们按难度路由的免费档;API 密钥从 `ORCAROUTER_API_KEY` 读取):

```json
{
  "llm": {
    "provider": "orcarouter",
    "model": "orcarouter/free"
  },
  "compression": {
    "default": { "llmSummary": true }
  }
}
```

可直接运行的完整示例:[`examples/config.llm-orcarouter.json`](examples/config.llm-orcarouter.json) 和 [`examples/config.llm-generic.json`](examples/config.llm-generic.json)。

**故障模式**:端点宕机、无法连通、超时或返回任何格式不对的内容时,本阶段会静默跳过,输出回退到确定性截断——端点不可用永远不会弄坏你的工具调用。

**隐私**:启用后,超预算且非安全敏感的工具输出会被发送到你配置的那个端点——除此之外,不发给任何其他地方。安全敏感的输出(错误、权限拒绝、警告、确认类提示)在到达本阶段之前就已绕过压缩流水线,永远不会被发送。如果把工具输出内容发给该端点对你的数据来说不可接受,请不要启用。

### 披露声明

Context Firewall 参与了 OrcaRouter Open Source Program:如果你选择 OrcaRouter 作为端点,本项目会获得由此产生的使用收入的 5%。这不会改变你的价格,完全是可选的,任何 OpenAI 兼容的服务商都能以完全相同的方式工作。

## 定位说明

Context Firewall 与 Anthropic 官方的 Tool Search Tool 是**互补**关系,不是竞品。Tool Search 解决的是启动时的工具**定义**膨胀问题(工具被调用之前就加载进上下文的 schema),且仅限 Claude 系产品。Context Firewall 压缩的是调用时的工具**输出**——这正是 Tool Search 没有覆盖的另一半——并且适配任意 MCP 客户端、任意模型,不只是 Claude。

## 关于 token 计数的说明

本项目中的每一个 token 计数(截断预算、session 报告)都是按 `字符数 / 3.5` 估算得出的,从不是针对具体模型的精确计数。**默认情况下**,项目中没有任何代码路径会把你的工具输出内容发送给外部 API——token 计数不会,其他任何用途也不会。如果你显式启用了可选的 [LLM 语义摘要阶段](#llm-语义摘要可选启用),超预算的输出会被发送到**你自己**配置的那个端点——除此之外,不发给任何其他地方;token 计数无论如何都留在本地。正因如此,session 报告始终标注为"(estimated / 估算值)"。

## 安全性

- 工具参数和输出内容永远不会写入日志或 session 报告——只记录 server/tool 名称以及字符/token 计数。
- 安全相关的输出(错误、权限拒绝、警告、确认类提示)绝不会被静默压缩。
- 默认情况下,工具输出内容不会离开你的机器(你自己配置的下游 server 除外)。可选的 [LLM 语义摘要阶段](#llm-语义摘要可选启用)是唯一可能把它发往别处的代码路径,它默认关闭,且安全敏感的输出永远不会到达它。
- 下游工具描述被视为不可信输入,只会被展示,永远不会被执行。
- 下游工具描述会原样透传、不做任何消毒处理——`search_tools` 不会剔除或过滤恶意下游可能植入的提示注入文本。信任边界在于你选择挂载哪些下游 server,而不是这个网关本身。
- 渐进式披露有一个真实的权衡:工具描述是按需到达的——就在调用方模型主动调用 `search_tools` 查询的那一刻,发生在会话中途;而这恰恰也是模型对嵌入指令警惕性最低的时刻,相比之下,所有工具在会话开始时就一次性摆出来反而更容易被审视。从 v0.3.0 起,我们用两种方式缓解这个问题:`search_tools` 的结果会被包在 `<untrusted-tool-descriptions nonce="...">...</untrusted-tool-descriptions nonce="...">` 定界标签里,标签携带一个进程启动时生成一次的随机 nonce(`crypto.randomBytes(8).toString('hex')`,在整个进程生命周期内保持不变),并附带提示告诉模型:只有携带相同 nonce 的闭合标签才代表这个区块真正结束;同时 CLI 会在启动时向 stderr 打印一份人类可读的 digest(server 名称、工具数量、主要分类),让操作者一眼就能看到实际接入了什么。这个 nonce 专门用来防御一种字面绕过:下游在自己的 description 里写死一段 `</untrusted-tool-descriptions>` 文本,后面跟上伪造的"可信系统"指令——由于下游无法预知 nonce 的值,它伪造不出匹配的闭合标签。**残留风险**:这仍然只是文本层面的约定,不是沙箱——它依赖调用方模型真的去读那句提示并按 nonce 匹配来判断真伪;如果模型完全无视这套框架,这个机制就起不到任何保护作用。这两个缓解手段都不会对描述内容本身做消毒——见上一条。按本项目统一的 chars/3.5 估算口径,定界框架现在大约会给每次 `search_tools` 调用增加 80-85 个 token 的开销(约 289 个字符)。
- `list_tool_categories` 展示的分类词同样源自下游数据(工具名,经过 `registry.ts` 里一个粗糙的动词前缀启发式规则提取)——但工具名作为夹带指令的信道,带宽远低于自由文本的 description,而且这部分输出也没有包在上面的定界标签里。可以把它当作风险低于 `search_tools` 输出,但并非零风险。

## License

MIT
