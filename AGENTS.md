# AGENTS.md

AI 狼人杀：确定性法官 + 9 个 pi agent loop 驱动的玩家。

## 快速命令

```bash
npm install

# 完整验证：typecheck + 20 个测试（含 30 局随机全流程 + 观战服务）+ 一局 scripted CLI 对局
npm run verify

# 无 LLM 的完整对局（不需要模型鉴权）
npm run play -- --scripted --seed demo

# 真实模型对局
npm run play -- --model openai-codex/gpt-5.6-luna --seed live-1 --verbose

# 浏览器观战（公开视角；--god 开启上帝视角）
npm run serve
npm run serve -- --god --open

# 一次真实模型最小回合（验证 auth / agent loop / 工具）
npm run smoke:llm -- --model openai-codex/gpt-5.6-luna

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
| `src/agents/tools.ts` | 本回合合法工具、参数校验、`TurnHandle` |
| `src/agents/rules.ts` | 完整规则、system prompt、纠正提示 |
| `src/agents/model.ts` | pi `ModelRuntime` 鉴权 + 模型选择 |
| `src/agents/scripted.ts` | 无 LLM 随机策略 |
| `src/server/spectator-server.ts` | 观战 HTTP/SSE 服务、对局列表、新对局 API、public/god 过滤 |
| `web/{index.html,styles.css,app.js}` | 无构建步骤的观战前端（圆桌、时间线、回放、上帝面板） |
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
4. **规则只有一份实现。** 改规则改 `GameEngine` + `RULES_TEXT` + `docs/rules/9p.md`，并补测试。不要在 prompt 里写一套、引擎里写另一套。
5. **不要把 agent 的自由文本当行动。** 只有 tool call 生效；不要从 assistant 文本解析动作。
6. **不要给玩家 bash/read/write 等通用工具。** 玩家只应有游戏工具 + `view_*` 信息工具。
7. **公开视角必须在服务端过滤。** `view=public` 只发 `visibility.kind==="public"` 的事件；`seat`/`wolves`/`judge` 只能通过 `--god` 暴露。不要在前端“先发全部再隐藏”。
8. **观战服务只读事件流。** 不要暴露 `transcripts/`、`summary.json` 之外的私密文件；不要允许路径穿越。观战是只读消费者，不能改游戏状态。

## 验证回路（六槽位）

- **触发**：`npm run verify`；`npm run play -- --scripted --seed <seed>`；`npm run serve`；`npm run smoke:llm`。
- **观测**：`runs/<gameId>/events.ndjson`（结构化事件）、`summary.json`、`transcripts/seat-*.jsonl`；浏览器观战页与 `/api/games`。
- **判定**：`npm run verify` 退出码；测试断言事件 seq 连续、恰好一个 `game_end`、无 `action_rejected`、角色数正确、30 个种子全部有胜者；观战服务测试断言 public SSE 不含私密事件、god SSE 含身份/狼队/查验事件。
- **归因**：事件有 `phase/type/visibility/actor/target`；规则错误有 `RuleError.code`；agent 异常落 `agent_error` / `default_action`。
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
- 默认 thinking level 为 `low`；可用 `--thinking` 调整。
- 若模型返回 `model ... is not supported`，换一个账号可用的模型：
  `--model openai-codex/gpt-5.6-luna`（本机已验证）或运行 `npm run doctor` 查看列表。
- 一次真实回合约 1.5-2k 输入 tokens；完整 9 人局大约 50-80 次调用。注意成本/时间。

## 测试约定

- `test/engine.test.ts`：规则单测，使用固定身份 `werewolf×3, villager×3, seer, witch, hunter`。
- `test/full-game.test.ts`：30 个 seed 的随机全流程；测试是判定缺口，不是演示。
- `test/pi-player.test.ts`：用 `test/fake-llm.ts` 的 fake stream 走真实 pi agent loop，不花 token。
- `test/server.test.ts`：观战服务 + 脚本对局 + SSE public/god 过滤 + 路径穿越防护。
- 新功能至少补一条“改坏会红”的断言。
