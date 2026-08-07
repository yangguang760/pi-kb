/**
 * pi-kb: Extension entry point
 *
 * Tool logic extracted to kb_tools.ts for testability.
 * This file handles pi lifecycle events and tool registration only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { KBStorage } from "./storage";
import { NodeIndex } from "./node_index";
import { LinkGraph } from "./link_graph";
import { REFLECTION_THRESHOLD } from "./types";
import {
  recordObservation,
  updateObservation,
  createReflection,
  createInsight,
  updateInsight,
  retrieve,
  addEvidence,
  createLink,
  createContradiction,
  resolveContradiction,
  deprecateNode,
  createMoc,
  addToMoc,
  reReflect,
  type ToolContext,
  type LLMCaller,
} from "./kb_tools";
import type { Domain, LinkType, NodeSkeleton, KBNode, ObservationNode, InsightNode } from "./types";

// ─── Constants ────────────────────────────────────────────────

const SELF_CORRECTION_WINDOW_MS = 60 * 60 * 1000;
const PENDING_LINK_TIMEOUT_MS = 48 * 60 * 60 * 1000;
const LLM_DEDUP_TIMEOUT_MS = 5000;
const REFLECTION_QUALITY_THRESHOLD = 0.02;
const KB_SIZE_WARNING_THRESHOLD = 5000;
const KB_SIZE_CRITICAL_THRESHOLD = 10000;
const LLM_DEDUP_MODEL =
  process.env.PIKB_LLM_MODEL || "claude-haiku-3-5-20241022";

export default async function (pi: ExtensionAPI) {
  const kbRoot = resolve(process.cwd(), ".pi/kb");
  const storage = new KBStorage(kbRoot);
  await storage.ensure();

  let nodeIndex: NodeIndex;
  let sessionId: string | null = null;

  // LLM Caller (injectable for testing)
  const llmCaller: LLMCaller = {
    async call(opts) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return null;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LLM_DEDUP_TIMEOUT_MS);
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: LLM_DEDUP_MODEL,
            max_tokens: 256,
            temperature: 0,
            system: opts.system,
            messages: [{ role: "user", content: opts.prompt }],
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`API ${response.status}`);
        const data = (await response.json()) as {
          content: Array<{ type: string; text: string }>;
        };
        return data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      } finally {
        clearTimeout(timeout);
      }
    },
  };

  function getCtx(): ToolContext {
    return {
      nodeIndex: nodeIndex!,
      storage,
      sessionId,
      kbRoot,
      llmCaller,
      config: {
        selfCorrectionWindowMs: SELF_CORRECTION_WINDOW_MS,
        pendingLinkTimeoutMs: PENDING_LINK_TIMEOUT_MS,
        reflectionQualityThreshold: REFLECTION_QUALITY_THRESHOLD,
        llmDedupModel: LLM_DEDUP_MODEL,
      },
    };
  }

  // ─── Session Start ──────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    sessionId = `session-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    nodeIndex = new NodeIndex(storage);

    const { loaded, errors } = await nodeIndex.rebuild();
    const sync = await nodeIndex.sync();
    if (sync.added.length > 0)
      ctx.ui.notify(`KB: ${sync.added.length} new nodes`, "info");
    if (sync.modified.length > 0)
      ctx.ui.notify(`KB: ${sync.modified.length} modified externally`, "warning");
    if (sync.deleted.length > 0)
      ctx.ui.notify(`KB: ${sync.deleted.length} removed externally`, "warning");

    const expiredLinks = nodeIndex.graph.expirePendingLinks(PENDING_LINK_TIMEOUT_MS);
    if (expiredLinks.length > 0)
      ctx.ui.notify(`KB: ${expiredLinks.length} pending links expired`, "info");

    // Lifecycle + contradiction escalation
    const lc = nodeIndex.advanceLifecycles();
    if (lc.contradictionEscalations.length > 0) {
      for (const cid of lc.contradictionEscalations) {
        const contra = await storage.readNode(cid);
        if (!contra || contra.type !== "contradiction") continue;
        const node = contra as import("./types").ContradictionNode;
        const ageDays = (Date.now() - node.created_at) / (1000 * 60 * 60 * 24);
        if (node.contradiction_state === "unresolved" && ageDays >= 90)
          node.contradiction_state = "dormant";
        else if (node.contradiction_state === "unresolved" && ageDays >= 30)
          node.contradiction_state = "chronic";
        else if (node.contradiction_state === "chronic" && ageDays >= 90)
          node.contradiction_state = "dormant";
        node.changelog.push({
          timestamp: Date.now(), actor: "system",
          action: "contradiction_escalated",
          detail: `${node.contradiction_state} after ${Math.round(ageDays)} days`,
        });
        await storage.writeNode(node);
      }
      ctx.ui.notify(`KB: ${lc.contradictionEscalations.length} contradiction escalations`, "info");
    }

    const totalLc = lc.toStable.length + lc.toStale.length + lc.toArchived.length + lc.toDead.length;
    if (totalLc > 0) {
      const parts: string[] = [];
      if (lc.toStable.length) parts.push(`${lc.toStable.length}→stable`);
      if (lc.toStale.length) parts.push(`${lc.toStale.length}→stale`);
      if (lc.toArchived.length) parts.push(`${lc.toArchived.length}→archived`);
      if (lc.toDead.length) parts.push(`${lc.toDead.length}→dead`);
      ctx.ui.notify(`KB lifecycle: ${parts.join(", ")}`, "info");
    }

    const hlWarnings = nodeIndex.checkHalflives();
    const critical = hlWarnings.filter((h) => h.isCritical);
    if (critical.length > 0)
      ctx.ui.notify(`KB: ${critical.length} nodes critically stale`, "warning");

    if (nodeIndex.size > KB_SIZE_CRITICAL_THRESHOLD)
      ctx.ui.notify(`KB: ${nodeIndex.size} nodes — CRITICAL`, "error");
    else if (nodeIndex.size > KB_SIZE_WARNING_THRESHOLD)
      ctx.ui.notify(`KB: ${nodeIndex.size} nodes — large`, "warning");

    const meta = await storage.readMeta();

    // Recalculate actual unreflected count (don't trust stale counter in meta)
    let actualUnreflected = 0;
    for (const skel of nodeIndex.getAllSkeletons()) {
      if (skel.type !== "observation") continue;
      if (skel.status === "dead" || skel.status === "archived") continue;
      const hasReflection = nodeIndex.graph
        .getIncoming(skel.id)
        .some((l) => l.type === "supported_by" && l.status === "active");
      if (!hasReflection) actualUnreflected++;
    }
    if (meta.reflection_triggers.unreflected_observations !== actualUnreflected) {
      meta.reflection_triggers.unreflected_observations = actualUnreflected;
      await storage.writeMeta(meta);
    }
    const unreflected = actualUnreflected;
    if (unreflected >= REFLECTION_THRESHOLD) {
      pi.sendMessage({
        customType: "kb-reflection-reminder",
        content: `[KB] ${unreflected} unreflected (threshold: ${REFLECTION_THRESHOLD}). Consider reflecting.`,
        display: true,
      });
    }

    const staleAgg = nodeIndex.aggregateStale();
    if (staleAgg.length > 0) {
      const summary = staleAgg.slice(0, 3).map((s) => `${s.domain}:${s.count}`).join(", ");
      ctx.ui.notify(`KB: ${loaded} nodes (stale: ${summary}${staleAgg.length > 3 ? "..." : ""})`, "info");
    } else {
      ctx.ui.notify(`KB: ${loaded} nodes`, "info");
    }
    if (errors.length > 0) ctx.ui.notify(`KB: ${errors.length} parse errors`, "warning");
    ctx.ui.setStatus("kb", `KB: ${nodeIndex.size} nodes`);

    if (nodeIndex.size === 0)
      ctx.ui.notify(`KB ready. Auto-logs: ${kbRoot}/logs/`, "info");
  });

  // ─── before_agent_start: Inject KB context ────────────

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!nodeIndex || nodeIndex.size === 0) return;
    const staleAgg = nodeIndex.aggregateStale();
    const hlWarnings = nodeIndex.checkHalflives();
    const criticalHl = hlWarnings.filter((h) => h.isCritical).length;
    const meta = await storage.readMeta();
    const unreflected = meta.reflection_triggers.unreflected_observations;
    const parts: string[] = [`KB: ${nodeIndex.size} nodes`];
    if (staleAgg.length > 0) {
      parts.push(`stale: ${staleAgg.slice(0, 3).map((s) => `${s.domain}(${s.count})`).join(", ")}`);
    }
    if (criticalHl > 0) parts.push(`${criticalHl} critically stale`);
    if (unreflected >= REFLECTION_THRESHOLD) parts.push(`⚠ ${unreflected} unreflected`);
    parts.push("use kb_retrieve to search");
    return {
      message: {
        customType: "kb-context",
        content: `[KB Status] ${parts.join(" | ")}`,
        display: true,
      },
    };
  });

  // ─── Path Guard ─────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const targetPath = resolve(ctx.cwd, (event.input as { path?: string }).path || "");
      if (targetPath.startsWith(kbRoot)) {
        return { block: true, reason: `知识库目录仅可通过 kb_* 工具操作。` };
      }
    }
  });

  // ─── Auto-log ──────────────────────────────────────────

  pi.on("agent_end", async (event, _ctx) => {
    if (!sessionId) return;
    for (const msg of event.messages || []) {
      if (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult") {
        const text = extractText(msg);
        if (text) {
          await storage.appendAutoLog(sessionId, {
            role: msg.role === "toolResult" ? "tool_result" : msg.role,
            content: text.slice(0, msg.role === "assistant" ? 2000 : msg.role === "toolResult" ? 1000 : 5000),
            timestamp: msg.timestamp || Date.now(),
          });
        }
      }
    }
    const meta = await storage.readMeta();
    if (meta.reflection_triggers.unreflected_observations >= REFLECTION_THRESHOLD) {
      pi.sendUserMessage(
        `[KB] ${meta.reflection_triggers.unreflected_observations} unreflected (threshold: ${REFLECTION_THRESHOLD}).`,
        { deliverAs: "followUp" }
      );
    }
  });

  pi.on("session_shutdown", async () => { sessionId = null; });

  // ─── /kb command ───────────────────────────────────────

  pi.registerCommand("kb", {
    description: "知识库: status, list, search, stale, graph, config",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["status", "list", "search", "stale", "graph", "config", "help"];
      const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (!nodeIndex) { ctx.ui.notify("KB not ready", "warning"); return; }
      const [sub, ...rest] = (args || "").split(/\s+/);
      const restStr = rest.join(" ");

      switch (sub) {
        case "status": {
          const meta = await storage.readMeta();
          const staleAgg = nodeIndex.aggregateStale();
          ctx.ui.notify(
            `KB: ${nodeIndex.size} nodes, ${staleAgg.length} stale domains, ${meta.reflection_triggers.unreflected_observations} unreflected`,
            "info"
          );
          break;
        }
        case "list": {
          const domain = restStr || undefined;
          const skeletons = nodeIndex.getAllSkeletons()
            .filter((s) => !domain || s.domain === domain)
            .slice(0, 20);
          if (skeletons.length === 0) {
            ctx.ui.notify("No nodes", "info");
          } else {
            ctx.ui.notify(
              skeletons.map((s) => `[[${s.id}]] ${s.title} (${s.type}, ${s.status})`).join("\n"),
              "info"
            );
          }
          break;
        }
        case "search": {
          const results = nodeIndex.search(restStr);
          if (results.length === 0) {
            ctx.ui.notify("No results", "info");
          } else {
            ctx.ui.notify(
              results.slice(0, 10).map((r) => `[[${r.nodeId}]] ${r.skeleton.title}`).join("\n"),
              "info"
            );
          }
          break;
        }
        case "stale": {
          const aggs = nodeIndex.aggregateStale();
          if (aggs.length === 0) ctx.ui.notify("No stale nodes", "info");
          else ctx.ui.notify(aggs.map((a) => `${a.domain}: ${a.count}`).join("\n"), "info");
          break;
        }
        case "graph": {
          if (!restStr) { ctx.ui.notify("Usage: /kb graph <nodeId>", "warning"); return; }
          const out = nodeIndex.graph.getOutgoing(restStr);
          const incoming = nodeIndex.graph.getIncoming(restStr);
          const lines: string[] = [`Graph for [[${restStr}]]:`];
          if (incoming.length) {
            lines.push("Incoming:");
            incoming.forEach((l) => lines.push(`  ← [[${l.from}]] (${l.type})`));
          }
          if (out.length) {
            lines.push("Outgoing:");
            out.forEach((l) => lines.push(`  → [[${l.to}]] (${l.type})`));
          }
          if (!incoming.length && !out.length) lines.push("No links");
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
        case "config":
          ctx.ui.notify(
            `KB Config:\n  Threshold: ${REFLECTION_THRESHOLD}\n  LLM model: ${LLM_DEDUP_MODEL}\n  Self-correct window: ${SELF_CORRECTION_WINDOW_MS / 60000}min\n  Pending timeout: ${PENDING_LINK_TIMEOUT_MS / 3600000}h\n  Root: ${kbRoot}`,
            "info"
          );
          break;
        case "help":
        default:
          ctx.ui.notify(
            "Usage: /kb [status|list|search|stale|graph|config]\n  status — overview\n  list [domain] — list nodes\n  search <q> — search\n  stale — stale domains\n  graph <id> — link graph\n  config — settings",
            "info"
          );
      }
    },
  });

  // ══════════════════════════════════════════════════════════
  //  Tools — delegates to kb_tools.ts
  // ══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "kb_retrieve", label: "KB Retrieve",
    description: "Search the knowledge base. Supports pagination via offset.",
    promptSnippet: "Search the knowledge base",
    promptGuidelines: ["使用 kb_retrieve 检索记忆。stale 节点可能过时。scope=deep 含历史数据。offset 翻页。"],
    parameters: Type.Object({
      query: Type.String(),
      scope: Type.Optional(StringEnum(["routine", "deep", "forensic"] as const)),
      domain: Type.Optional(Type.String()),
      type: Type.Optional(StringEnum(["observation", "reflection", "insight", "contradiction", "moc"] as const)),
      maxResults: Type.Optional(Type.Number()),
      expandLinks: Type.Optional(Type.Boolean()),
      offset: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) { return retrieve(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_list_stale", label: "KB List Stale",
    description: "列出 stale 节点，按 domain 聚合。",
    promptSnippet: "List stale nodes",
    parameters: Type.Object({ topDomains: Type.Optional(Type.Number()) }),
    async execute(_id, params) {
      if (!nodeIndex) return { content: [{ type: "text", text: "索引未初始化。" }], details: {} };
      const topN = params.topDomains || 5;
      const aggs = nodeIndex.aggregateStale();
      if (aggs.length === 0) return { content: [{ type: "text", text: "✅ 没有 stale 节点。" }], details: {} };
      const lines = ["⚠ 待复审：", ""];
      for (const agg of aggs.slice(0, topN)) {
        lines.push(`- **${agg.domain}**: ${agg.count} 个`);
        for (const id of agg.nodeIds.slice(0, 5)) {
          const s = nodeIndex.getSkeleton(id);
          if (s) lines.push(`  - [[${id}]] ${s.title}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { aggs } };
    },
  });

  pi.registerTool({
    name: "kb_graph", label: "KB Graph",
    description: "查看节点的链接图谱。",
    promptSnippet: "View link graph around a node",
    parameters: Type.Object({ nodeId: Type.String(), depth: Type.Optional(Type.Number()) }),
    async execute(_id, params) {
      if (!nodeIndex) return { content: [{ type: "text", text: "索引未初始化。" }], details: {} };
      if (!nodeIndex.has(params.nodeId)) return { content: [{ type: "text", text: `❌ [[${params.nodeId}]] 不存在。` }], details: {} };
      const skel = nodeIndex.getSkeleton(params.nodeId)!;
      const depth = params.depth || 2;
      const outgoing = nodeIndex.graph.getOutgoing(params.nodeId);
      const incoming = nodeIndex.graph.getIncoming(params.nodeId);
      const bfs = nodeIndex.graph.bfs(params.nodeId, depth);
      const lines = [`## [[${params.nodeId}]] **${skel.title}** (${skel.type}, ${skel.domain})`, ""];
      if (incoming.length) {
        lines.push("### 入链");
        incoming.forEach((l) => { const s = nodeIndex.getSkeleton(l.from); lines.push(`- [[${l.from}]] ${s?.title || "?"} (${l.type})`); });
      }
      if (outgoing.length) {
        lines.push("### 出链");
        outgoing.forEach((l) => { const s = nodeIndex.getSkeleton(l.to); lines.push(`- [[${l.to}]] ${s?.title || "?"} (${l.type})`); });
      }
      if (outgoing.length === 1 && incoming.length === 1) lines.push("", "⚠ 退化节点（一进一出）。");
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  pi.registerTool({
    name: "kb_record_observation", label: "KB Record Observation",
    description: "记录 observation。",
    promptSnippet: "Record an observation",
    promptGuidelines: ["值得长期记忆的信息用此工具记录。评估 significance。"],
    parameters: Type.Object({
      content: Type.String(),
      significance: StringEnum(["high", "medium", "low"] as const),
      domain: StringEnum(["user-preference", "user-behavior", "user-identity", "project-status", "project-decision", "agent-self-knowledge", "external-fact"] as const),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) { return recordObservation(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_update_observation", label: "KB Update Observation",
    description: "修正 observation（1h 窗口）。",
    promptSnippet: "Correct an observation",
    parameters: Type.Object({
      id: Type.String(), content: Type.Optional(Type.String()),
      significance: Type.Optional(StringEnum(["high", "medium", "low"] as const)),
      reason: Type.String(),
    }),
    async execute(_id, params) { return updateObservation(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_create_reflection", label: "KB Create Reflection",
    description: "创建 reflection。",
    promptSnippet: "Create a reflection",
    promptGuidelines: ["总结近期 observations 的模式和趋势。聚焦于实质性归纳。sources 必须填写被总结的所有 observation ID。"],
    parameters: Type.Object({
      period: Type.String(), content: Type.String(),
      sources: Type.Array(Type.String()),
      previous_reflection: Type.Optional(Type.String()),
    }),
    async execute(_id, params) { return createReflection(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_create_insight", label: "KB Create Insight",
    description: "创建 insight（自动去重+时间加权）。",
    promptSnippet: "Create an insight",
    promptGuidelines: ["每个 insight 一个 statement。sources 必须填写。"],
    parameters: Type.Object({
      title: Type.String(), statement: Type.String(),
      confidence: Type.Number(), sources: Type.Array(Type.String()),
      domain: StringEnum(["user-preference", "user-behavior", "user-identity", "project-status", "project-decision", "agent-self-knowledge", "external-fact"] as const),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) { return createInsight(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_update_insight", label: "KB Update Insight",
    description: "更新 insight（ripple 传播）。",
    promptSnippet: "Update an insight",
    parameters: Type.Object({
      id: Type.String(), statement: Type.Optional(Type.String()),
      confidence: Type.Optional(Type.Number()),
      addSources: Type.Optional(Type.Array(Type.String())),
      reason: Type.String(),
    }),
    async execute(_id, params) { return updateInsight(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_add_evidence", label: "KB Add Evidence",
    description: "向 insight 追加 evidence。",
    parameters: Type.Object({ insightId: Type.String(), sourceId: Type.String(), newConfidence: Type.Optional(Type.Number()) }),
    async execute(_id, params) { return addEvidence(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_link", label: "KB Link",
    description: "建立语义链接（支持 pending）。",
    promptSnippet: "Create a link between nodes",
    parameters: Type.Object({
      from: Type.String(), to: Type.String(),
      type: StringEnum(["supported_by", "related_to", "parent_of", "child_of", "contradicts", "precedes", "follows", "evolved_from", "deprecated_by", "alternative_view"] as const),
      context: Type.Optional(Type.String()),
    }),
    async execute(_id, params) { return createLink(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_create_contradiction", label: "KB Create Contradiction",
    description: "创建矛盾节点。",
    parameters: Type.Object({ title: Type.String(), nodeA: Type.String(), nodeB: Type.String(), severity: StringEnum(["surface", "substantial"] as const), description: Type.Optional(Type.String()) }),
    async execute(_id, params) { return createContradiction(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_resolve_contradiction", label: "KB Resolve Contradiction",
    description: "解决矛盾，创建新 insight。",
    parameters: Type.Object({ contradictionId: Type.String(), resolution: Type.String(), newInsightTitle: Type.String(), newInsightStatement: Type.String(), newConfidence: Type.Number(), domain: StringEnum(["user-preference", "user-behavior", "user-identity", "project-status", "project-decision", "agent-self-knowledge", "external-fact"] as const) }),
    async execute(_id, params) { return resolveContradiction(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_deprecate_node", label: "KB Deprecate Node",
    description: "废弃节点。",
    promptSnippet: "Deprecate a node",
    parameters: Type.Object({ oldNodeId: Type.String(), newNodeId: Type.String(), reason: Type.String() }),
    async execute(_id, params) { return deprecateNode(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_create_moc", label: "KB Create MOC",
    description: "创建 MOC。",
    promptSnippet: "Create a MOC",
    parameters: Type.Object({ title: Type.String(), description: Type.Optional(Type.String()), childNodes: Type.Optional(Type.Array(Type.String())), domain: StringEnum(["user-preference", "user-behavior", "user-identity", "project-status", "project-decision", "agent-self-knowledge", "external-fact"] as const) }),
    async execute(_id, params) { return createMoc(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_add_to_moc", label: "KB Add to MOC",
    description: "向 MOC 追加。",
    parameters: Type.Object({ mocId: Type.String(), nodeId: Type.String() }),
    async execute(_id, params) { return addToMoc(getCtx(), params); },
  });

  pi.registerTool({
    name: "kb_re_reflect", label: "KB Re-reflect",
    description: "二次反思。",
    parameters: Type.Object({ previousReflectionId: Type.String(), content: Type.String() }),
    async execute(_id, params) { return reReflect(getCtx(), params); },
  });

  // ─── Helpers ────────────────────────────────────────────

  function skeletonFromNode(node: KBNode): NodeSkeleton {
    const snippet =
      node.type === "observation" ? (node as ObservationNode).content.slice(0, 200)
      : node.type === "insight" ? (node as InsightNode).statement.slice(0, 200)
      : node.type === "reflection" ? (node as import("./types").ReflectionNode).content?.slice(0, 200) || ""
      : node.type === "contradiction" ? `[${(node as import("./types").ContradictionNode).contradiction_state}]`
      : (node as import("./types").MocNode).description?.slice(0, 200) || "";
    return {
      id: node.id, type: node.type, title: node.title, status: node.status,
      created_by: node.created_by, domain: node.domain,
      created_at: node.created_at, updated_at: node.updated_at,
      last_verified: node.last_verified, last_touched: node.last_touched,
      tags: node.tags, snippet: snippet.replace(/\n/g, " "),
    };
  }
}

function extractText(msg: { content?: unknown }): string {
  if (!msg.content) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text" || b.type === "text_delta")
      .map((b) => b.text || "").join("\n");
  }
  return String(msg.content);
}
