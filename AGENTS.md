# AGENTS.md

AI 狼人杀：确定性法官 + 9/12 个 pi agent loop 驱动的玩家；12 人局含上警、警长与白痴。

## 快速命令

```bash
npm install

# 完整验证：typecheck + 自动化测试（含 9/12 人随机全流程、流式重试和观战）+ 两局 scripted CLI 对局
npm run verify

# 无 LLM 的完整对局（不需要模型鉴权）
npm run play -- --scripted --seed demo
npm run play -- --mode 12p --scripted --seed demo-12p

# 真实模型对局
npm run play -- --model openai-codex/gpt-5.6-luna --seed live-1 --stream
npm run play -- --mode 12p --model openai-codex/gpt-5.6-luna --seed live-12p --thinking medium

# Paratera 双模型（奇数座位 DeepSeek，偶数座位 MiniMax）
npm run play -- --mode 12p   --models "paratera/DeepSeek-V4.1-Flash-1017,paratera/MiniMax-M3.1-Flash"   --thinking high --seed dual-12p

# 浏览器观战（公开视角；--god 开启上帝视角）
npm run serve
npm run serve -- --god --open
npm run serve -- --god --board 12p --open
npm run serve -- --god --board 12p \
  --model "paratera/DeepSeek-V4.1-Flash-1017,paratera/MiniMax-M3.1-Flash" \
  --thinking high --open

# 一次真实模型最小回合（验证 auth / agent loop / 工具）
npm run smoke:llm -- --model openai-codex/gpt-5.6-luna
npm run smoke:llm -- --model paratera/DeepSeek-V4.1-Flash-1017 --thinking high
npm run smoke:llm -- --model paratera/MiniMax-M3.1-Flash --thinking high

# 查看 pi 可用模型 / 真实模型 live 检查
npm run doctor
npm run doctor -- --live --model openai-codex/gpt-5.6-luna

# 回放
npm run replay -- runs/<gameId> --show-private --show-roles
```

## 项目结构

| 路径 | 作用 |
|---|---|
| `src/engine/types.ts` | 领域类型、事件、可见性、`RulesConfig` |
| `src/engine/engine.ts` | **唯一状态源**：`GameEngine.advance()/submit()`、阶段任务队列、结算、胜负 |
| `src/engine/rng.ts` | seeded RNG |
| `src/judge/driver.ts` | `advance → view → policy → submit` 驱动循环、超时/降级 |
| `src/judge/runner.ts` | 一局运行时、事件/摘要/transcript 落盘 |
| `src/judge/brief.ts` | 每回合法官简报（只含该玩家可见信息） |
| `src/judge/defaults.ts` | 合法保底动作 |
| `src/agents/pi-player.ts` | 一个玩家 = 一个持久 pi `Agent` |
| `src/agents/model-stream.ts` | 请求级流式传递与可取消的指数退避 |
| `src/agents/tools.ts` | 本回合合法工具、参数校验、`TurnHandle` |
| `src/agents/rules.ts` | 9/12 人完整规则、角色策略手册、system prompt、纠正提示 |
| `src/agents/model.ts` | pi `ModelRuntime` 鉴权 + Paratera provider 注册 + 单/多模型加载 |
| `src/agents/model-routing.ts` | 模型列表解析、双模型座位交替、组合与分配摘要（纯函数） |
| `src/agents/scripted.ts` | 无 LLM 随机策略（含上警/警徽） |
| `src/server/spectator-server.ts` | 观战 HTTP/SSE 服务、对局列表、新对局 API、public/god 过滤 |
| `web/{index.html,styles.css,app.js}` | 无构建步骤的观战前端（座位、赛况、纪事、回放、上帝情报） |
| `src/cli/*.ts` | play / replay / serve / doctor / smoke |
| `test/*.test.ts` | 规则、全流程、pi loop、runner、观战服务 |
| `runs/<gameId>/` | 事件日志、摘要、每个座位的上下文（gitignored） |

## 不可破坏的约束

1. **法官是唯一状态源。** 玩家 agent 不能直接改 `GameState`；只能返回 `Action`，由 `GameEngine.submit()` 校验并结算。
2. **事件可见性即信息隔离。** 不要把 judge 事件、别人的 `seat` 事件发给玩家。简报只通过 `makePlayerView()` + `buildBrief()` 生成。
3. **每个回合都要能终止。** 新回合类型必须：
   - 有 terminal tool（写入 `TurnHandle.action`）；
   - 有 `defaultActionFor()` 的合法保底动作；
   - 在 `buildTurn()` 里给出 `legalTargets` 和 `promptHint`。
4. **规则只有一份实现。** 改规则改 `GameEngine` + `RULES_TEXT_9P` / `RULES_TEXT_12P` + `docs/rules/{9p,12p}.md`，并补测试。不要在 prompt 里写一套、引擎里写另一套。
5. **夜间死亡没有遗言。** `resolveNight()` 不得为夜晚死者排队 `last_words`；只有被放逐者和被猎人带走的玩家留遗言。警长夜间死亡仍要处理警徽移交。
6. **新回合类型必须齐全。** 上警/警长相关回合同样要有 terminal tool、`defaultActionFor()` 保底、`legalTargets`、`promptHint` 和测试。
7. **不要把 agent 的自由文本当行动。** 只有 tool call 生效；不要从 assistant 文本解析动作。
8. **不要给玩家 bash/read/write 等通用工具。** 玩家只应有游戏工具 + `view_*` 信息工具。
9. **公开视角必须在服务端过滤。** `view=public` 只发 `visibility.kind==="public"` 的事件；`seat`/`wolves`/`judge` 只能通过 `--god` 暴露。不要在前端“先发全部再隐藏”。
10. **观战服务只读事件流。** 不要暴露 `transcripts/`、`summary.json` 之外的私密文件；不要允许路径穿越。观战是只读消费者，不能改游戏状态。
11. **狼队战术计划只对狼队可见。** `wolf_plan` 事件必须是 `wolves` 可见性；公开 SSE 不得出现。计划是私有讨论，不是公开事件。
12. **不要把密钥写进仓库。** 模型 API key 只放在 gitignored 的 `.env` 或 shell 环境变量；提交前检查 `git status` 不应出现 `.env` 或 `runs/`。
13. **发言草稿不参与结算。** 只预览本回合匹配的发言工具参数。普通 assistant 文本、推理、私密工具结果均不得转发；狼队草稿仅 `--god` 可见。草稿不进入玩家简报或事件日志。

## 验证回路（六槽位）

- **触发**：`npm run verify`；`npm run play -- --mode 9p|12p --scripted --seed <seed>`；`npm run serve`；`npm run smoke:llm`。
- **观测**：`runs/<gameId>/events.ndjson`（结构化事件）、`summary.json`、`transcripts/seat-*.jsonl`；浏览器观战页与 `/api/games`。
- **判定**：`npm run verify` 退出码；测试断言事件 seq 连续、恰好一个 `game_end`、无 `action_rejected`、角色数正确、9 人 30 个种子 + 12 人 20 个种子全部有胜者、12 人恰好一次警长竞选、夜间死亡无遗言；观战服务测试断言 public SSE 不含私密事件、god SSE 含身份/狼队/查验事件、12 人公开 SSE 含上警/警长事件。
- **归因**：事件有 `phase/type/visibility/actor/target`；规则错误有 `RuleError.code`；模型重试落 `model_retry`，最终失败落 `agent_error` / `default_action`。
- **取证**：见 `docs/agent/evidence-map.md`。
- **登记**：本文件 + `docs/agent/verification-loop.md`。

## 常见排查

```bash
# 最后一局的事件
ls -t runs | head -1

# 谁赢了、为什么结束、有没有异常
cat runs/<gameId>/summary.json

# 所有 agent 错误 / 保底动作 / 规则拒绝
jq -c 'select(.type=="agent_error" or .type=="default_action" or .type=="action_rejected")' \
  runs/<gameId>/events.ndjson

# 最后一个流程节点
jq -c 'select(.type=="turn_start") | .data' runs/<gameId>/events.ndjson | tail -1

# 某个玩家的完整上下文
cat runs/<gameId>/transcripts/seat-3.jsonl

# 观战服务
npm run serve -- --god
# 公开 SSE（应只有 public）
curl -N 'http://127.0.0.1:7331/api/games/<gameId>/events?view=public' | head
# 配置与对局列表
curl -s http://127.0.0.1:7331/api/config
curl -s http://127.0.0.1:7331/api/games
```

观战服务没有鉴权，默认只绑定 `127.0.0.1`；不要把 `--host 0.0.0.0` 和 `--god` 一起暴露到公网。

## 模型说明

- 复用 pi 的 `~/.pi/agent/auth.json`（OAuth/API key）与 `ModelRuntime`。
- 默认 thinking level 为 `low`；可用 `--thinking` 调整。Paratera 两个模型实测 `high` 可用。
- 若模型返回 `model ... is not supported`，换一个账号可用的模型：
  `--model openai-codex/gpt-5.6-luna`（本机已验证）或运行 `npm run doctor` 查看列表。
- Paratera 网关通过 `.env` 的 `PARATERA_API_KEY` 注册；内置 `paratera/DeepSeek-V4.1-Flash-1017` 与 `paratera/MiniMax-M3.1-Flash`。
- Command Code 网关使用 `COMMANDCODE_API_KEY`；配置后，CLI 和观战页默认使用 `commandcode/deepseek/deepseek-v4.1-flash`，也可选择 `commandcode/minimax/minimax-m3.1-flash`。显式模型选项优先。
- `--model a,b` / `--models "a,b"` 会把模型按座位交替分配；浏览器 `/api/config` 会额外返回 `modelSets`，网关的两个模型均可用时提供“双模型交替”选项。
- 一次真实回合约 1.5-2k 输入 tokens；完整 9 人局大约 50-80 次调用，12 人局更多。注意成本/时间。
- 策略表现不足时，优先试 `--thinking medium`，再换更强的可用模型；用 `view_strategy`/transcript 检查模型是否真的执行了策略。
- 12 人 medium 实测：`runs/strategy-12p`，5 天/309 事件/731s/117 万 total tokens，出现警徽流、票型复盘和狼队带队；有一次 300s 超时保底。详见 `docs/agent/strategy-eval.md`。

## 测试约定

- `test/engine.test.ts`：9 人规则单测，使用固定身份 `werewolf×3, villager×3, seer, witch, hunter`；含狼队战术计划的首夜/可见性/跨夜更新。
- `test/modes.test.ts`：12 人上警、警长 1.5 票、警徽移交、白痴翻牌、夜间无遗言、猎人开枪遗言。
- `test/full-game.test.ts`：30 个 9 人 seed + 20 个 12 人 seed 的随机全流程；测试是判定缺口，不是演示。
- `test/pi-player.test.ts`：用 `test/fake-llm.ts` 的 fake stream 走真实 pi agent loop，不花 token；覆盖 `set_wolf_plan` / `sheriff_run` / `sheriff_say` / `sheriff_vote` / `transfer_badge`。
- `test/model-routing.test.ts`：模型列表解析、双模型按座位交替、双模型组合生成、分配摘要。
- `test/model-stream.test.ts`：退避上限、永久模型错误、服务端等待指令、回合取消。
- `test/server.test.ts`：观战服务、9/12 人对局、模型 Logo、SSE public/god 草稿和事件分流、路径穿越防护。
- 新功能至少补一条“改坏会红”的断言。
