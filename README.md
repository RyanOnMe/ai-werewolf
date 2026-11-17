# AI 狼人杀

一个**全程由 AI 游玩**的狼人杀，支持 9 人标准局与 12 人预女猎白上警局：

- **法官是确定性程序**：发身份、夜晚结算、天亮、警长竞选、发言顺序、投票、放逐、猎人开枪、警徽移交、胜负判定，全部由 `GameEngine` 负责。
- **玩家是 pi agent loop 驱动的 LLM agent**：每个座位一个持久 `pi Agent`，拥有独立上下文和角色策略手册，通过 tool use 发言/上警/投票/刀人/查验/用药/开枪/移交警徽。
- **信息隔离**：每个 agent 只能看到自己有权看到的事件；狼队频道、查验结果、女巫用药不会泄露给错误的人。
- **可验证**：规则单测、30 局 9 人随机全流程、20 局 12 人随机全流程、fake-model 的 pi loop 集成测试、真实模型 smoke，一条命令跑完。

当前板子：
- **9 人局**：3 狼人、3 村民、预言家、女巫、猎人；无警长。
- **12 人局**：4 狼人、4 村民、预言家、女巫、猎人、白痴；第 1 天警长竞选，警长 1.5 票、死亡可移交警徽。夜晚死亡没有遗言。

## 快速开始

```bash
npm install

# 0) 可选：配置 Paratera 网关（DeepSeek-V4.1-Flash-1017 / MiniMax-M3.1-Flash）
cp .env.example .env   # 填入 PARATERA_API_KEY

# 1) 不需要模型鉴权：随机策略跑完一局
npm run play -- --scripted --seed demo

# 12 人局（含警长竞选、白痴）
npm run play -- --mode 12p --scripted --seed demo-12p

# 2) 真实模型跑一局
npm run play -- --mode 12p --model openai-codex/gpt-5.6-luna --seed live-12p

# 双模型按座位交替（奇数座位 → DeepSeek，偶数座位 → MiniMax）
npm run play -- --mode 12p --models "commandcode/deepseek/deepseek-v4.1-flash,commandcode/minimax/minimax-m3.1-flash" --seed dual-12p --stream

# 3) 先用最小回合验证模型/工具链
npm run smoke:llm -- --model commandcode/deepseek/deepseek-v4.1-flash
npm run smoke:llm -- --model commandcode/minimax/minimax-m3.1-flash

# 4) 查看可用的模型
npm run doctor

# 5) 浏览器观战（默认公开视角）
npm run serve

# 6) 上帝视角 + 自动打开浏览器
npm run serve -- --god --open

# 7) 指定新对局默认板子
npm run serve -- --god --board 12p --open

# 8) 双模型按座位交替
npm run serve -- --god --board 12p \
  --model "commandcode/deepseek/deepseek-v4.1-flash,commandcode/minimax/minimax-m3.1-flash" \
  --open
```

使用 Command Code 时，把 `.env.example` 复制为 `.env` 并填入 `COMMANDCODE_API_KEY`；CLI 和观战页会默认选择该网关的 DeepSeek V4.1 Flash。也可使用 pi 的登录状态（`~/.pi/agent/auth.json`，OAuth 或 API key）或配置 Paratera。`.env` 已被 Git 忽略。

## 观战前端

![12 人双模型观战台，当前发言实时更新](docs/assets/spectator-match-desk.png)

[查看窄屏观战布局](docs/assets/spectator-match-desk-mobile.png)

`npm run serve` 启动一个本地观战服务（默认 `http://127.0.0.1:7331`）：

- **9/12 个座位同屏**：显示存活、出局、翻牌、警徽和行动者，点击座位可查看完整模型名。Logo 按实际模型家族加载，本地素材来源见 [图标说明](web/models/README.md)。
- **赛况、纪事、情报**：当前发言和重试状态实时更新；长正文可翻页或打开“全文”，纪事可按事件类型和日期筛选。支持定格、跳到某条事件、自动回放和回到最新。
- **公开视角 / 上帝视角**：公开视角只接收公开事件和公开发言草稿；`--god` 可查看角色、狼队频道、查验、用药、死因和重试记录。
- **浏览器内开局**：可选 9 人或 12 人、脚本或真实模型。浏览器启动的真实模型局可看流式草稿；CLI 启动的对局也能从 `runs/` 观战，浏览器只读已确认事件，CLI 可用 `--stream` 看草稿。

草稿来自发言工具参数，取决于模型接口是否提供参数分片。草稿不进入回放和其他玩家的简报；只有法官确认的发言进入事件日志。服务端过滤私密内容，不提供 transcript 或完整摘要。默认只监听 `127.0.0.1`，不要把 `--host 0.0.0.0` 和 `--god` 一起暴露到公网。

## 验证

```bash
npm run verify
```

包含：

- `tsc --noEmit`
- 自动化测试
  - 规则单测：夜晚结算、女巫双药、猎人毒杀、投票平票、胜负优先级、信息可见性
  - 30 个 9 人种子 + 20 个 12 人种子的随机全流程：每局必须正常结束、胜者非空、事件 seq 连续、恰好一个 `game_end`、无非法动作；12 人局必须恰好一次警长竞选，夜间死亡不得有遗言
  - 12 人专项：上警、警长竞选投票、1.5 票、警徽移交、白痴翻牌免死/失去投票权、猎人开枪遗言
  - 模型路由：逗号/数组解析、双模型按座位交替、双模型组合生成、座位分配摘要
  - 狼队战术：首夜计划、计划只对狼队可见、下一夜可更新、默认动作与 `set_wolf_plan` 工具
  - pi agent loop 集成测试：用 fake model stream 走真实 `Agent` + 真实工具 schema，验证工具接受/拒绝、纠正提示、重复行动阻止、fatal 错误、警长工具
  - 观战服务：静态页、配置、脚本对局、12 人上警 SSE、公开/上帝过滤、403/404/路径穿越防护
  - 模型稳定性：断流后重试、指数退避次数上限、超时取消、永久错误跳过重试、草稿不触发工具或进入回放
- 两局通过真实 CLI 的 scripted 对局（9 人 + 12 人），并检查 `summary.json` 不变量

真实模型检查单独运行 `npm run smoke:llm`。历史对局观察见 [策略验证记录](docs/agent/strategy-eval.md)。

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│ GameEngine（纯 TS，唯一状态源）                               │
│  advance() ──► TurnRequest（谁 / 什么行动 / 合法目标）        │
│  submit(Action) ──► 规则校验 + 结算 + 事件                    │
└───────────────┬──────────────────────────────────────────────┘
                │ PlayerView + brief（按 visibility 过滤）
                ▼
┌──────────────────────────────────────────────────────────────┐
│ PiPlayer（每个座位一个持久 pi Agent）                         │
│  system prompt：身份 + 完整规则 + 角色策略手册 + 行为准则     │
│  每回合 tools：say / vote / sheriff_run / transfer_badge / ...│
│  shouldStopAfterTurn：terminal tool 被接受即结束 agent loop   │
└───────────────┬──────────────────────────────────────────────┘
                │ Action
                ▼
         GameEngine.submit()
                │
                ▼
   events.ndjson / summary.json / transcripts/
```

更完整的设计见 [docs/design/architecture.md](docs/design/architecture.md)，规则见 [docs/rules/9p.md](docs/rules/9p.md) 与 [docs/rules/12p.md](docs/rules/12p.md)。

观战前端是同一份事件流的只读消费者：

```
GameEngine ──► events.ndjson ──► SSE /api/games/:id/events?view=public|god
                                        │
                                        ▼
                                  web/ 观战页面
```

它不修改游戏状态，也不参与规则判定；公开视角的过滤在服务端完成。

## 一回合是怎么发生的

1. `GameEngine.advance()` 自动播报/结算，直到需要某个玩家行动。
2. Runner 用 `makePlayerView()` 生成该玩家的可见视图：
   - 当前天数/阶段/存活座位
   - 私密信息（狼队友、查验记录、药剂、今晚刀口）
   - **自他上次行动以来**的可见事件增量
   - 本回合合法目标和行动提示
3. `PiPlayer` 把简报作为 user message 交给持久 agent；只挂载本阶段合法的工具。
4. Agent 调用 `say` / `vote` / `wolf_vote` / `sheriff_run` / `transfer_badge` / ...；工具闭包校验参数并写入 `TurnHandle.action`。
5. `shouldStopAfterTurn` 发现行动已提交，结束本轮 agent loop。
6. Runner 把 `Action` 交给 `GameEngine.submit()`；引擎校验、结算、追加事件，回到 1。

如果 agent 只输出文字、调用非法目标、模型超时或 provider 出错：

- 非法目标 → 工具返回拒绝原因，agent 可以重试；
- 暂时性模型错误 → 重试当前请求，最多三次，等待时间以 750ms 为基数指数增长并加随机扰动，等待与请求共用回合超时；重试记录是 `model_retry`；
- 只输出文字 → 法官发一次纠正提示；
- 仍不行动 / 超时 → 使用该回合的合法保底动作（弃票、空刀、不用药、放弃开枪等）；
- fatal（鉴权/模型不支持）或连续失败 → 中止并留下完整证据。

## 策略提示词

玩家先区分法官事实、角色私密信息和其他玩家的声称，再比较两种局势解释、归票可行性和失手后的胜负。简报给出有票座位、加权票数、最近两轮票型和公开事件，`view_log` 支持按天数或座位查证。

角色策略按当前目标选动作：预言家优先验能改变归票的活人，女巫区分被刀和好人，警长按本方收益交徽，狼队给主刀口、备用目标、分工和调整条件。发言应引用具体座位和证据，说明什么新信息会改变选择。策略质量评估与流程验证分开记录。

## 为什么这样设计

- **法官驱动而非 agent 自主轮询**：流程确定、不会死锁、事件可回放；agent 只负责主观选择。
- **每阶段只暴露合法工具**：从接口层减少“夜晚投票”“死人发言”等违规；同时让规则更容易被模型理解。
- **每个玩家独立上下文**：天然信息隔离；不会把查验结果/狼队频道发给错误玩家。
- **完整规则进 system prompt**：规则正确性优先；system prompt 稳定，便于 provider prompt cache。
- **所有异常留痕**：`events.ndjson` + 每个座位的 `transcript` + `summary.json`，失败可定位到层。

## 输出

每局写到 `runs/<gameId>/`：

```
events.ndjson          # 权威事件流（public/seat/wolves/judge 四种可见性）
summary.json           # 胜者、天数、身份、死亡、异常、token 用量
transcripts/
  seat-1.jsonl         # 该玩家的 system prompt + 每轮简报 + 工具调用/结果
  ...
```

常用命令：

```bash
# 浏览器实时观战 / 回放
npm run serve
npm run serve -- --god

# 人类可读回放
npm run replay -- runs/<gameId>

# 看私密信息和身份
npm run replay -- runs/<gameId> --show-private --show-roles

# 查异常
jq -c 'select(.type=="model_retry" or .type=="agent_error" or .type=="default_action" or .type=="action_rejected")' \
  runs/<gameId>/events.ndjson

# 看某个玩家为什么这么发言
cat runs/<gameId>/transcripts/seat-3.jsonl
```

## CLI

```bash
node src/cli/play.ts [选项]
  --seed <string>        随机种子
  --game-id <string>     对局 ID
  --out <dir>            输出目录（默认 runs/<gameId>）
  --mode <9p|12p>        板子（默认 9p；12p 含上警与白痴）
  --scripted             无 LLM 随机策略
  --model <provider/id>  玩家模型；多个用逗号分隔，按座位轮流
  --models <list>        同 --model，可逗号分隔
  --thinking <level>     minimal|low|medium|high|xhigh|max（默认 low）
  --max-tokens <n>       单次模型输出上限
  --max-days <n>         最大天数
  --timeout <seconds>    单回合超时
  --show-private         打印私密/狼队事件
  --verbose              打印工具调用与流程
  --quiet                只打印摘要
  --stream               逐段打印发言草稿（狼队草稿还需 --show-private）

node src/cli/replay.ts <run目录|events.ndjson> [--show-private] [--show-roles] [--verbose]
node src/cli/serve.ts [--god] [--board 9p|12p] [--port 7331] [--host 127.0.0.1] [--open]
node src/cli/doctor.ts [--live] [--model ...]
node src/cli/smoke.ts [--model ...]
```

## 模型

- 通过 pi `ModelRuntime` 读取 `~/.pi/agent/auth.json`（OAuth/API key），并按环境配置注册模型网关。显式指定 `--model` 优先。
- Command Code 使用 OpenAI Chat Completions（`https://api.commandcode.ai/provider/v1/chat/completions`）。设置 `COMMANDCODE_API_KEY` 后可用 `commandcode/deepseek/deepseek-v4.1-flash` 和 `commandcode/minimax/minimax-m3.1-flash`。
- Paratera 配置：复制 `.env.example` 为 `.env`，填入 `PARATERA_API_KEY`。内置两个模型：
  - `paratera/DeepSeek-V4.1-Flash-1017`
  - `paratera/MiniMax-M3.1-Flash`
- `--model a,b` 或 `--models "a,b"` 会按座位轮流分配：1 号用第一个模型、2 号用第二个、3 号回到第一个，依此类推。浏览器开新局时，检测到两个模型会出现“双模型交替”选项。
- 两个 Paratera 模型都已通过真实 smoke：`say` / `view_state` 工具调用正常，`reasoning_effort=high` 可用；MiniMax 首轮响应明显更慢，建议单回合超时不低于 240 秒。
- `npm run doctor` 列出已配置鉴权的模型。
- 真实一局大约 50-80 次模型调用（12 人局更多），每次输入约 1.5-5k tokens。注意成本与耗时。
- 想看到更多谋略，建议用 `--thinking medium` 或 `high`，并在 12 人局使用支持较强推理的模型；策略手册已内置在 system prompt，也可通过 `view_strategy` 工具随时查看。

## 目录

```
src/engine/   纯规则与状态机
src/judge/    驱动、简报、记录、保底动作
src/agents/   pi 玩家、工具、规则、模型、scripted
src/server/   观战 HTTP/SSE 服务
src/cli/      play / replay / serve / doctor / smoke
web/          无构建步骤的观战前端（HTML/CSS/JS）
test/         规则 / 全流程 / pi loop / runner / 观战服务
docs/         架构、规则、验证回路、取证表
runs/         运行产物（gitignored）
```

## 已知限制

- 12 人局使用预女猎白 + 上警；警长能力目前是 1.5 票 + 死亡移交警徽，未实现警长决定发言顺序/警徽流自动执行。
- 未实现守卫、白狼王、狼美人、PK 二次投票、自爆等扩展规则。
- 回合串行执行；没有并行夜间行动。
- 未实现长上下文压缩；12 人局通常仍在 128k 内。
- 机器只判定规则/流程，不判定发言质量；策略提升依赖提示词、模型和 thinking level。
- 观战服务没有登录/鉴权，默认只监听 `127.0.0.1`；`--god` 会暴露身份和私密信息，不要直接暴露到公网。
- transcript 含私密信息，仅用于本地调试。

## 后续

- 守卫/白狼王等扩展角色，以及警长决定发言顺序、PK 二次投票
- 更强的策略评估：发言质量评分、阵营胜率统计、多模型对照
- 更丰富的观战 UI（图表、对局对比、导出）
- 真人玩家接入同一 `PlayerPolicy` 接口
