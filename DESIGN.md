# Reflection 流 × 双链 MD 知识体系设计原则

> 基于 Reflection 流（经验归纳）的认知架构，以双链 Markdown（Obsidian/Roam/Logseq 风格）为知识组织形式，构建 Agent 长期记忆系统。

---

## 整体架构

```
执行循环中的 Agent
       │
       ▼
  ┌─────────────────────────────────────┐
  │         Observational Memory        │
  │   (原始交互日志，被动追加)          │
  │   /logs/2026-07-19-1420-session.md  │
  └──────────────┬──────────────────────┘
                 │ 触发条件（时间/事件/阈值）
                 ▼
  ┌─────────────────────────────────────┐
  │        Reflection Engine            │
  │   读取近期 logs → 生成反思笔记       │
  │   /reflections/2026-07-19.md        │
  │   内含 [[...]] 链接到源 logs        │
  └──────────────┬──────────────────────┘
                 │ 多次反思累积后
                 ▼
  ┌─────────────────────────────────────┐
  │        Insight / Rule / MOC         │
  │   /insights/用户对延迟敏感.md        │
  │   /moc/系统设计.md  ← 聚合节点      │
  └─────────────────────────────────────┘
```

每次 Agent 执行任务时，通过双链图谱找到相关记忆，注入 context。

---

## 一、知识的同一性（Identity & Uniqueness）

### 1.1 唯一真源原则 (Single Source of Truth)

任何一个实体、概念、人或事实，在图中必须有且仅有一个权威节点。

**违反场景**：Agent 在不同时间独立创建了 `[[用户偏好简单]]` 和 `[[用户讨厌复杂基础设施]]`——它们本质是同一个 insight，但在图中是两个节点，链接断开。

### 1.2 去重义务原则

创建新节点之前，系统有义务检查是否已存在表达相同语义的节点。不要求完美去重，但必须有明确的去重门槛和冲突升级机制：

- **高相似度**（语义搜索命中）→ 不应创建新节点，应编辑/追加已有节点
- **中等相似度** → 创建新节点但强制建立 [[双向链接]]
- **低相似度** → 自由创建

### 1.3 节点退化原则

当一个节点只有一个入链和一个出链时，它应该被质疑是否具有独立存在的必要性。

```markdown
[[A]] → [[B]] → [[C]]
```

如果 B 只是「转发」了从 A 到 C 的信息而没有增加任何新内容，B 应该被合并。

### 1.4 不可逆命名原则

节点的命名一旦确定，不应轻易修改——因为其他节点通过名称引用它。

**衍生问题**：双链 MD 的 `[[链接]]` 依赖文件名，而文件名恰好又是人类最想改的东西（从 `[[用户似乎不喜欢异步]]` 重构为 `[[用户倾向同步模式]]` 是对理解本身的深化）。这需要管理**显示名称 vs 规范标识符**之间的映射。

---

## 二、修改的一致性与传播（Consistency & Propagation）

### 2.1 因果链原则

每条 insight / reflection 必须显式声明自己的证据来源。修改行为必须沿因果链向前传播检查。

```
Observation (raw log)
    ↑  "基于"
Reflection (day summary)
    ↑  "提炼自"
Insight (long-term pattern)
    ↑  "应用于"
Decision / Action
```

### 2.2 修改的涟漪传播义务

当节点 A 被修改（尤其是被否定或降置信度），所有直接或间接引用 A 的节点必须被标记为「需要复审」。

```
Observation 被修正
  → 引用它的 Reflection 被标记为 stale
    → 引用该 Reflection 的 Insight 被标记为 stale
      → 引用该 Insight 的 MOC 被标记为 stale
```

### 2.3 逆向衰减原则 (Inverse Decay of Impact)

修改的影响力沿因果链向上传播时逐渐衰减，而非无限递归。

当一个 insight 有 10 条 evidence，修改其中 1 条 observation 并不必然导致 insight 变 stale——可能只是置信度微调。

### 2.4 独立验证原则

被多个独立来源支持的结论，对单一来源的修改具有容错性。

```
Insight: [[用户偏好 Python]]
证据链:
  - [[obs/2026-07-01]] - 用户说 "用 Python 写"
  - [[obs/2026-07-05]] - 用户批评了 Rust 的语法
  - [[obs/2026-07-10]] - 用户在 JS 和 Python 中选了 Python
  - [[obs/2026-07-19]] - 用户说 "其实 Rust 也不错" ← 新 observation
```

新 observation 并不推翻 insight，而是在内部添加 nuance。减少证据数 ≠ 推翻结论。

### 2.5 不可逆性标记原则

某些类型的 observation 一旦发生，即使用户后来改变主意，原始 observation 也不能被删除——只能被「覆盖」而非「抹除」。

```
[[用户偏好 Python]] → 置信度 0.9
  ↓ 新 evidence
[[用户偏好 Python]] → 置信度 0.4, 状态: 被挑战
  新增链接: [[用户偏好 Rust]] (置信度 0.6, 涌现中)
```

**要保留历史轨迹**，因为「一个人从喜欢 Python 变成喜欢 Rust」这个过程本身就是有价值的记忆，不能简单地用新事实覆盖旧事实。

---

## 三、时间性与鲜活度（Temporality & Freshness）

### 3.1 时间衰减原则

知识有一个隐含的半衰期。未被近期验证过的知识，其可信度随时间自然衰减。

Agent 在引用一条 6 个月前的 insight 时，应该意识到它可能已经过时。

### 3.2 知识类型决定衰减速率

| 知识类型 | 半衰期 | 例 |
|---------|--------|---|
| 用户核心身份/价值观 | 很长（年） | "我是后端工程师" |
| 项目当前状态 | 短（天/周） | "当前在用 v2.3" |
| 临时的上下文 | 极短（会话内） | "刚才报错是因为端口占用" |
| 一次性事实 | 零（用完即弃） | "用户今天午餐吃了三明治" |

### 3.3 静默腐烂与主动刷新

系统不能只被动等待修改触发 ripple，而应该主动识别「长期未被触及」的节点并提出刷新。

```
[[insights/用户技术栈偏好]] 
  最后验证: 2026-01-15
  当前日期: 2026-07-19
  → 状态: stale (180 天未验证)
  → 策略: 下次相关对话时，主动试探性验证
```

### 3.4 重演原则

当一段旧 knowledge 被重新检索到时，检索行为本身应该更新该节点的「最后触及时间」。频繁被检索到的老知识，可能仍然是活的。

---

## 四、知识的粒度与分层（Granularity & Layering）

### 4.1 原子性原则

一个节点应该表达「一个」观点/事实/观察。如果一个节点包含两个独立的声明，它们应该被拆分为两个节点。

**反面例子**：
```markdown
# 用户偏好
- 喜欢 Python
- 不喜欢微服务
- 注重交付速度
```

这三个独立的偏好应该各自成节点，因为它们可能有不同的置信度、不同的半衰期、被不同的 evidence 支持、在不同时间被独立更新。

### 4.2 可组合原则

原子节点可以通过链接组合成更高层次的复合节点（MOC / 聚合页），而复合节点的修改不应需要修改其组成部分。

```
[[用户架构决策原则]] (复合节点)
  ├── [[用户偏好单体部署]]
  ├── [[用户偏好同步模式]]
  └── [[用户偏好简单运维]]
```

修改 `[[用户偏好单体部署]]`（如降置信度）不影响复合节点本身的存在——复合节点只是索引。

### 4.3 粒度对等的链接原则

链接两端节点的抽象层级应该大致对等。避免原子 observation 直接链接到高度抽象的 MOC。

```
✗ [[obs/2026-07-19-单一对话]] → [[项目的完整架构决策史]]
✓ [[obs/2026-07-19-单一对话]] → [[reflection/2026-07-19]]
✓ [[reflection/2026-07-19]] → [[项目的完整架构决策史]]
```

跨层链接会让图谱拓扑失去意义，且污染反向链接列表。

---

## 五、链接的语义学（Semantics of Links）

### 5.1 链接类型原则

`[[A]]` 本身不表达关系的语义。系统必须区分不同类型的链接。

```
[[A]]  ← 这是什么意思？
  - A 是 B 的证据来源？
  - A 和 B 讨论同一个主题？
  - A 是 B 的父概念？
  - A 与 B 矛盾？
  - A 是 B 的旧版本？
  - A 是 B 的前置条件？
```

同一个 `[[...]]` 可能同时承担多种语义，但检索和传播时对不同语义的处理应该不同。

### 5.2 关键链接语义分类

| 语义 | 标签 | 修改传播 | 例 |
|------|------|---------|---|
| 证据/来源 | `supported_by` | 强传播 | insight → observation |
| 主题关联 | `related_to` | 弱传播 | 两个独立但相关的 insight |
| 上位概念 | `parent_of` / `child_of` | 结构变更 | 技术偏好 → Python 偏好 |
| 矛盾 | `contradicts` | 特殊处理 | 新 observation 反对旧 insight |
| 时间先后 | `precedes` / `follows` | 无传播 | 按时间顺序的事件 |
| 版本/演进 | `evolved_from` / `deprecated_by` | 强指向 | 旧 insight → 新 insight |

**关键洞察**：矛盾链接是最特殊的。两条矛盾的 evidence 链接到同一个 insight 时，不应该简单地「投票」，而应该触发更深层次的反思——**矛盾本身就是一条 meta-insight**（用户在不同场景下有不同偏好 / 用户的观念在变化）。

### 5.3 链接的闭环原则

如果 A 链接到 B，那么从 B 出发应该能够理解为什么 A 链接过来。

反向链接列表不应该只是一个名字列表，而应该携带足够的上下文让读者（包括 Agent 自己）理解这个链接的意图。

---

## 六、冲突与矛盾（Conflict & Contradiction）

### 6.1 矛盾不容消解原则

当新 evidence 与旧 insight 矛盾时，系统不能自动选择「相信新的」或「相信旧的」。矛盾本身是最高价值的信息，必须被显式保留和标记。

```
Observation: 用户说 "我不喜欢过度工程化"
  vs
Insight: [[用户偏好微服务架构]]
  
  → 不应该: 降低 insight 置信度然后继续
  → 应该做: 创建 [[矛盾-微服务偏好 vs 反过度工程]]
           链接双方，标记为 unresolved
           这个矛盾节点本身成为未来对话的关键上下文
```

### 6.2 矛盾分层原则

区分表面矛盾和实质矛盾：

- **表面矛盾**：用户周一喜欢 Python，周二喜欢 Rust → 可能只是不同场景、不同心情，不需要修改知识结构
- **实质矛盾**：用户说重视性能，但选了 Python 而不是 C++ → 触及价值观或推理链条的断裂，必须触发反思

### 6.3 歧义保留原则

对于无法判定真伪的信息，保留其不确定性，而非武断地选择一个版本。

```
[[用户对 ORM 的态度]]
状态: 矛盾
可能性 A (置信度 0.5): 不喜欢 ORM (来自 [[obs/...]])
可能性 B (置信度 0.5): 对 ORM 无所谓 (来自 [[obs/...]])
下次检索时: 两者都返回，由 Agent 在上下文中自行判断
```

---

## 七、记忆的生命周期（Lifecycle）

### 7.1 笔记不是永生的

每一条笔记都应该有一个明确的「生命阶段」：

```
诞生 (birth)    -- 被动创建
  ↓
活跃 (active)   -- 被链接、被更新、被检索
  ↓
稳定 (stable)   -- 不再变化但仍有参考价值
  ↓
陈旧 (stale)    -- 长期未验证，可能过时
  ↓
归档 (archived) -- 不再参与常规检索
  ↓
死亡 (dead)     -- 明确被否定，仅保留审计痕迹
```

### 7.2 死亡不等于删除

被明确推翻的知识不能被删除，但可以被标记为「已死亡」并携带指向其替代者的链接。

```markdown
---
status: dead
deprecated_by: [[用户新的架构偏好]]
death_reason: 用户在 2026-07 明确改为 K8s 微服务
preserved_for: 审计痕迹 / 理解信念变化过程
---

# 用户偏好单体部署 (已废弃)
```

### 7.3 信息密度递增原则

记忆在生命周期的推进中，信息密度应该逐步提高，体积应该逐步缩小。

```
Observation: 500 tokens 原始对话 (保留)
Reflection: 200 tokens 总结 (取代部分 observation 的检索价值)
Insight:    50 tokens 提炼 (作为主要检索对象)
Rule:       10 tokens 可执行规则 (直接注入 agent context)
```

旧的 observation 不删除，但不再参与日常检索——只在审计或深度反思时回溯。

---

## 八、检索中的知识完整性与代价（Retrieval Integrity）

### 8.1 检索原子性原则

检索一个节点时，必须决定是否同时检索它的直接邻居、反向链接、以及来源链。这个决策不能 ad-hoc。

```
检索 [[用户偏好 Python]]
  → 要不要带上它的证据链？ (supported_by 链接)
  → 要不要带上它相关的其他偏好？ (related_to 链接)
  → 要不要带上它的矛盾节点？ (contradicts 链接)
  → 要不要带上它的历史版本？ (evolved_from 链接)
```

不同场景下答案不同。但**决策规则必须明确**，否则每次检索结果都不可预测。

### 8.2 检索深度预算原则

图遍历有代价。每次检索在图中的展开深度应该有硬性预算。

```
检索起点: [[用户偏好 Python]]
深度 0: 该节点本身
深度 1: 直接链接的节点 (证据、相关、矛盾)
深度 2: 邻居的邻居
深度 N: 回报递减，预算耗尽时停止
```

### 8.3 检索的完备性 vs 简洁性权衡

检索结果必须同时报告「我找到了什么」和「我可能漏掉了什么」。

```
检索结果:
  高置信度匹配: [[用户偏好 Python]] (0.9)
  中等匹配: [[用户喜欢动态语言]] (0.7)
  潜在遗漏: 存在一个 [[矛盾-...]] 节点未被展开（深度预算耗尽）
  建议: 如果需要更完整的结果，请增加检索深度
```

---

## 九、人类与 Agent 的边界（Human-Agent Boundary）

### 9.1 双读者原则

每一条笔记在编写时，必须同时考虑 Agent 和人类两个读者。

- **Agent 需要**：结构化 frontmatter、可解析的链接、明确的置信度数值
- **人类需要**：可读的标题、有意义的摘要、直观的图谱可视化

两者不矛盾，但需要在格式设计上同时满足。

### 9.2 人工覆盖优先原则

人类对笔记的直接修改（编辑文件、删除节点、重命名），其权威性高于 Agent 自己的推理结果。

```
System 的规则:
  - Agent 可以: 创建、建议修改、标记 stale、降低置信度
  - Agent 不可以: 删除人类创建的笔记、覆盖人类编辑的内容
  - 人类修改后: 触发全量 ripple check（因为人类可能比 Agent 更了解真相）
```

### 9.3 可干预的遗忘原则

人类应该能在不破坏因果链的前提下，调整记忆的检索权重或将其从活跃检索中移除。

当笔记量达到 5000 条以上时，图谱会变成不可读的毛线球。系统需要提供**不会破坏图谱但能降低图谱密度**的机制。

---

## 十、可调试性与可审计性（Debuggability & Auditability）

### 10.1 决策溯源原则

Agent 的任何基于记忆的决策，必须能够逐层回溯到原始 observation。

```
Agent 决策: "建议用户使用 SQLite"
  ↓ 因为
记忆检索: [[用户偏好简单部署]] (置信度 0.85)
  ↓ 提炼自
Reflection: [[reflections/2026-07-10#deploy-simplicity]]
  ↓ 基于
Observations: [[obs/2026-07-01#conversation]], [[obs/2026-07-05#incident]]
```

任何一环断裂（如 insight 到 observation 没有链接），可审计性就丧失了。

### 10.2 静默修改不可接受原则

任何对记忆系统的自动修改（如 Agent 自动更新 confidence、自动合并节点）都必须留下可追溯的修改记录。

```
版本历史:
  - 2026-07-19 14:30 (agent): confidence 0.9 → 0.7, reason: 新矛盾证据 [[obs/...]]
  - 2026-07-15 09:00 (human): 编辑了偏好描述
  - 2026-07-10 20:00 (agent): 节点创建
```

### 10.3 可回滚原则

记忆系统应该支持回滚到任意历史时间点，以重放当时的检索结果。

这对于调试「为什么 Agent 当时做出了那个决策」至关重要。

---

## 总结：十组核心张力

| 维度 | 一极 | 另一极 | 平衡点 |
|------|------|--------|--------|
| 同一性 | 强制去重（合并所有相似节点） | 自由创建（允许冗余） | 语义去重 + 容忍有意义的重复 |
| 一致性 | 修改全量传播（保证全局一致） | 独立存在（不追溯修改） | 衰减传播 + 独立验证 |
| 时间性 | 旧即废（强衰减） | 永久真理（不衰减） | 类型决定的差异化半衰期 |
| 粒度 | 极致原子化 | 自由关联 | 原子节点 + 复合 MOC |
| 链接语义 | 强类型链接（多种链接标签） | 弱类型链接（仅 [[]]） | 核心语义分类 + 自由补充 |
| 矛盾 | 自动消解（投票/覆盖） | 永久保留一切矛盾 | 显式标记 + 分层处理 |
| 生命周期 | 永生笔记 | 定期清理 | 阶段化管理 + 归档不删除 |
| 检索 | 全图遍历 | 定点查询 | 深度预算 + 完备性报告 |
| 人机边界 | 全自动管理 | 全人工维护 | Agent 建议 + 人类裁决 |
| 可调试性 | 结果最优 | 过程透明 | 溯源链 + 版本历史 |

这些原则不是非此即彼的选择，而是一个多维约束空间。具体设计时，每个维度都要明确自己在光谱上的位置。

---

## 笔记模板示例

### Observation（原始交互日志）

```markdown
---
type: observation
timestamp: 2026-07-19T14:02:00+08:00
session: [[sessions/proj-alpha-2026-07-19]]
---

# 2026-07-19 14:02 - 用户咨询数据库选型

用户问：项目数据量不大，PostgreSQL vs SQLite 怎么选？
我回复了关于并发和部署复杂度的对比。
用户最终选了 SQLite，理由是「不想多维护一个服务」。
```

### Reflection（单日反思）

```markdown
---
type: reflection
period: 2026-07-19
sources: [[obs/2026-07-19-1402-db-choice]], [[obs/2026-07-19-1500-deploy]]
previous: [[reflections/2026-07-18]]
---

# Reflection 2026-07-19

今天的交互中注意到: [[用户偏好简单部署]] 再次出现。
与昨天的 [[reflections/2026-07-18#deploy-preference]] 关联。
```

### Insight（长期归纳）

```markdown
---
type: insight
domain: user-preference
confidence: 0.85
sources:
  - [[reflections/2026-07-15]]
  - [[reflections/2026-07-19]]
updated: 2026-07-19
---

# 用户偏好简单部署

用户多次在涉及基础设施选择的决策中，倾向于维护成本最低的方案。

证据:
- [[obs/2026-07-10#db-choice]] - SQLite over PostgreSQL
- [[obs/2026-07-15#deploy-discussion]] - 单体部署 over 微服务
- [[obs/2026-07-19#file-storage]] - 本地文件 over S3

这是用户的核心决策原则之一。
```

---

## 十一、核心矛盾：LLM 的不可靠性与原则的刚性需求

### 11.1 矛盾的本质

设计原则需要可靠的执行者，而 LLM 本质上不可靠。这不是 prompt engineering 能解决的问题——它是能力边界的问题：

```
LLM 擅长:                    系统需要:
  局部最优表达               全局一致性
  当前上下文推理             跨时间的完整性约束
  内容质量                   结构可靠性
  创造性关联                 精确溯源
```

一句话概括：**LLM 是优秀的「作家」，但不是合格的「图书管理员」。** 而我们的大部分设计原则——去重、溯源、归档、一致性检查——是图书管理员的工作。

### 11.2 LLM 违反原则的风险分级

**第一类：LLM 几乎必然会破坏的**

- **去重义务（1.2）**：LLM 不会在创建节点前主动做全局语义搜索，同义节点持续增生
- **粒度对等的链接（4.3）**：LLM 不理解抽象层级差异，随意创建跨层链接
- **不可逆命名（1.4）**：LLM 天然倾向就地优化表达，更改命名时不考虑其他节点的引用

**第二类：LLM 有时会破坏，后果严重**

- **因果链完整（2.1）**：LLM 写 insight 时可能漏写 source 链接或链接到错误节点
- **矛盾显式保留（6.1）**：LLM 默认行为是「消解矛盾」而非「保留并标记矛盾」
- **决策溯源（10.1）**：因果链断裂的直接后果

**第三类：LLM 能做但需要模板约束**

- **原子性（4.1）**：有模板强制单一声明时大概率遵守，否则天然写在一起
- **双读者原则（9.1）**：给定 frontmatter 模板能填好，自由设计会飘

**第四类：LLM 根本感知不到的系统级问题**

- **时间衰减（3.x）**：LLM 不知道某个节点上次验证是 180 天前
- **生命周期推进（7.x）**：active → stale → archived 是跨时间的系统决策
- **修改传播（2.2）**：一次修改的间接影响范围 LLM 无法计算

### 11.3 职责分离：System-enforced / Template-guided / LLM-managed

```
┌──────────────────────────────────────────────┐
│                  System Layer                 │
│  (确定性规则引擎，不依赖 LLM)                  │
│                                              │
│  • 文件名 = UUID，显示名 = frontmatter title  │
│  • 写入前：去重检查 (keyword 粗筛 → LLM 语义比对) │
│  • 写入后：修改传播 (BFS mark stale)          │
│  • 定时任务：时间衰减、生命周期推进           │
│  • 检索时：深度预算控制、完备性报告           │
│  • 全部操作：自动 change log                  │
└──────────────┬───────────────────────────────┘
               │
               │  读写
               ▼
┌──────────────────────────────────────────────┐
│                Template Layer                 │
│  (结构约束，LLM 在模板内发挥)                  │
│                                              │
│  observation.md.j2   定义必须字段             │
│  reflection.md.j2    定义 link 语义分类        │
│  insight.md.j2       限制单声明、要求 sources │
│  contradiction.md.j2  专用矛盾节点模板         │
│  moc.md.j2           纯聚合，无自述内容        │
└──────────────┬───────────────────────────────┘
               │
               │  prompt 注入模板
               ▼
┌──────────────────────────────────────────────┐
│                  LLM Layer                    │
│  (内容生成、语义判断、创造性关联)              │
│                                              │
│  • 在 template 限制内生成内容                 │
│  • 判断矛盾的深浅                            │
│  • 决定链接权重和方向                        │
│  • 提供自然语言解释和上下文                   │
└──────────────────────────────────────────────┘
```

核心转变：**不是「让 LLM 遵守原则」，而是「把原则固化到 LLM 无法违反的系统层和模板层」**。LLM 只负责它擅长的那部分——理解内容、做出语义判断、生成自然语言。剩下的，由可靠的系统逻辑兜底。

---

## 十二、Pi 扩展感知的设计落地

> 本章分析如何利用 pi coding agent 的扩展机制，将设计原则从"理想"转化为"可执行的约束"。

### 12.1 总体策略：用 Custom Tools 替代直接文件操作

核心思路：**LLM 不直接碰知识库文件系统。LLM 调用的是 kb_* 结构化工具，工具内部的 TypeScript 代码负责所有确定性约束。**

```
LLM 想做的             实际调用的工具           TypeScript 中发生的
──────────────────────────────────────────────────────────────
"记录一条观察"   →  kb_record_observation  →  生成 UUID 文件名
                                              写入 frontmatter
                                              自动 link 到当天 reflection
                                              更新嵌入索引

"创建 insight"   →  kb_create_insight      →  keyword 粗筛 → LLM 语义去重
                                              验证 sources 字段完整性
                                              自动建立双向链接

"建立链接"       →  kb_link                →  验证两端节点存在
                                              双向写入 frontmatter
                                              检查粒度对等

"查询记忆"       →  kb_retrieve            →  grep + 图遍历 → LLM rerank
                                              深度预算控制
                                              返回完备性报告

"反思"           →  kb_reflect             →  读取近期 observation
                                              生成 reflection 草稿
                                              要求 LLM 确认后写入
```

### 12.2 三层防线

#### 防线一：路径守卫（tool_call 事件拦截）

防止 LLM 越界直接用 `write`/`edit` 碰 KB 文件，作为最外层的兜底防线：

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "write" || event.toolName === "edit") {
    const targetPath = resolve(ctx.cwd, event.input.path);
    if (targetPath.startsWith(kbRoot)) {
      return { 
        block: true, 
        reason: `知识库文件请使用 kb_* 系列工具操作（kb_record_observation、
                  kb_create_insight 等），不要直接 write/edit。` 
      };
    }
  }
});
```

配合 `before_agent_start` 注入系统提示，主动告知 LLM 正确的操作方式。

#### 防线二：工具内校验（Custom Tools 的 execute 逻辑）

每个 kb_* 工具在 TypeScript 层面实现验证。LLM 只能表达意图，工具负责保底：

```typescript
pi.registerTool({
  name: "kb_create_insight",
  description: "创建一个长期归纳 insight 节点",
  parameters: Type.Object({
    title: Type.String(),          // 人类可读标题
    statement: Type.String(),       // 唯一声明（强制原子性）
    confidence: Type.Number(),
    sources: Type.Array(Type.String()),  // 强制填写（强制因果链）
    domain: Type.String(),
    linkTo: Type.Optional(Type.Array(Type.String())),  // 语义链接
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 1. 去重检查
    const existing = await semanticSearch(params.statement, kbRoot);
    if (existing && existing.similarity > DEDUP_THRESHOLD) {
      return {
        content: [{
          type: "text",
          text: `❌ 已存在相似节点 [[${existing.id}]]（相似度 ${existing.similarity}）。
                  请使用 kb_update_insight 更新它，而非创建新节点。`
        }],
        details: { blocked: true, existingId: existing.id }
      };
    }

    // 2. 验证 sources 存在
    const missingSources = params.sources.filter(id => !nodeExists(id));
    if (missingSources.length > 0) {
      return {
        content: [{
          type: "text",
          text: `❌ 以下 sources 不存在: ${missingSources.join(", ")}。请先确认节点存在。`
        }],
        details: { blocked: true }
      };
    }

    // 3. 生成 UUID 文件名，写入 MD + frontmatter
    const id = generateUUID();
    await writeNode(id, {
      type: "insight",
      title: params.title,
      statement: params.statement,
      confidence: params.confidence,
      sources: params.sources,
      domain: params.domain,
      status: "active",
      created: Date.now(),
      updated: Date.now(),
      last_verified: Date.now(),
    });

    // 4. 自动建立双向链接
    for (const sourceId of params.sources) {
      await createBidirectionalLink(id, sourceId, "supported_by");
    }

    // 5. 写入变更日志
    await appendChangeLog(id, "created", `confidence=${params.confidence}`);

    return {
      content: [{ type: "text", text: `✅ 已创建 insight [[${id}]]` }],
      details: { id }
    };
  }
});
```

#### 防线三：跨时间的系统维护（Session 事件 → 定时逻辑）

很多原则需要在"LLM 不在场"的情况下运行：

```typescript
// 会话启动时：检查时间衰减和生命周期
pi.on("session_start", async (_event, ctx) => {
  const allNodes = await loadNodeIndex();
  const now = Date.now();
  const staleIds: string[] = [];

  for (const node of allNodes) {
    // 时间衰减（原则 3.1-3.3）
    const halflife = getHalflife(node.type);  // insight=90天, observation=∞
    if (halflife > 0 && (now - node.last_verified) > halflife) {
      await markStale(node.id, `超过 ${halflife} 天未验证`);
      staleIds.push(node.id);
    }

    // 生命周期推进（原则 7.1）
    // stable(180天未触及) → archived
    // archived(365天) → dead
    await autoAdvanceLifecycle(node, now);
  }

  // 注入 stale 提醒到上下文
  if (staleIds.length > 0) {
    pi.sendMessage({
      customType: "kb-stale-warning",
      content: `以下 insight 已 stale，引用时请注意：\n${staleIds.map(id => `- [[${id}]]`).join("\n")}`,
      display: true,
    });
  }
});

// 每轮对话结束：检查是否触发 reflection
pi.on("agent_end", async (event, ctx) => {
  const newObservations = countNewObservationsSinceLastReflection();
  if (newObservations >= REFLECTION_THRESHOLD) {
    pi.sendUserMessage(
      `本轮产生了 ${newObservations} 条新 observation，达到 reflection 阈值。`,
      { deliverAs: "followUp" }
    );
  }
});
```

### 12.3 原则 → 实现映射表

#### 可由 Pi 扩展硬保证的原则

| 原则 | 保证方式 | 实现层 |
|------|---------|--------|
| **去重义务 (1.2)** | `kb_create_*` 工具内部先做 keyword 粗筛，有候选则调用 LLM 做语义等价判断，判定重复则拒绝并返回已有节点 ID + 引导链 | 防线二 |
| **不可逆命名 (1.4)** | 物理文件名 = UUID，LLM 永远不知道。`[[链接]]` 指向 UUID，显示名在 frontmatter.title，`kb_link` 自动维护 view→id 映射 | 防线二 |
| **因果链完整 (2.1)** | `kb_create_insight` 的 parameters 强制要求 `sources` 数组，工具内校验非空且节点存在 | 防线二 |
| **修改传播 (2.2)** | 节点被更新时，系统 BFS 遍历反向链接，自动标记受影响节点为 stale | 防线三 |
| **时间衰减 (3.1–3.3)** | `session_start` 时系统检查所有节点 `last_verified`，按知识类型半衰期计算，超期自动 stale | 防线三 |
| **生命周期 (7.x)** | 系统规则按时间窗口自动推进阶段（stable→stale→archived→dead），`kb_retrieve` 自动过滤 dead 节点 | 防线三 |
| **检索深度预算 (8.2)** | `kb_retrieve` 工具内部 BFS 有硬深度限制，不可配置 | 防线二 |
| **检索完备性报告 (8.3)** | `kb_retrieve` 返回时附带 "未展开节点数" 和 "建议增加深度的提示" | 防线二 |
| **静默修改不可接受 (10.2)** | 每个 kb_* 工具写入时自动追加 changelog entry（git commit 或 frontmatter history） | 防线二 |
| **双读者原则 (9.1)** | 工具生成的 MD 文件：frontmatter 给系统/Agent 读，正文给人类读，格式完全由 TypeScript 控制 | 防线二 |
| **粒度对等链接 (4.3)** | `kb_link` 检查两端节点的 type，跨层链接时发出 warning 或要求 LLM 确认 | 防线二 |
| **链接闭环 (5.3)** | `kb_link` 在创建链接时自动在两端 frontmatter 写入反向链接列表和上下文 | 防线二 |
| **决策溯源 (10.1)** | `kb_retrieve` 返回时自动跟随 `supported_by` 链，附带完整溯源路径 | 防线二 |
| **节点退化检测 (1.3)** | 系统定期扫描，发现只有一进一出的节点，生成合并建议 | 防线三 |
| **路径守卫** | `tool_call` 事件拦截 `write`/`edit` 对 KB 目录的操作，引导使用 kb_* 工具 | 防线一 |
| **可回滚 (10.3)** | 每个修改自动 git commit（或等效版本记录），支持回退到历史时间点 | 防线二 |

#### 需 LLM 判断、但工具能辅助的原则

| 原则 | 原因 | 辅助手段 |
|------|------|---------|
| **矛盾显式保留 (6.1)** | 判断"这是矛盾"本身需要语义理解 | 提供 `kb_create_contradiction` 专用工具入口；系统提示强调矛盾是知识而非噪音 |
| **表面/实质矛盾 (6.2)** | 该判断是认知行为，无法规则化 | `kb_create_contradiction` 有 `severity` 字段，LLM 评估后填写 |
| **歧义保留 (6.3)** | 判断"无法判定真伪"需认知 | insight 节点支持存储多个竞争性 statement，而非单一结论 |
| **独立验证 (2.4)** | 新 evidence 是推翻还是补充 | insight 更新工具在展示所有已有 evidence 给 LLM，让其自行判断 |
| **原子性 (4.1)** | 单一声明拆分需语义理解 | insight 模板只允许一个 statement 字段，但拆解本身是 LLM 行为 |
| **节点退化决策 (1.3)** | 系统发现候选，但决定权给 LLM | 系统扫描后标记 `@suggest_merge`，LLM 在 reflection 时决定 |

#### 几乎无法约束的

| 原则 | 原因 |
|------|------|
| 内容质量 | LLM 写的 reflection 质量、关联的恰当性完全取决于模型能力 |
| 创造性链接 | LLM 在 reflection 中发现意外关联的能力——这恰恰是 Reflection 流的核心价值，不应被约束 |

### 12.4 关键设计决策

**决策 1：物理文件名永不暴露给 LLM**

LLM 通过 `title`（人类可读）和 `id`（UUID 规范标识符）引用节点。物理文件路径由系统管理。这从根本上规避了原则 1.4（不可逆命名）的所有问题。

**决策 2：每个写操作都是一个工具调用，每次工具调用都留下痕迹**

没有"LLM 静默修改文件"的可能。每次 kb_* 写操作都是显式的工具调用，前端展示、后端记录。这为原则 10.2（不可接受静默修改）和 10.3（可回滚）提供基础。

**决策 3：内存中的节点索引图**

利用 `pi.appendEntry()` 在 session 间持久化一个 JSON 节点索引（id → {type, title, links: {in, out}, status, timestamps}），避免每次检索都需要遍历 MD 文件。`session_start` 时恢复索引，Agent 运行中保持同步。

**决策 4：检索不是文件操作，是工具调用**

`kb_retrieve` 工具内部融合 grep（精确匹配）、图 BFS（关联搜索）做粗召回，再用 LLM 做 rerank 排序。LLM 不能自己决定检索方式。深度预算、完备性报告由工具自动生成。

**决策 5：Reflection 是对话，不是静默动作**

当触发条件满足时，系统不自动写入 reflection。而是通过 `sendUserMessage` 发起一个对话回合，让 LLM 在充足的上下文和模板约束下生成 reflection 草稿，然后显式调用 `kb_create_reflection` 写入。这样 reflection 本身也成为可审计的 agent action。

### 12.5 Pi 扩展的适合性分析

| Pi 扩展能力 | 如何对应我们的需求 |
|-------------|-------------------|
| `registerTool` + TypeBox schema | 强类型参数校验，去重、因果链的第一道关卡 |
| `tool_call` 事件拦截 | 路径守卫 + 任何工具调用的前置/后置中间件 |
| `tool_result` 事件 | 在所有工具的返回结果上附加额外信息（如 stale 警告） |
| `before_agent_start` | 注入 KB 状态摘要到系统提示（"以下 insight 已 stale"） |
| `session_start` | 恢复节点索引、运行时间衰减检查 |
| `agent_end` | 检查 reflection 触发条件 |
| `appendEntry` | 持久化节点索引（跨 session 状态） |
| `sendUserMessage` + `sendMessage` | 触发 reflection 对话、注入 stale 警告 |
| `pi.exec` | 调用 git、ripgrep 等外部工具 |
| 文件系统访问 (`node:fs`) | 读写 MD 文件、扫描目录 |

---

## 十三、场景推演与设计修正

> 以下通过 42 个具体场景，逐类检视现有设计的漏洞，并给出修正方案。

### 13.1 创建场景

#### 场景 1：Agent 记录第一条 observation —— 谁来调用？

**现状**：observation 模板定义了格式，但未明确创建机制。

**问题**：如果完全由 Agent 自己决定「这条值得记录」，它可能漏记关键信息。如果完全由系统自动记录，则所有琐碎对话都会成为永久的 observation，淹没信号。

**缺失**：**被动全量日志 vs 主动标注分离原则**。

**修正**：引入双层 observation 模型：

```
Layer 0 — 系统自动日志（/logs/session-*.md）
  └ 每轮对话结束后，系统自动追加原始交互。不可跳过，不可删除。
    这是审计用的「全量备份」，不参与日常检索。

Layer 1 — Agent 标注 observation（kb_record_observation）
  └ Agent 从自动日志中选择值得关注的交互，创建结构化 observation。
    这才是参与检索、被 reflection 引用的节点。
```

对应修改 observation 模板，增加字段：

```yaml
---
type: observation
id: obs-abc123
created_by: agent
source_log: [[session-2026-07-19-001]]  # 指向自动日志
significance: high | medium | low        # Agent 自己评估的重要程度
timestamp: 2026-07-19T14:02:00+08:00
---
```

#### 场景 2：observation 跨 session 积累，reflection 阈值何时触发？

**问题**：用户一天开 3 个 session，每个 session 各产生 10 条 observation。如果 reflection 计数器只在 session 内，永远不触发。

**缺失**：**Reflection 触发是跨 session 的累积行为**。

**修正**：Reflection 触发计数器存储在 KB 元数据文件中（`/kb/.kb_meta.json`），不在 pi session 中。`agent_end` 时更新全局计数器。任何 session 结束时都要检查全局计数。

```json
// .kb_meta.json
{
  "reflection_triggers": {
    "unreflected_observations": 28,
    "threshold": 10,
    "last_reflection_at": "2026-07-18T20:00:00Z",
    "domains_with_pending": ["user-preference", "project-status"]
  }
}
```

#### 场景 3：去重拒绝后 LLM 不知道该做什么

**问题**：`kb_create_insight` 被去重拒绝后返回已有节点 ID，但 LLM 没有被引导到正确的后续动作。

**缺失**：**拒绝 → 引导链**。

**修正**：`kb_create_*` 被拒绝时，返回内容必须包含可执行的下一步建议：

```
❌ 已存在相似 insight [[ins-abc123]]（相似度 0.91）。

建议的下一步：
- 如果观点不同 → 使用 kb_update_insight 更新 [[ins-abc123]]
- 如果是对同一事物的不同视角 → 使用 kb_create_insight 并设置
  linkTo: ["ins-abc123"] 和 linkType: "alternative_view"
- 如果想添加新证据 → 使用 kb_add_evidence 向 [[ins-abc123]] 追加 source
```

#### 场景 4：创建 insight 时引用的 source 已经 stale

**问题**：`kb_create_insight` 只校验 source 存在性，不校验时效性。

**缺失**：**source 时效性校验**。

**修正**：工具内部检查每个 source 的 `last_verified`，如果超过该类型的半衰期 2 倍，返回警告并要求 Agent 在 insight 中显式标注或降低初始 confidence。不是硬拒绝（Agent 可能有理由引用旧数据），而是 flag。

#### 场景 5：Agent 创建 MOC 没有专用工具

**问题**：MOC 不同于 insight——它没有 statement，只是一个索引。用 `kb_create_insight` 会被原子性原则拒绝。

**缺失**：**kb_create_moc 和 kb_add_to_moc 工具**。

**修正**：

```typescript
pi.registerTool({
  name: "kb_create_moc",
  parameters: Type.Object({
    title: Type.String(),
    description: Type.Optional(Type.String()),
    childNodes: Type.Optional(Type.Array(Type.String())),
    domain: Type.String(),
  }),
  // MOC 允许链接到任何层级，不做粒度对等检查
  // MOC 不参与去重（同一个主题可有多个组织视角）
});

pi.registerTool({
  name: "kb_add_to_moc",
  parameters: Type.Object({
    mocId: Type.String(),
    nodeId: Type.String(),
  }),
  // 只是向 MOC 的子节点列表追加，不建立独立 link
});
```

### 13.2 检索场景

#### 场景 6：大规模索引的加载性能

**问题**：几千个节点时，`session_start` 从 `appendEntry` 全量恢复索引的 JSON 序列化/反序列化开销。

**缺失**：**索引懒加载 + 增量同步**。

**修正**：`session_start` 只加载索引骨架（id、type、title、status、timestamps）。链接图按需展开。MD 正文只在需要时读取。节点数 < 1000 时全量加载也 OK，但架构设计应支持懒加载。

#### 场景 7：检索返回零结果

**问题**：Agent 在某个 domain 上反复检索零结果，系统默默无闻。

**缺失**：**零结果是一个信号，应被记录为 knowledge gap**。

**修正**：`kb_retrieve` 在连续 N 次零结果时自动创建一个 knowledge gap 标记。它在检索时不会返回结果，但会在 reflection 时提示「domain X 存在知识空白」。

#### 场景 8：混合状态的检索结果排序

**问题**：一次检索可能返回 active、stable、stale 三种状态的节点，排序规则不明。

**缺失**：**检索结果的生命周期加权排序原则**。

**修正**：默认排序权重 = status_weight × recency_weight × relevance_score。

| status | weight | 说明 |
|--------|--------|------|
| active | 1.0 | 正常参与 |
| stable | 0.8 | 略降权 |
| stale | 0.4 | 显著降权，带警告标记 |
| archived | 0.0 | 不在 routine scope 中出现 |
| dead | 0.0 | 不出现在任何 scope 中（除 forensic） |

#### 场景 9：精准回溯 archived 旧数据

**问题**：Agent 需要「今年 3 月那次的报错信息」，但对应 observation 已 archived，`kb_retrieve` 默认不返回。

**缺失**：**检索 scope 参数**。

**修正**：`kb_retrieve` 增加 `scope` 参数：

| scope | 搜索范围 | 用途 |
|-------|---------|------|
| `routine`（默认） | active + stable | 常规检索 |
| `deep` | active + stable + stale + archived | 深度探索 |
| `forensic` | 所有节点含 dead | 审计/调试 |

#### 场景 10：检索结果超过 context 预算

**问题**：返回 30 个节点 + 溯源链，轻松超过 10K token。

**缺失**：**KB 上下文注入预算原则**。

**修正**：`kb_retrieve` 内部有硬 token 预算（默认 4096 tokens）。超出时按 ranking 截断，返回结果中显式告知 Agent：

```
检索到 28 个节点，因上下文预算限制，仅返回排名前 15 个。
被截断的节点：[[...]], [[...]], ...（13 个）。
如需完整结果，请缩小检索范围或使用 scope=deep 分页检索。
```

### 13.3 更新场景

#### 场景 11：渐变式偏好迁移

**问题**：用户从偏好 Python 逐渐变成偏好 Rust，这不是二元 contradict，而是权重漂移。

**缺失**：**证据时间加权原则**。

**修正**：计算 insight confidence 时，evidence 的时间权重按指数衰减：

```
weight(evidence) = e^(-λ × age)
其中 λ = ln(2) / halflife
```

近期证据（2 周内）权重接近 1.0，6 个月前的权重接近 0。Agent 在更新 insight 时看到的是「近期发生了什么」的加权视图，而非等权重历史平均。

#### 场景 12：Agent 写错了 observation

**问题**：Agent 误记了 observation 内容。当前设计只允许人类修正。

**缺失**：**自修正窗口原则**。

**修正**：Agent 创建的 observation 有 1 小时（或同 session 内）的自修正窗口。超时后进入稳定期，仅人类可修改。`kb_update_observation` 在窗口内对 Agent 可用，超时后拒绝并提示「需人类审核」。

这个窗口期也解决了「LLM 可能会自我纠正」的需求，同时防止它随意篡改历史记忆。

#### 场景 13：stale 警告洪泛

**问题**：一次 ripple 更新标记 50 个节点 stale。Agent 启动时收到 50 条 stale 警告淹没 context。

**缺失**：**stale 警告的聚合与优先级原则**。

**修正**：不要逐节点报告。按 domain 和时间聚合，只报告 top N（默认 5）：

```
⚠ 以下 domain 有待复审的 stale 节点：
- user-preference: 12 个节点 (最早 stale: 2026-07-15, 最后 stale: 2026-07-19)
- project-status: 3 个节点

最受影响的待复审节点：
- [[ins/user-preference-abc123]] (6 个上游节点有变更)
- [[ins/user-preference-def456]] (4 个上游节点有变更)
... (更完整的列表请用 kb_list_stale 查看)
```

#### 场景 14：缺少 created_by 元数据

**问题**：当前模板没有 `created_by` 字段，原则 9.2（人工覆盖优先）无法在工具层实现。

**缺失**：**created_by 元数据字段**。所有节点类型的前端模板都增加 `created_by: "agent" | "human"`。

### 13.4 矛盾场景

#### 场景 15：系统级别的轻量矛盾检测

**问题**：完全依赖 LLM 识别矛盾（原则 6.1）。但系统能否做信号级辅助？

**缺失**：**轻量级矛盾检测**。

**修正**：在 `kb_create_insight` 的 LLM 去重调用中，同时要求 LLM 做矛盾检测——即判断新声明是否与同一 domain 下的已有节点存在矛盾关系。若有，在创建成功的同时附加提示：

```
✅ 已创建 insight [[xyz]]。
⚠ 注意到该 topic 下存在方向明显不同的已有节点：[[existing-id]]。
如果新 insight 与它存在矛盾关系，建议使用 kb_create_contradiction 显式标记。
```

此检测与去重合并为一次 LLM 调用，不额外增加成本。

#### 场景 16：矛盾的慢性腐烂

**问题**：一个 contradiction 节点存在 3 个月 unresolved，从信号变为噪音。

**缺失**：**矛盾的超时升级原则**。

**修正**：

| 状态 | 条件 | 检索行为 |
|------|------|---------|
| unresolved | < 30 天 | 正常参与检索，标记为需要关注的信号 |
| chronic | 30-90 天 | 降权 0.5，标记为「长期未解决」 |
| dormant | > 90 天 | 仅 deep scope 返回，附加「此矛盾可能已过时」 |
| resolved | 人类或 Agent 标记 | 转为正常 insight，保留对矛盾节点的引用 |

#### 场景 17：矛盾被解决时的完整协议

**问题**：用户解决了矛盾，当前设计没有描述完整的解决流程。

**缺失**：**矛盾解决协议**。

**修正**：矛盾解决不是删除矛盾节点，而是一个多步骤流程：

```
1. Agent 调用 kb_resolve_contradiction
   - 参数：contradictionId, resolution（自然语言解释）, newInsightTitle

2. 系统自动：
   - 创建一个新的精细 insight（包含 resolution 内容）
   - 将矛盾节点状态改为 resolved，链接到新 insight（evolved_from）
   - 如果有旧的互相矛盾的 insight，将它们标记为 deprecated_by → 新 insight
   - 矛盾节点本身不被删除，保留为「知识演化事件的证据」
```

### 13.5 跨 Session 场景

#### 场景 18：跨 session 的 reflection 触发（重申场景 2）

触发计数器在 `.kb_meta.json` 中，不在任何单一 session 内。`agent_end` 时更新全局计数，任何 session 结束时都要检查。

#### 场景 19：并发 session 的写冲突

**问题**：两个 pi 实例同时操作 KB。

**缺失**：**并发写入安全原则**（MVP 可标记为已知限制）。

**修正**：

- **短期（MVP）**：使用文件锁。每个 kb_* 写入工具在写入 MD 时获取该文件的排他锁（flock）。索引更新在内存中，不做跨 session 同步。下次 `session_start` 时通过文件 mtime 检测外部修改。
- **长期**：考虑使用 SQLite 作为索引存储，利用其 WAL 模式支持并发读写。MD 文件作为 human-readable view，索引数据库作为 system-of-record。

#### 场景 20：索引与文件系统的不一致

**问题**：文件被人手动删除或修改，索引仍指向旧数据。

**缺失**：**索引与文件系统的一致性自检原则**。

**修正**：`session_start` 时做抽样验证（随机抽取 min(5%, 50) 个节点检查文件存在性和 mtime）：

- 文件缺失 → 从索引中移除，发出警告
- mtime 更新而索引 timestamp 未更新 → 标记为「外部修改」，重新读取 frontmatter，触发关联 ripple check
- 如果抽样发现 > 10% 不一致 → 触发全量索引重建

#### 场景 21：工具写入的原子性

**问题**：`kb_create_insight` 中途失败（磁盘满等），出现部分写入。

**缺失**：**写操作的原子性原则**。

**修正**：每个 kb_* 写入工具遵循：

```
1. 写入临时文件 (.tmp/{uuid})
2. fsync 临时文件
3. 原子 rename 到目标路径
4. 更新内存索引
5. 返回成功给 LLM
```

任何步骤失败 → 清理临时文件 → 索引不变 → 返回错误。

### 13.6 人类交互场景

#### 场景 22：人类在 Obsidian 中修改了节点

已在场景 20 中覆盖——通过 mtime 对比做文件修改检测。补充：如果 human 修改的内容被检测到，系统应自动追加 changelog：「外部修改于 YYYY-MM-DD HH:MM」。

#### 场景 23：人类在 Obsidian 中创建了新节点

**缺失**：**孤儿节点发现**。

**修正**：`session_start` 时扫描 KB 目录，发现不在索引中的 MD 文件 → 解析 frontmatter → 自动加入索引。不做去重（人类直接创建视为有意为之，覆盖去重规则）。如果 frontmatter 格式不符合模板 → 加入索引但标记为 `format: unknown`，不参与常规检索。

#### 场景 24：人类修改了 MD 正文中的 [[链接]]

**问题**：Obsidian 中拖拽链接会修改 MD 正文中的 `[[...]]`。但系统索引中的链接关系是独立的。

**缺失**：**链接的权威来源原则**（需要在设计决策中明确）。

**修正**：明确声明——**系统索引中的 link graph 是权威数据源**。MD 正文中的 `[[...]]` 是人类可读的呈现，系统不保证与其同步（即不解析正文来更新索引）。人类修改链接应通过 `/kb link ...` 命令或直接编辑 frontmatter 的 links 数组。Obsidian 拖拽对系统是不可见的。这是一个已知的人机交互断点。

### 13.7 工具交互边界

#### 场景 25：同一轮中先后创建的两个节点互相引用

**问题**：Agent 在同一轮 tool batch 中调用 kb_create_insight(A)，然后 kb_create_insight(B) 以 A 为 source。但 B 调用 `nodeExists(A)` 时 A 可能尚未写入索引。

**缺失**：**工具调用间的可见性原则**。

**修正**：所有 kb_* 创建工具在写入索引时使用内存同步操作。同一轮中先完成的创建结果对后续调用立即可见。实现上，索引更新必须在 `execute` 返回前完成，不能用异步队列。

#### 场景 26：非对称链接语义

**问题**：Agent 调用 kb_link(A, B, "supported_by") 后，B 的反向链接列表中自动出现 A。但 B→A 的语义应该是 "is_source_of"（系统自动推导），不影响 A→B 的语义（用户显式指定）。

**修正**：明确区分「正向链接」和「反向链接注释」：

```yaml
# Node A's frontmatter
links_out:
  - target: [[B]]
    type: supported_by
    created_at: 2026-07-19T14:30:00Z

# Node B's frontmatter (系统自动维护)
links_in:
  - source: [[A]]
    type_note: "is_source_of"  # 由系统从 A→B 的 supported_by 推导
    created_at: 2026-07-19T14:30:00Z
```

Agent 想创建 B→A（语义不同于 A→B 的反向注释）时，需单独调用 `kb_link(B, A, "related_to")`。

#### 场景 27：死循环链接

**缺失**：**图遍历的 visited set**。

**修正**：在原则 8.2（检索深度预算）中显式补充：BFS 维护 visited 集合。visited 节点计入「已扩展」预算，防止 visited 节点消耗全部深度预算导致真正的新节点无法被遍历。

#### 场景 28：前向引用——链接到还不存在的节点

**问题**：Agent 想写 reflection 引用一个它预计稍后会创建的 insight。当前 `kb_link` 要求两端都存在。

**缺失**：**前向引用许可原则**。

**修正**：`kb_link` 允许链接到不存在的节点，但在 frontmatter 中标记为 `pending`：

```yaml
links_out:
  - target: [[not-yet-created-id]]
    type: supported_by
    status: pending
    pending_since: 2026-07-19T14:30:00Z
```

当目标节点被创建时，系统自动完成双向链接。如果 48 小时内目标仍未出现，pending link 标记为 `expired`：不再参与检索展开，仅保留为 frontmatter 中的注释。

### 13.8 Reflection 质量

#### 场景 29：Reflection 废话连篇

**缺失**：**Reflection 最小信息密度原则**。

**修正**：`kb_create_reflection` 写入后，系统计算 density = primary source 数量 / reflection 正文 token 数。低于阈值（如每 50 token 才提到一条 observation）标记 quality 为 low。低质量 reflection 会在下次 reflection 触发时提醒 Agent：「上一轮 reflection 信息密度较低，建议更聚焦于具体观察而非泛泛总结。」

#### 场景 30：Reflection 的重复消化

**问题**：Agent 反复对同一批 observation 做 reflection。

**缺失**：**Reflection 的幂等性保护原则**。

**修正**：每条 observation 只能被一个 reflection 作为 primary source 引用。`kb_create_reflection` 的参数中声明 `sources`，工具检查这些 source 是否已被其他 reflection 引用。如果已引用 → 可以创建 reflection 但 source 列表中标记哪些是「二次引用」（非 primary），primary source 不足（< threshold）时 quality 标记为 low。

Agent 如想重新反思 → 可使用 `kb_re_reflect`，它会带上旧 reflection 作为对比。

#### 场景 31：发现新类型的 insight——交互模式

**缺失**：**domain 分类不完整**。

**修正**：扩展 domain 分类：

| domain | 例 |
|--------|---|
| `user-preference` | 偏好 Python、不喜欢微服务 |
| `user-behavior` | 先问原理再要求实现、每次对话结束前确认 |
| `user-identity` | 后端工程师、10 年经验、在某公司工作 |
| `project-status` | 当前在重构认证模块、v2.3 最新 |
| `project-decision` | 为什么选了 SQLite 而不是 PostgreSQL |
| `agent-self-knowledge` | Agent 对自身表现的认知（「我上次解释得不够清楚」） |
| `external-fact` | API 文档、库的 breaking change 等外部知识 |

### 13.9 修正汇总

#### 新增原则（18 条）

| # | 原则 | 所属维度 |
|---|------|---------|
| 1 | 被动全量日志 vs 主动标注分离 | 创建（新维度） |
| 2 | Reflection 触发跨 session 累积 | Reflection |
| 3 | 零结果即 knowledge gap | 检索 |
| 4 | 检索结果生命周期加权排序 | 检索 |
| 5 | KB 上下文注入预算 | 检索（新维度） |
| 6 | 证据时间加权 | 一致性/时间性 |
| 7 | 自修正窗口 | 人机边界 |
| 8 | stale 警告聚合与优先级 | 一致性 |
| 9 | 矛盾超时升级 | 冲突与矛盾 |
| 10 | 矛盾解决协议 | 冲突与矛盾 |
| 11 | Reflection 幂等性保护 | Reflection |
| 12 | Reflection 最小信息密度 | Reflection |
| 13 | 并发写入安全 | 跨 session（MVP 可推迟） |
| 14 | 索引与文件系统一致性自检 | 跨 session |
| 15 | 写操作原子性 | 工具实现 |
| 16 | 链接权威来源（索引 vs MD 正文） | 人机边界 |
| 17 | 工具调用间可见性 | 工具实现 |
| 18 | 前向引用许可 | 创建 |

#### 新增/修改工具

| 工具 | 类型 | 说明 |
|------|------|------|
| `kb_create_moc` | 新增 | 创建 MOC 聚合节点 |
| `kb_add_to_moc` | 新增 | 向 MOC 追加子节点 |
| `kb_add_evidence` | 新增 | 向已有 insight 追加 source evidence |
| `kb_create_contradiction` | 新增 | 创建矛盾节点 |
| `kb_resolve_contradiction` | 新增 | 解决矛盾（含协议流程） |
| `kb_list_stale` | 新增 | 列出所有 stale 节点，按影响程度排序 |
| `kb_re_reflect` | 新增 | 对已有 reflection 做二次反思 |
| `kb_retrieve` | 修改 | 增加 `scope` 参数、上下文预算截断、排序规则 |
| `kb_link` | 修改 | 支持前向引用（pending link）、非对称语义 |
| `kb_create_insight` | 修改 | source 时效性校验、轻量矛盾检测、拒绝引导链 |
| `kb_create_reflection` | 修改 | 幂等性检查、信息密度评分 |

#### 已有原则的修正

| 原则 | 修正内容 |
|------|---------|
| 1.4 不可逆命名 | 明确物理文件名 = UUID，显示名 = frontmatter.title，映射由系统在工具层管理。LLM 永远不知道物理文件名 |
| 3.2 知识类型衰减速率 | 细化：不同 domain 的 insight 可有不同半衰期（user-identity 比 project-status 衰减慢），由 domain 元数据中的 `halflife_days` 字段控制 |
| 7.1 生命周期 | 各阶段的触发条件需具体数值建议：birth→active（创建即 active）、active→stable（30天未更新）、stable→stale（90天未验证）、stale→archived（stale后30天未复审）、archived→dead（365天） |
| 8.2 检索深度预算 | 补充：BFS 维护 visited 集合，visited 节点计入已扩展预算 |
| 5.2 链接语义分类 | 补充 `alternative_view`（同一主题的不同视角）和 `is_source_of`（系统反向自动推导） |

#### 已知限制（MVP 阶段可接受）

- **并发 session 写入冲突**：MVP 通过文件锁规避。两个 pi 实例各自维护内存索引，可能出现短暂不一致，下次 session_start 自检修复
- **Obsidian 拖拽链接不可见**：在 Obsidian 中修改正文 `[[...]]` 不会同步到系统索引。人类需通过 `/kb link` 命令操作链接。MD 正文中的链接仅为人类可读展示
- **前向引用的 pending link** 是 MVP 简化版（48 小时过期），更完善的实现可支持 ID 预留等

---

## 十四、用 LLM 替代 Embedding —— 架构简化决策

> 本文档中的「去重」「语义检索」「矛盾检测」三个机制，均不使用独立的 embedding 模型，
> 而是在 kb_* 工具内部通过可控的 LLM 调用完成。以下阐述理由、具体方案、成本分析和 fallback 策略。

### 14.1 为什么不用 Embedding

三个场景都有替代方案，且 LLM 方案在质量或实现简单性上占优。

**场景 A：去重检查（原则 1.2）**

embedding 方案的固有问题：
- 余弦相似度 ≠ 语义等价。「用户喜欢简单部署」和「用户排斥运维复杂度」措辞完全不同但语义等价——embedding 可能漏掉
- 「用户喜欢 Python」和「用户曾经用过 Python」措辞高度相似但实质不同——embedding 可能误杀
- 阈值调优是黑盒：0.85 和 0.82 的差距你解释不了

LLM 方案：
- 这是一个**封闭的二分类任务**——给定 1-5 个候选节点，判断新声明是否与任一实质重复
- 不是让 LLM 做开放决策，是让它在一个很小的候选集中做精确判断
- temperature=0 保证输出确定性

**场景 B：语义检索（kb_retrieve）**

直接采用成熟的 LLM-as-reranker 模式：grep + BFS 粗召回 → LLM 按相关性排序。
LLM reranker 在几乎所有 benchmark 上优于纯 embedding 排序，这是 RAG 领域的共识。

**场景 C：轻量矛盾检测（13.4 场景 15）**

与去重调用合并——同一次 LLM 调用中同时要求判断「重复」和「矛盾」。

### 14.2 具体实现方案

#### 去重调用（kb_create_insight 内部）

```
1. keyword 粗筛：用 statement 中的关键词在相同 domain 下做 frontmatter 匹配
   → 候选数通常为 0-5（新知识库初期通常为 0）

2. 候选为空 → 跳过 LLM 调用，直接写入

3. 候选非空 → 构造轻量 LLM 调用（内部 API，不对 Agent 暴露）：

   System: 你是一个知识库去重检查器。判断新声明是否与已有节点实质重复或矛盾。
           返回 JSON：{"isDuplicate": bool, "duplicateId": "..."|null,
           "isContradiction": bool, "contradictionId": "..."|null, "reason": "..."}

   User: 新声明：「{statement}」
         已有节点：
         1. [{id}] {title}: {existing_statement}
         2. [{id}] {title}: {existing_statement}
         ...

4. 根据 LLM 返回结果决定：
   - isDuplicate → 拒绝创建，返回已有节点 ID + 引导链
   - isContradiction → 创建成功，附加矛盾提示
   - 两者皆否 → 正常写入
```

**关键设计点**：
- 使用 temperature=0 确保确定性
- 候选最多 5 个（超过则取 top-5 by keyword relevance）
- 输入控制在 ~1500 tokens，输出 ~100 tokens
- 调用发生在 `kb_create_insight` 的 `execute` 内部，对 Agent 完全透明

#### 检索 Rerank（kb_retrieve 内部）

```
1. grep + frontmatter 过滤 → 粗召回（最多 30 个候选）
2. 图 BFS 补充关联节点
3. 将所有候选节点的 title + statement 摘要发给 LLM：

   System: 根据查询意图，对候选节点按相关性排序。
           返回 JSON：{"ranked": ["id1", "id2", ...], "irrelevant": ["id3", ...]}

   User: 查询：「{query}」
         候选节点：
         1. [{id}] {title}: {summary}
         ...

4. LLM 排序 × status_weight → 最终排序 → 上下文预算截断
```

### 14.3 成本分析

以个人 KB 的量级（数百到数千节点）估算单次操作额外成本：

| 操作 | 触发条件 | 输入 tokens | 输出 tokens | 估算成本（Haiku） | 估算成本（Sonnet） |
|------|---------|------------|------------|------------------|-------------------|
| kb_create_insight | 同 domain 有候选 | ~800-1500 | ~100 | ~$0.0002 | ~$0.005 |
| kb_create_insight | 同 domain 无候选 | 0 | 0 | $0 | $0 |
| kb_retrieve（rerank） | 每次调用 | ~500-2000 | ~100 | ~$0.0003 | ~$0.006 |
| kb_create_reflection | 同 domain 有候选 | ~800-1500 | ~100 | ~$0.0002 | ~$0.005 |

**典型使用场景**：
- 一次对话 session 通常创建 2-5 条 observation，触发 0-1 次 insight 创建
- 一次对话可能做 3-5 次 kb_retrieve
- 合计额外 LLM 开销：每 session 约 $0.001-0.02（Haiku）或 $0.03-0.5（Sonnet）

**对比 embedding 方案**：embedding API 便宜约 10x，但需要额外基础设施（模型文件、向量存储、维度管理）。对于个人 KB 的量级，LLM 方案的绝对成本差异可以忽略。

### 14.4 Fallback 策略

如果 LLM API 不可用（网络故障、额度用尽等），kb_* 工具降级运行：

| 操作 | 正常模式 | 降级模式 |
|------|---------|---------|
| kb_create_insight 去重 | LLM 语义比对 | 仅 keyword 完全匹配 title，不阻止创建但附加警告 |
| kb_retrieve rerank | LLM 排序 | 仅按 status_weight × recency 排序，返回时标注「未做语义排序」 |
| kb_create_insight 矛盾检测 | 含在去重调用中 | 跳过，标注「矛盾检测因 API 不可用而跳过」 |

降级不是静默的——每次降级都在工具返回结果中显式告知 Agent，使其在低质量排序结果下更谨慎。

### 14.5 对实施的影响

- **基础设施零新增**：不需要向量数据库、ONNX 运行时、embedding 模型文件
- **Pi 扩展内实现**：`fetch()` + 环境变量中的 API key，或 `pi.exec()` 调 CLI
- **阶段 3「语义层」取消**：原计划中 2-3 天的 embedding 引入阶段直接消失
- **总阶段数从 5 减到 4**：骨架 → 只读 → 写入（含 LLM 去重） → 检索增强（含 LLM rerank）

### 14.6 修正后的实施阶段

| 阶段 | 内容 | 交付物 |
|------|------|--------|
| **0：骨架** | 文件系统层 + NodeIndex + LinkGraph + .kb_meta.json | 可 import 的 TS 模块，能创建/查询节点 |
| **1：只读检索** | kb_retrieve（grep + BFS，暂不做 LLM rerank）+ kb_list_stale | Agent 可以查 KB，无写入能力 |
| **2：写入** | 所有 kb_create_* + kb_link + 自动日志 + reflection 触发 | Agent 可以写 KB，去重靠 keyword |
| **3：语义增强** | kb_retrieve 加入 LLM rerank + kb_create_* 加入 LLM 去重和矛盾检测 | 完整版，质量飞跃 |
| **4：打磨** | 时间加权、自修正窗口、一致性自检、孤儿发现、原子写 | 生产就绪 |

阶段 0-2 不依赖 LLM API（纯本地），阶段 3 引入 LLM 调用但完全可选——即使永远不做阶段 3，KB 也是功能完整的（只是检索排序和去重精度较低）。这种渐进式架构让整个方案可以在不引入任何外部依赖的情况下先跑起来。

---

## 十五、实际建成的系统

> 设计文档第 1-14 章是"目标状态"。本章记录实际建成的代码和两者之间的差异。

### 15.1 代码规模

```
~/.pi/agent/extensions/pi-kb/
├── index.ts          574 行  — Pi 扩展入口（生命周期 + 16 工具注册 + /kb 命令）
├── kb_tools.ts       970 行  — 16 个工具逻辑 + LLM dedup/rerank/时间加权
├── kb_system.ts      133 行  — 独立 KB 工厂（可脱离 pi 运行）
├── node_index.ts     559 行  — 内存索引 + 关键词搜索 + 生命周期 + halflife
├── link_graph.ts     365 行  — 邻接表 + BFS/反向BFS + ripple 传播
├── storage.ts        610 行  — MD 读写 + 递归 YAML parser + auto-log
├── types.ts          260 行  — 类型系统 + 配置常量
├── run_tests.cjs     667 行  — 统一测试入口
└── README.md

总计: ~4100 行 TypeScript + 103 个测试 (4 套件, 0 failures)
```

### 15.2 16 个工具

| 工具 | 分类 | 设计对应 |
|------|------|---------|
| `kb_retrieve` | 查询 | 原则 8.1-8.3（检索原子性、深度预算、完备性报告） |
| `kb_list_stale` | 查询 | 原则 13.3 场景 13（stale 聚合报告） |
| `kb_graph` | 查询 | 13.9 场景 10（图谱可视化） |
| `kb_record_observation` | 创建 | 原则 13.1 场景 1（双层 observation） |
| `kb_update_observation` | 更新 | 原则 13.3 场景 12（自修正窗口） |
| `kb_create_reflection` | 创建 | 原则 13.8（Reflection 幂等性 + 信息密度） |
| `kb_create_insight` | 创建 | 原则 1.2（去重）+ 13.3 场景 11（时间加权） |
| `kb_update_insight` | 更新 | 原则 2.2（ripple 传播） |
| `kb_add_evidence` | 更新 | — |
| `kb_link` | 链接 | 原则 5.2（语义分类）+ 13.7 场景 28（前向引用） |
| `kb_create_contradiction` | 矛盾 | 原则 6.1（矛盾保留） |
| `kb_resolve_contradiction` | 矛盾 | 原则 13.4 场景 17（矛盾解决协议） |
| `kb_deprecate_node` | 更新 | 13.9 场景 4（独立废弃） |
| `kb_create_moc` | 组织 | 原则 4.2（可组合） |
| `kb_add_to_moc` | 组织 | — |
| `kb_re_reflect` | 反思 | 原则 13.8 场景 30 |

### 15.3 设计 vs 实现的差异

| 设计文档 | 实际实现 | 说明 |
|---------|---------|------|
| 双层 observation（Layer 0 自动 + Layer 1 标注） | Layer 0 已实现（auto-log），Layer 1 已实现（kb_record_observation），但两者之间没有显式关联 UI | Agent 需手动引用 auto-log 中的 session ID |
| Reflection 质量阈值 0.02 | 硬编码为 0.02 | 未经校准 |
| 证据时间加权公式 70/30 混合 | 已实现 | 未经校准 |
| Halflife 天数（90/60/14 等） | 使用 types.ts 中的 DOMAIN_HALFLIFE_DAYS，通过环境变量 PIKB_REFLECTION_THRESHOLD 可配 | halflife 天数本身不可通过环境变量配置 |
| 并发写入安全 | 未实现 | 标记为已知限制，通过 session_start 全量 rebuild 兜底 |
| 嵌入模型 | LLM 去重/rerank | 通过 PIKB_LLM_MODEL 环境变量可配，默认 Haiku |
| Python 实现 | TypeScript（Pi 扩展） | 贴合 pi 生态 |

### 15.4 已知限制

- **并发写入**：两个 pi 实例同时操作同一 KB 会导致索引不一致（下次 session_start 修复）
- **Obsidian 拖拽链接**：在 Obsidian 中修改正文 `[[...]]` 不会同步到系统索引
- **Halflife 不可配**：各 domain 的半衰期天数是代码常量，无环境变量覆盖
- **YAML parser**：仅处理一层嵌套（数组嵌套对象），不支持多层嵌套、多行字符串字面量
- **无批量操作**：每次只能创建一个节点
- **无导出/导入**：KB 数据仅以 MD 文件形式存在，无 JSON 导出
- **Reflection 内容解析**：reflection 的 content 字段包含整个 MD body（含 Sources 章节），而非纯文本

### 15.5 测试覆盖

| 套件 | 测试数 | 覆盖内容 |
|------|--------|---------|
| LinkGraph | ~20 | addLink, BFS, reverseBFS, ripple, pending/expired, JSON roundtrip |
| kb_tools | ~40 | recordObservation, updateObservation, createInsight, updateInsight, retrieve, addEvidence, createLink, createContradiction, resolveContradiction, deprecateNode, createMoc, addToMoc, reReflect, adjustConfidenceByEvidenceAge, llmDedup, llmRerank |
| NodeIndex | ~25 | search, filterByScope, rank, advanceLifecycles, checkHalflives, markStale, touch, aggregateStale, consistencyCheck |
| Storage + KBSystem | ~18 | 5 种节点类型 roundtrip, skeleton 解析, auto-log, metadata, KBSystem factory |

### 15.6 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ANTHROPIC_API_KEY` | — | LLM 去重/rerank 所需。未设置时降级为纯关键词 |
| `PIKB_LLM_MODEL` | `claude-haiku-3-5-20241022` | 去重/rerank 使用的模型 |
| `PIKB_REFLECTION_THRESHOLD` | `10` | 触发 reflection 提醒的 observation 数量 |
