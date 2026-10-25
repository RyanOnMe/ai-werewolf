# 模板

直接复制改写。所有路径按项目实际调整，不要照搬命名。

---

## 1. 入口文件（AGENTS.md）

```markdown
# <项目名> — Agent 入口

## 怎么跑

| 场景 | 命令 |
|---|---|
| 安装依赖 | `<cmd>` |
| 启动服务 | `<cmd>` |
| 跑全部检查 | `<cmd>` |
| 只跑某条验证 | `<cmd>` |

## 工作方式

- <默认在哪个分支/目录工作>
- <并行时的约束>
- <提交/发布的规矩>

## 验证

| 用户路径 | 怎么验 | 成功判据 | 证据位置 |
|---|---|---|---|
| <路径描述> | `<command>` | <可检查的结果> | <文件/命令> |

## 证据

| 现象 | 去哪看 |
|---|---|
| <现象> | <日志/表/命令> |

## 禁区

- <绝对不要做的事，附原因>

## 索引

- 回路说明：`docs/agent/verification-loop.md`
- 验收文档：`docs/agent/acceptance/`
- 审计：`scripts/harness_audit.py`
```

要点：入口文件只放索引和硬约束，细节链出去。

---

## 2. 回路说明（docs/agent/verification-loop.md）

```markdown
# 验证回路：<路径名>

## 验的是什么

用户路径：<从哪个动作开始，到哪个结果结束>。
不覆盖：<明确列出不在范围内的部分>。

## 六个槽位

| 槽位 | 实现 | 位置 |
|---|---|---|
| 触发 | <命令/脚本> | `<path>` |
| 观测 | <事件前缀> | `<path>` |
| 判定 | <检查命令> | `<path>` |
| 归因 | <层枚举> | `<path>` |
| 取证 | <命令> | `<path>` |
| 登记 | <入口文件章节> | `AGENTS.md` |

## 事件序列

```
<event.a> → <event.b> → <event.c>
```

## 成功判据

1. <终态断言>
2. <必需事件齐全>
3. <不得出现的事件>

缺任一证据即失败。

## 已知边界

- <没验到的场景与原因>
```

---

## 3. 验收文档（docs/agent/acceptance/<feature>.md）

```markdown
# 验收：<功能名>

- 日期：<YYYY-MM-DD>
- 关联 issue：<链接>
- 结论：通过 / 不通过

## 覆盖的路径

<用户路径描述>

## 复跑步骤

```bash
<完整命令>
```

## 期望结果

<可观察的终态 + 事件序列>

## 实际结果

<粘贴关键输出，不要只写"正常">

## 证据

- 事件：<路径或 session_id>
- 日志：<路径>
- 数据：<查询>

## 未覆盖

- <边界 1：原因>
- <边界 2：原因>

## 下次注意

<坑、环境差异、容易误判的地方>
```

**没有"实际结果"的验收文档视为未验收。**

---

## 4. 证据映射（docs/agent/evidence-map.md）

```markdown
# 证据映射

| 层 | 现象 | 位置 | 关键字段 |
|---|---|---|---|
| transport | 请求失败 | `<日志路径>` | `trace_id`, status |
| domain | 业务拒绝 | `<日志路径>` | `error.code` |
| storage | 数据不一致 | `<表名>` | 主键, `updated_at` |
| job | 异步未完成 | `<队列/日志>` | job id, retry |

## 一键取证

```bash
scripts/evidence.sh <session_id>
```

输出包含：<列出聚合项>
```

---

## 5. 判定脚本骨架（Python，标准库）

```python
#!/usr/bin/env python3
"""<路径名> 的判定。退出码 0=通过，1=失败。"""
import json
import sys

REQUIRED = ["transport.request.start", "domain.save.ok", "storage.write"]
FORBIDDEN = ["domain.save.error"]

def load_events(path):
    events = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                # 解析失败按证据缺失处理，不要静默跳过
                print(f"FAIL: 无法解析事件行: {line[:80]}")
                sys.exit(1)
    return events

def main():
    events = load_events(sys.argv[1])
    actions = [e.get("action") for e in events]

    missing = [a for a in REQUIRED if a not in actions]
    if missing:
        print(f"FAIL: 缺少必需事件 {missing}")
        return 1

    hit = [a for a in FORBIDDEN if a in actions]
    if hit:
        print(f"FAIL: 出现禁止事件 {hit}")
        return 1

    # 顺序检查
    idx = [actions.index(a) for a in REQUIRED]
    if idx != sorted(idx):
        print("FAIL: 事件顺序不正确")
        return 1

    print("PASS")
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

要点：解析失败 = 失败；缺证据 = 失败；不吞异常。

---

## 6. 事件发射片段

```python
import json, os, time, uuid

SESSION = os.environ.get("HARNESS_SESSION", str(uuid.uuid4()))

def emit(layer, action, result="ok", target=None, actor="agent", error=None, **extra):
    if os.environ.get("ENV") == "production":
        return  # 副作用探针只在非生产启用
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
        "session_id": SESSION,
        "layer": layer,
        "actor": actor,
        "action": action,
        "target": target,
        "result": result,
        "error": error,
    }
    record.update(extra)
    with open("<事件文件>", "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
```

---

## 7. 规则片段

```markdown
## 改动前

- 先确认这次改动属于哪条用户路径；不属于任何已有路径时，先补一条验收再改。
  原因：没有判据的改动无法证明正确，只会在下个会话返工。

- 不要为验证另开测试专用通道。
  原因：旁路会与真实路径漂移，绿的是假路。
```

每条规则：约束 + 原因。能写成检查的，不要写成规则。
