# 验证回路

## 验的是哪条用户路径

**一条完整的 9 人局：发身份 → 第一夜 → 天亮 → 白天发言 → 投票 → 放逐 → 下一夜 → 直到 `game_end`。**

起点：`node src/cli/play.ts`（或 `runGame()`）。
终点：`summary.json` 中 `winner` 非空、`phase === "ended"`、`events.ndjson` 最后一条是 `game_end`。

另外三条辅助路径：

- **pi agent loop**：`test/pi-player.test.ts` 用 fake stream 驱动真实 `Agent` + 真实工具 schema，验证“模型调用工具 → 工具校验 → Action → 终止”。
- **真实模型**：`npm run smoke:llm`，一次真实模型回合，验证 auth、provider、工具调用。
- **观战前端**：`npm run serve` → 页面加载 → `/api/games` → SSE `events?view=public`；`--god` 时验证上帝视角包含身份/狼队/查验事件。`test/server.test.ts` 覆盖静态页、配置、脚本对局、SSE 过滤、403/404/路径穿越。真实模型从浏览器启动也做过一次手工验证（`runs/web-web-live-demo-*`）。

## 六槽位

### 1. 触发（执行器）

```bash
npm run verify                                  # 一键：typecheck + 测试 + scripted CLI 对局
npm run play -- --scripted --seed verify-1      # 单局，无 LLM
npm run play -- --model <model> --seed live-1   # 单局，真实模型
npm run smoke:llm -- --model <model>            # 最小真实模型回合
npm run serve                                   # 观战前端（公开视角）
npm run serve -- --god                          # 观战前端（上帝视角）
```

`npm run verify` 走的是和真人操作同一个 CLI / runner / engine 路径，没有测试专用旁路。

### 2. 观测（传感器）

- `runs/<gameId>/events.ndjson`：一行一个结构化事件。
  - 字段：`seq, ts, gameId, day, phase, type, visibility, actor, target, text, data`。
  - `visibility`：`public | seat | wolves | judge`。
- `runs/<gameId>/transcripts/seat-N.jsonl`：该玩家完整 system prompt、每轮简报、assistant 输出、tool result。
- `runs/<gameId>/summary.json`：胜者、天数、身份、死亡、异常计数、每座位 token 用量、是否中止。
- 观战 API：`GET /api/config`、`GET /api/games`、`GET /api/games/:id/events?view=public|god`（SSE）。

### 3. 判定（比较器）

`npm run verify` 的退出码 + 测试断言：

- `test/engine.test.ts`
  - 角色数量、身份不进入公共视野。
  - 解药救人 → 平安夜；狼刀 + 毒药 → 两人死亡且公开日志不泄漏死因。
  - 猎人被狼刀可开枪、被毒杀不能开枪。
  - 投票平票 → 无人放逐。
  - 女巫不能同晚双药；预言家不能验自己。
  - 胜负优先级：狼人全灭优先于同归于尽。
- `test/full-game.test.ts`（30 seeds）
  - 每局 `phase === "ended"` 且 `winner !== null`。
  - 事件 seq 从 1 连续递增。
  - 恰好一个 `game_end`，且是最后一条事件。
  - 无 `action_rejected`（随机策略产生的动作全部合法）。
  - `game_end.data.roles` 与最终状态一致。
- `test/pi-player.test.ts`
  - 工具接受后 agent loop 终止；非法目标被拒绝后可重试。
  - 只输出文字 → 收到纠正提示；仍不行动 → `PiPlayerError`。
  - 重复行动被 `beforeToolCall` 阻止。
  - 不同回合只暴露合法工具；fatal 模型错误被标记。
- `test/server.test.ts`
  - 静态页/配置可用；脚本对局能通过 `POST /api/games` 启动并结束。
  - public SSE 只含 `public` 事件，不含 `role_assigned`；god SSE 含身份、狼队、查验事件。
  - 非 `--god` 服务对 god 请求返回 403；不存在/路径穿越返回 404/400。
- CLI 对局（`scripts/verify.sh`）
  - `summary.json` 胜者非空、规则拒绝为 0、事件数 > 40。

### 4. 归因（层与来源）

| 层 | 证据 |
|---|---|
| 模型/agent | `agent_error`、`default_action`、`transcripts/seat-N.jsonl`、`PiPlayerError.fatal` |
| 工具/参数 | 工具返回“行动被拒绝”、`action_rejected.data.code` |
| 规则/结算 | `RuleError.code`、`death`（judge 事件含 causes）、`game_end` |
| 流程/编排 | 最后一条 `turn_start`、`summary.phase`、`eventCount` |
| 信息隔离 | `visibility` 字段 + `test/engine.test.ts` 可见性断言 + `test/server.test.ts` 的 public/god SSE 断言 |
| 观战服务 | `/api/games` 状态、SSE 事件、服务端日志、`web/` 静态文件；403/404 边界 |

### 5. 取证（现象 → 证据）

见 `docs/agent/evidence-map.md`。

### 6. 登记（复用）

- 本文件 + `AGENTS.md` + `README.md`。
- 新增回合类型/规则时，同步更新三处：`GameEngine`、`RULES_TEXT`、测试。

## 可证伪性

以下改动会让判定变红（已实际验证过至少一条）：

- `computeWinner()` 永远返回 `null` → `full-game.test.ts` 失败。
- `isVisibleTo()` 对 `judge` 返回 `true` → 可见性测试失败。
- 去掉解药判断 → 女巫救人测试失败。
- 删除 `defaultActionFor()` 的某个分支 → 对应 pi-player/CLI 路径失败。

## 没有验的边界

- 真实模型在长上下文（>50k tokens）下的稳定性；v1 未做压缩。
- 多进程并发对局（runner 每次一局，输出目录独立）。
- 12 人板子/警长/守卫（未实现）。
- 网络抖动下的 provider 重试细节（依赖 pi agent-core 的重试；超时后使用保底动作）。
- 观战页的视觉效果没有自动化 gate；用 Playwright 手工截图检查过桌面宽度，移动端只做了 CSS 断点。
- 观战服务没有鉴权，默认只绑定 `127.0.0.1`；公网部署不在验证范围。
- 模型发言的“质量”（逻辑好坏）不是机器判定项；只判定规则与流程。
