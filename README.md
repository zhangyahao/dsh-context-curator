# dsh-context-curator（上下文策展）

把 DeepSeek Harness 每轮模型请求里那些**冗长但偶尔才用得上**的提示词段，折叠成一行索引；
原文留在插件内存里，模型（或你）确实需要细节时再按名字取回。

## 它解决什么

Harness 的常驻上下文由三部分组成：

1. `.dsh` 里各插件注册的**系统提示词段**（团队协作协议、记忆指南、叙述规则……）——通常是大头；
2. **技能目录**（`<available_skills>`，每条约 500 字符）；
3. 工具 schema（本插件**不动**工具，工具必须一直在）。

第 1、2 项是「每轮都在付费、但多数轮次用不上」的典型。本插件把它们换成一行索引：

```
⟨ctx⟩ agent-teams｜4821 字符已折叠｜AgentTeams captain protocol …｜需要时 context_load("agent-teams")
```

需要协议细节时，模型调用 `context_load("agent-teams")` 取回全文，之后照原文执行。

## 机制（都是 Harness 自己的扩展点，不改任何别人的配置）

- `system-prompt/assemble`（global waterfall）：拿到装配好的 `assembly.sections`，把超阈值段的 `text` 换成一行索引，原文存进插件内存。返回什么，模型就看到什么。
- `agent/pre-step`（global waterfall）：`@deepseek-ai/dsh-tool-skill` 注入的 `source.kind === 'skill-catalog'` 消息，其描述被压成首句；`source.entries` 原样保留（那边的去重依赖 entries 摘要）。
- 所有回调都 `try/catch` 兜底：assembly 链路一旦抛错会让整个会话发不出请求，所以失败就原样放行。

技能目录的生效时机（已实测）：**新会话**首轮由 `dsh-tool-skill` 首次发布目录，本插件在最外层改写，模型看到的就是压缩版（实测首句为「本会话可用技能 N 个」）；**已经开着的会话**里那条目录早已作为历史消息落盘、之后不再重发，插件拿不到，因此改不动——想让某个老会话立刻变短，只能新开一个会话。

## 安装或更新插件之后

新装的插件、升级后的插件都会注册新的提示词段，这些段**下一次请求就会被自动折叠**（`enabled: true` 时无需任何操作）：折叠在每轮装配时按字符数实时计算，不依赖任何预先登记。技能目录同理——目录因装新 skill 而变化、`dsh-tool-skill` 重新发布时，那一版也会被压成首句。

装完想知道「到底多花了多少、有没有被折掉」，跑一次 `context_ledger`：新出现过的段会标 `[新]`，并单独列出本次运行新出现的段名。若某段是该插件必须每轮遵守的硬规则（而不是查资料时才用的说明），把它加进 `protect`，再 `context_load` 确认原文。

想把「先优化」做得更彻底，开 `foldNewSections: true`：装或更新插件后**新冒出来的段即使不到 `minChars` 也直接折叠**（老段仍按阈值走），这样新插件带来的说明不会先挤进一轮上下文再被处理。风险是个别插件注册的很短的状态段也会被折，遇到行为异常就把它加进 `protect`。

## 工具

| 工具 | 作用 |
| --- | --- |
| `context_ledger` | 逐段列出字符数、是否已折叠、建议折叠项（只读）。用来看清代价再开开关。 |
| `context_load` | 按段名取回全文。折叠行里 `⟨ctx⟩` 后面就是段名。 |
| `context_config` | 读/改开关与阈值，立即生效并持久化到 DSH 数据目录的 `data/context-curator.json`（即 `$DSH_HOME/data/context-curator.json`）。 |

## 建议的使用顺序

1. 装好（默认 `enabled: false`，只记账不改文本）；
2. 让模型或你自己跑 `context_ledger`，看哪几段最贵；
3. 把**不能折**的段加进 `protect`（例如它规定了工具调用格式、且不看就会违规的段）；
4. `context_config` 里 `enabled: true`，下一次请求立即生效；
5. 若发现某能力「行为退化」，先 `context_load` 该段确认原文，再决定是否 `protect`。

## 已知边界

- 折叠后模型**看不到**该段内容，只看到一行索引与首句。若某段是每步变化的动态信息（时间、状态），索引里的首句会跟着更新，但正文不会自动出现——需要时得 `context_load`。
- 原文存在**插件内存**里：Harness 重启或插件重载后，折叠前的原文要等下一次装配重新记录；这之前 `context_load` 可能取不到。折叠本身不受影响（每步都从实时 assembly 重新生成）。
- 不改工具 schema，因此不减少工具定义占用的上下文（那部分必须常驻，否则模型无法调用）。
- 技能目录只对**新会话**生效（见上）；老会话那一份已固化在历史里，`context_ledger` 的 `stats` 里 `catalogs` 会为 0，属正常。
- `context_ledger` 的 `stats` 里「最近一次装配节省」只统计**系统提示词段**，技能目录的节省单独记在 `catalogSavedNow`。
