# Context Firewall v0.1 — 发布前测试方案

> 现状基线:133 个自动化测试全绿(126 单测 + 7 集成,集成挂真实 server-everything / server-filesystem)。
> 已覆盖:纯函数正确性、压缩流水线各 stage、安全直通、artifact 分页、基本端到端。
> 本方案针对**尚未覆盖的缺口**,按发布阻塞程度排序:P0 = publish 前必须过,P1 = 强烈建议,P2 = 可延后。

---

## P0-1 分发链路测试(npm pack → 全新目录安装 → bin 可执行)

**目的**:我们从未验证过"用户视角"的安装路径。集成测试全部用 `tsx src/cli.ts` 跑源码,`dist/cli.js` 的 bin 入口、shebang、files 字段、依赖完整性从未被真实执行过——这是 npm 包最常见的翻车点。

**步骤**:
1. `npm run build && npm pack` 生成 tarball
2. 检查 tarball 内容:`tar -tzf *.tgz` — 必须含 dist/、README、LICENSE;不得含 src/、test/、node_modules/(核对 package.json `files` 字段,当前可能缺失)
3. 在干净临时目录 `npm install <tarball 绝对路径>`,然后 `npx context-firewall --help`
4. 用该安装版(非源码)跑一遍现有集成测试的手动等价物:挂 everything server,4 元工具全部调用一轮
5. Node 版本矩阵:本机 22 为主;如有 nvm,补 Node 20(engines 声明 >=22,验证 20 下报错信息是否可读)

**通过标准**:全新目录 `npx context-firewall --config x.json` 直接可用,行为与源码版一致。
**执行方式**:可完全自动化(脚本);~30 分钟。

## P0-2 真实客户端验收:Claude Code 实测(核心 UX 假设验证)

**目的**:整个产品建立在一个未验证的假设上——**agent 会自主走 list_tool_categories → search_tools → invoke_tool → read_more 的工作流**。如果真实 agent 面对 4 个元工具不知道怎么用、或不愿意二段式调用,产品就不成立。这只能用真实客户端测。

**步骤**:
1. 在 Claude Code 项目配置 `.mcp.json` 挂 context-firewall 为唯一 MCP server(下游配 filesystem + everything + fetch),重启会话
2. `/mcp` 确认只见 4 个工具
3. 给 agent 自然语言任务(不提工具名):
   - "读取 X 目录下最大的 JSON 文件并总结" → 观察是否自主 search→invoke
   - "抓取 <某个真实网页> 并提取要点" → 观察 HTML 压缩后 agent 能否正常工作、需要细节时是否会用 read_more
   - 故意让它调不存在的工具/server → 错误提示是否足以让 agent 自我纠正
4. 退出会话,确认 stderr 节省报告卡片渲染正确
5. Claude Desktop 重复 1-2(配置格式验证 + 4 工具可见即可,不必重复全部任务)

**通过标准**:agent 无人工提示自主完成 ≥2 个任务;卡片数字合理;全程无协议错误。
**执行方式**:需要用户参与(真实交互观察);~40 分钟。**这是最重要的单项测试。**

## P0-3 压缩效果真实基准(校准 README 宣称)

**目的**:README 写着 "shrink tool outputs by up to 90%"、报告展示节省数字——这些宣称目前只有合成 fixture 支撑。发布后第一批用户会拿真实 server 检验,数字虚了直接损害可信度。

**步骤**(脚本化,产出一张基准表进 STATE.md):
1. fetch server 抓 5 个真实网页(新闻页、GitHub README 页、API 文档页、Wikipedia、SPA 首页)→ 记录 HTML→MD 各自压缩率
2. github server(需 GITHUB_TOKEN)调 search_repositories、list_issues 等返回大 JSON 的工具 → JSON 摘要压缩率
3. everything server 图片工具 → base64 剥离率
4. 每项记录:原始字符数 / 压缩后 / 各 stage 贡献 / 信息是否够 agent 使用(人工抽查压缩后文本可读性)
5. 据实修订 README 数字(如实际是 60–85% 就写 60–85%)

**通过标准**:得到 ≥8 个真实样本的基准表;README 宣称与实测一致。
**执行方式**:可自动化 + 人工抽查;~45 分钟。

## P1-1 多下游规模测试(设计文档 MVP 验收标准)

**目的**:设计文档验收标准是"对着 5 个真实 server 跑通";目前只测过 2 个。且 GitHub server(94 工具)是定义节省卖点的标杆案例,必须实测。

**步骤**:同时挂 5 个下游:filesystem、everything、fetch、github(需 token)、memory(或 sequential-thinking)。验证:
- 全部 connected,list_tool_categories 汇总正确且 <300 token
- search_tools 跨 server 命中(query "create issue" 应命中 github 而非 filesystem)
- 定义节省实测:report 的 definition savings 应达数万 token 量级
- 1 个 server 故意配错 + 4 个正常:降级不影响其余

**通过标准**:5 server 全通,GitHub 94 工具定义节省数字入报告。
**执行方式**:自动化脚本(github 部分需用户提供 token);~30 分钟。

## P1-2 健壮性 / 混沌测试

**目的**:代理是所有流量必经关口,下游的任何异常行为都不能崩掉 gateway。

**场景清单**(每个写成可重复脚本,部分可入 test/integration/chaos.test.ts):
| # | 场景 | 期望行为 |
|---|---|---|
| 1 | invoke 进行中 kill -9 下游进程 | 该调用返回 isError,后续调用报 unavailable,gateway 不退出 |
| 2 | 下游 hang(不响应 callTool) | SDK 默认 60s 超时 → isError 返回;确认超时值并考虑配置化 |
| 3 | 下游返回 10MB 单条文本 | 流水线不 OOM、不卡死 >5s;截断 + handle 正常 |
| 4 | 下游返回非法 JSON-RPC / 畸形 content | catch 包 isError,不崩 |
| 5 | 并发 10 个 invoke_tool(同 server) | 全部正确返回,无串扰(handle 不错乱) |
| 6 | artifact store 压力:250 个大输出调用 | FIFO 淘汰生效,旧 handle 给出可读过期错误,内存回落 |
| 7 | 上游客户端中途断开 | manager.close() 全部下游子进程被回收,无孤儿进程(ps 验证) |

**通过标准**:7/7 场景符合期望;场景 7 无孤儿进程是硬标准。
**执行方式**:可自动化;~60 分钟。

## P1-3 安全验证

**目的**:README/文档做出了安全承诺,逐条验证。

1. **密钥不入日志**:下游配置 env 含假密钥,`CF_DEBUG=1` 跑全流程,grep stderr 全量输出——密钥字符串零出现(注意:子进程 stderr 转发路径可能把下游自己打印的 env 泄出来,重点检查)
2. **报告不泄内容**:调用含独特标记字符串的工具后,render()/renderMarkdown() 输出 grep 该标记 = 零命中(已有单测,补端到端确认)
3. **安全直通端到端**:真实 filesystem 权限拒绝、github 401(坏 token)→ 输出原样直达上游,无压缩标注
4. **tool-poisoning 透传立场**:给一个 mock 下游工具的 description 注入指令文本("ignore previous instructions..."),确认我们仅原样透传(search_tools 返回原文)、自身逻辑不受影响——并在 README 安全节注明"描述透传不消毒,信任边界在用户选择的下游"
5. **配置注入**:`${ENV_VAR}` 展开对含 `"` / 换行的 env 值不产生 JSON 结构破坏

**通过标准**:1、2 零泄漏是硬标准;3-5 行为符合文档描述。
**执行方式**:可自动化;~40 分钟。

## P2-1 Soak 长时运行

30 分钟持续调用(每 10s 一次长输出),观察 RSS 内存曲线平稳(TTL 清理生效)、无 fd 泄漏(`lsof` 前后对比)。~40 分钟,可后台跑。

## P2-2 跨客户端兼容矩阵

Claude Code / Claude Desktop 实测(P0-2 已含);Cursor、Cline 至少完成配置文档验证(各自 mcp.json 格式片段写进 README),有条件则实连。发布后可靠社区反馈补齐。

## P2-3 性能开销基准

压缩流水线自身延迟:100KB / 1MB / 10MB 输入各 stage 耗时(turndown 对大 HTML 是已知慢点)。阈值建议:1MB 输入总延迟 <500ms。超标则记 STATE.md 待办(如 html stage 加输入大小上限)。~20 分钟。

---

## 执行顺序与分工建议

| 批次 | 项目 | 依赖 | 谁执行 |
|---|---|---|---|
| 1 | P0-1 分发链路 | 无 | 自动化(fast-worker) |
| 2 | P1-2 混沌 + P1-3 安全(并入自动化测试套件) | 无 | 自动化(fast-worker) |
| 3 | P1-1 五下游规模 + P0-3 压缩基准 | GITHUB_TOKEN(用户提供) | 自动化 + 人工抽查 |
| 4 | **P0-2 Claude Code 实测** | 批次 1-3 全绿 | **用户 + Claude 共同** |
| 5 | P2-x 按余量 | — | 自动化 |

全部 P0 + P1 通过 → 修订 README 数字 → `npm publish` 解锁。
