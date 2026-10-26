# 现象 → 证据对照表

所有路径相对于仓库根目录；`<gameId>` 来自命令行或 `ls -t runs | head -1`。

| 现象 | 先看什么 | 关键字段/命令 |
|---|---|---|
| 游戏没有结束 / 卡住 | `summary.json`、最后一条 `turn_start` | `jq -c 'select(.type=="turn_start") \| .data' runs/<gameId>/events.ndjson \| tail -1` |
| 某玩家没行动 | `agent_error` / `default_action` 事件、该座位 transcript | `jq -c 'select(.type=="agent_error" or .type=="default_action")' runs/<gameId>/events.ndjson` |
| 模型鉴权/模型不支持 | `summary.error`、`npm run doctor` | `jq -r .error runs/<gameId>/summary.json` |
| 非法动作 | `action_rejected` 事件、工具拒绝文本 | `jq -c 'select(.type=="action_rejected") \| .data' runs/<gameId>/events.ndjson` |
| 行动顺序/阶段不对 | 事件 `phase`、`turn_start` 序列 | `jq -c 'select(.type=="turn_start") \| {seq,day,phase:.phase,data}' runs/<gameId>/events.ndjson` |
| 死亡/胜负不对 | `summary.json` 的 `winner/endReason/deaths`、`game_end` 事件 | `jq -c 'select(.type=="game_end") \| .data' runs/<gameId>/events.ndjson` |
| 夜晚死因/解药/毒药 | `death` 的 judge 事件（含 causes）、女巫 transcript | `jq -c 'select(.type=="death" and .visibility.kind=="judge")' runs/<gameId>/events.ndjson` |
| 夜间死者为什么有/没有遗言 | `last_words` 事件与 `death.phase` | 夜晚死亡应为 0 条遗言；`jq -c 'select(.type=="last_words")' runs/<gameId>/events.ndjson` |
| 上警/警长流程不对 | `sheriff_signup`、`sheriff_speech`、`sheriff_vote`、`sheriff_elected`、`turn_start` | `jq -c 'select(.type\|startswith("sheriff"))' runs/<gameId>/events.ndjson` |
| 警长票权不对 | `vote_record.data.tally`、`sheriff` | `jq -c 'select(.type=="vote_record") \| .data' runs/<gameId>/events.ndjson` |
| 警徽移交/销毁 | `badge_transfer` 事件、`sheriff` 状态 | `jq -c 'select(.type=="badge_transfer")' runs/<gameId>/events.ndjson` |
| 白痴翻牌/无投票权 | `idiot_revealed`、`vote_record.data.idiotRevealed`、transcript | `jq -c 'select(.type=="idiot_revealed" or (.type=="vote_record" and .data.idiotRevealed))' runs/<gameId>/events.ndjson` |
| 猎人为什么没开枪 | 猎人死因、`hunter_shot` 事件 | `jq -c 'select(.actor==9 and .type=="death")' runs/<gameId>/events.ndjson`（座位换成实际猎人） |
| 信息疑似泄漏 | 事件 `visibility`、该玩家 brief/transcript | `jq -c 'select(.visibility.kind!="public")' runs/<gameId>/events.ndjson` |
| 某个 agent 为什么这么发言 | 该座位完整上下文 | `cat runs/<gameId>/transcripts/seat-3.jsonl` |
| 想快速看整局 | replay | `npm run replay -- runs/<gameId> --show-private --show-roles` |
| 观战页空白/一直“连接中” | 对局状态、SSE、服务端日志 | `curl -s http://127.0.0.1:7331/api/games`；`curl -N 'http://127.0.0.1:7331/api/games/<id>/events?view=public'` |
| 上帝视角按钮不见 / 403 | 服务是否 `--god` | 重启 `npm run serve -- --god`；`curl -s /api/config` 看 `godEnabled` |
| 浏览器里开始对局失败 | POST 响应、服务端日志、模型 auth | `curl -s -X POST -H 'content-type: application/json' -d '{"mode":"scripted","board":"12p","seed":"demo"}' http://127.0.0.1:7331/api/games` |
| 页面样式错乱/静态资源 404 | `web/` 文件、静态路径 | `curl -I http://127.0.0.1:7331/styles.css`；检查 `staticDir` |
| 端口被占用 | serve 启动错误 | 换 `--port`，或结束占用进程 |
| 观战页角色/存活状态不对 | 事件流是否完整、是否选错视角 | 对比 `events.ndjson` 的 `role_assigned`/`death`/`vote_record`；god 与 public 的事件数不同是正常的 |
| 新对局启动后 SSE 404 | 事件文件是否已创建 | 服务端 `startGame` 会等待 `events.ndjson`；若仍 404，看 `runs/<id>/` 和 summary.error |
| 测试是否真的会红 | 故意改坏一条规则再跑 | 例如把 `computeWinner()` 改成 `return null`，`npm test` 应失败，然后恢复 |

## transcript 里有什么

`transcripts/seat-N.jsonl` 每行一个 JSON：

1. `{"role":"system","content":"..."}`：该玩家的 system prompt（身份 + 本局完整规则 + 角色策略手册 + 行为准则）。
2. `{"role":"user","content":"[法官] 第N天..."}`：每回合简报，含公开自称/查杀/金水摘要、最近投票、警长状态、决策检查清单。
3. `{"role":"assistant","content":[...] }`：模型自由文本、thinking、tool call。
4. `{"role":"toolResult","toolName":"say","content":[...]}`：工具结果（包括“行动被拒绝”）。
5. 纠正提示也是 user 消息。

这些文件包含私密信息（身份、查验、狼队频道），仅用于本地排查，不要外传。
