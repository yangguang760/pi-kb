# pi-kb

Reflection 流 × 双链 MD 知识库 —— pi coding agent 的长期记忆系统。

## 设计理念

基于 **Reflection 流**（经验归纳）的认知架构，以 **双链 Markdown**（Obsidian/Roam/Logseq 风格）为知识组织形式。

```
Observation (原始观察) → Reflection (反思总结) → Insight (长期洞察) → MOC (主题索引)
```

4 层渐进式知识演化，配合 16 个结构化工具，实现完整的记忆生命周期管理。

详见 [`reflection-双链md-知识体系设计原则.md`](../reflection-双链md-知识体系设计原则.md)。

## 安装

扩展位于 `~/.pi/agent/extensions/pi-kb/`，pi 启动时自动加载。

```bash
pi          # 自动加载
pi -e ~/.pi/agent/extensions/pi-kb/index.ts  # 显式加载
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ANTHROPIC_API_KEY` | — | LLM 去重/rerank 所需（未设置时降级为纯关键词） |
| `PIKB_LLM_MODEL` | `claude-haiku-3-5-20241022` | 去重/rerank 使用的模型 |
| `PIKB_REFLECTION_THRESHOLD` | `10` | 触发 reflection 提醒的 observation 数量 |

## 工具列表

### 创建

| 工具 | 说明 |
|------|------|
| `kb_record_observation` | 记录原始观察 |
| `kb_create_reflection` | 创建反思（幂等性保护） |
| `kb_create_insight` | 创建洞察（LLM 去重 + 时间加权） |
| `kb_create_contradiction` | 创建矛盾节点 |
| `kb_create_moc` | 创建 MOC 聚合节点 |

### 查询

| 工具 | 说明 |
|------|------|
| `kb_retrieve` | 检索（关键词 + BFS 展开 + LLM rerank + 分页） |
| `kb_list_stale` | 列出待复审的陈旧节点 |
| `kb_graph` | 查看节点的链接图谱 |

### 更新

| 工具 | 说明 |
|------|------|
| `kb_update_observation` | 修正观察（1h 自修正窗口） |
| `kb_update_insight` | 更新洞察（ripple 传播） |
| `kb_add_evidence` | 向洞察追加证据 |
| `kb_deprecate_node` | 废弃节点 |

### 链接

| 工具 | 说明 |
|------|------|
| `kb_link` | 建立语义链接（支持 pending） |
| `kb_resolve_contradiction` | 解决矛盾 |
| `kb_add_to_moc` | 向 MOC 追加子节点 |
| `kb_re_reflect` | 二次反思 |

## 命令

```
/kb status          — KB 状态概览
/kb list [domain]   — 列出节点
/kb search <query>  — 关键词搜索
/kb stale           — 列出陈旧 domain
/kb graph <nodeId>  — 查看节点图谱
/kb config          — 查看配置
/kb help            — 帮助
```

## 独立使用（脱离 pi）

```typescript
import { createKBSystem } from "./kb_system";

const kb = await createKBSystem("/path/to/kb");
const result = await kb.initialize();
// result.nodesLoaded, result.staleNodeCount, ...

// 直接操作
const id = kb.storage.generateId();
await kb.storage.writeNode({ ... });
await kb.nodeIndex.search("keyword");

await kb.shutdown();
```

## 测试

```bash
node run_tests.cjs
```

4 个套件，142 个测试，覆盖 LinkGraph、kb_tools、NodeIndex、Storage + KBSystem。

## 架构

```
index.ts          — Pi 扩展入口（生命周期 + 16 工具注册）
kb_tools.ts       — 所有工具逻辑（可注入测试）
kb_system.ts      — 独立 KB 工厂
node_index.ts     — 内存索引 + 搜索 + 生命周期
link_graph.ts     — 链接图 + BFS + ripple 传播
storage.ts        — MD 读写 + 递归 YAML parser + auto-log
types.ts          — 类型系统 + 配置常量
```
