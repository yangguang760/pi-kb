/**
 * pi-kb: Tool implementations
 *
 * Extracted from index.ts to make each tool independently testable.
 * Each tool function receives the shared state (nodeIndex, storage, sessionId)
 * and returns the standard tool result shape.
 */

import type { KBStorage } from "./storage";
import type { NodeIndex } from "./node_index";
import type {
  RetrieveScope,
  Domain,
  NodeType,
  NodeStatus,
  LinkType,
  KBNode,
  NodeSkeleton,
  ObservationNode,
  ReflectionNode,
  InsightNode,
  ContradictionNode,
  MocNode,
  KBMeta,
} from "./types";
import {
  RETRIEVAL_DEFAULTS,
  DOMAIN_HALFLIFE_DAYS,
} from "./types";

// ─── Shared Context ───────────────────────────────────────────

export interface ToolContext {
  nodeIndex: NodeIndex;
  storage: KBStorage;
  sessionId: string | null;
  kbRoot: string;
  /** LLM dedup/rerank caller — injected so tests can mock it */
  llmCaller: LLMCaller;
  /** Environment config */
  config: {
    selfCorrectionWindowMs: number;
    pendingLinkTimeoutMs: number;
    reflectionQualityThreshold: number;
    llmDedupModel: string;
  };
}

export interface LLMCaller {
  call(opts: { system: string; prompt: string }): Promise<string | null>;
}

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

function notReady(): ToolResult {
  return {
    content: [{ type: "text", text: "知识库索引尚未初始化。" }],
    details: { error: "index_not_ready" },
  };
}

function skeletonFromNode(node: KBNode): NodeSkeleton {
  const snippet =
    node.type === "observation" ? (node as ObservationNode).content.slice(0, 200)
    : node.type === "insight" ? (node as InsightNode).statement.slice(0, 200)
    : node.type === "reflection" ? (node as ReflectionNode).content?.slice(0, 200) || ""
    : node.type === "contradiction" ? `[${(node as ContradictionNode).contradiction_state}]`
    : (node as MocNode).description?.slice(0, 200) || "";

  return {
    id: node.id, type: node.type, title: node.title, status: node.status,
    created_by: node.created_by, domain: node.domain,
    created_at: node.created_at, updated_at: node.updated_at,
    last_verified: node.last_verified, last_touched: node.last_touched,
    tags: node.tags, snippet: snippet.replace(/\n/g, " "),
  };
}

// ══════════════════════════════════════════════════════════════
//  kb_record_observation
// ══════════════════════════════════════════════════════════════

export async function recordObservation(
  ctx: ToolContext,
  params: {
    content: string;
    significance: string;
    domain: string;
    tags?: string[];
  }
): Promise<ToolResult> {
  const { nodeIndex, storage, sessionId } = ctx;
  if (!nodeIndex) return notReady();

  const id = storage.generateId();
  const now = Date.now();
  const sourceLogRef = sessionId ? `[[${sessionId}]]` : "";

  const node: ObservationNode = {
    id, type: "observation",
    title: params.content.slice(0, 80),
    status: "active", created_by: "agent",
    created_at: now, updated_at: now,
    last_verified: now, last_touched: now,
    domain: params.domain as Domain,
    tags: params.tags || [],
    changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "" }],
    source_log: sourceLogRef,
    content: params.content,
    significance: params.significance as "high" | "medium" | "low",
  };

  await storage.writeNode(node);
  nodeIndex.addSkeleton(skeletonFromNode(node));

  const meta = await storage.readMeta();
  meta.reflection_triggers.unreflected_observations++;
  meta.total_nodes = nodeIndex.size;
  const pending = meta.reflection_triggers.domains_with_pending;
  if (!pending.includes(node.domain)) pending.push(node.domain);
  await storage.writeMeta(meta);

  let msg = `✅ 已创建 observation [[${id}]]`;
  msg += `\n未反思: ${meta.reflection_triggers.unreflected_observations}/${meta.reflection_triggers.threshold}`;
  if (meta.reflection_triggers.unreflected_observations >= meta.reflection_triggers.threshold) {
    msg += `\n⚠ 已达到 reflection 阈值。`;
  }

  return { content: [{ type: "text", text: msg }], details: { id, type: "observation" } };
}

// ══════════════════════════════════════════════════════════════
//  kb_update_observation
// ══════════════════════════════════════════════════════════════

export async function updateObservation(
  ctx: ToolContext,
  params: {
    id: string;
    content?: string;
    significance?: string;
    reason: string;
  }
): Promise<ToolResult> {
  const { nodeIndex, storage, config } = ctx;
  if (!nodeIndex) return notReady();

  const existing = await storage.readNode(params.id);
  if (!existing || existing.type !== "observation") {
    return { content: [{ type: "text", text: `❌ [[${params.id}]] 不存在或不是 observation。` }], details: {} };
  }

  const now = Date.now();
  const age = now - existing.created_at;
  if (existing.created_by === "agent" && age > config.selfCorrectionWindowMs) {
    return {
      content: [{
        type: "text",
        text: `❌ 自修正窗口已关闭（${Math.round(age / 60000)} 分钟前，窗口: ${config.selfCorrectionWindowMs / 60000} 分钟）。\n请创建新的 observation 来补充。`,
      }],
      details: { blocked: true, reason: "self_correction_window_expired" },
    };
  }

  const node = existing as ObservationNode;
  if (params.content !== undefined) node.content = params.content;
  if (params.significance !== undefined) node.significance = params.significance as "high" | "medium" | "low";
  node.updated_at = now;
  node.changelog.push({
    timestamp: now, actor: "agent", action: "corrected",
    detail: params.reason,
  });

  await storage.writeNode(node);
  nodeIndex.updateSkeleton(params.id, {
    updated_at: now,
    snippet: (params.content || node.content).slice(0, 200).replace(/\n/g, " "),
  });

  return {
    content: [{ type: "text", text: `✅ 已修正 observation [[${params.id}]]` }],
    details: { id: params.id },
  };
}

// ══════════════════════════════════════════════════════════════
//  kb_create_reflection
// ══════════════════════════════════════════════════════════════

export async function createReflection(
  ctx: ToolContext,
  params: {
    period: string;
    content: string;
    sources: string[];
    previous_reflection?: string;
  }
): Promise<ToolResult> {
  const { nodeIndex, storage, config } = ctx;
  if (!nodeIndex) return notReady();

  const alreadyPrimary: string[] = [];
  const primarySources: string[] = [];
  for (const srcId of params.sources) {
    if (!nodeIndex.has(srcId)) continue;
    const backlinks = nodeIndex.graph.getIncoming(srcId);
    const alreadyReflected = backlinks.some(
      (l) => l.type === "supported_by" && l.status === "active"
    );
    if (alreadyReflected) alreadyPrimary.push(srcId);
    else primarySources.push(srcId);
  }

  const approxTokens = params.content.length * 0.25;
  const density = primarySources.length / Math.max(approxTokens, 1);
  const quality =
    density >= config.reflectionQualityThreshold * 2 ? "high"
    : density >= config.reflectionQualityThreshold ? "medium"
    : "low";

  const now = Date.now();
  const id = storage.generateId();

  const node: ReflectionNode = {
    id, type: "reflection",
    title: `Reflection ${params.period}`,
    status: "active", created_by: "agent",
    created_at: now, updated_at: now,
    last_verified: now, last_touched: now,
    domain: "agent-self-knowledge",
    tags: ["reflection"],
    changelog: [{ timestamp: now, actor: "agent", action: "created", detail: `quality=${quality}` }],
    period: params.period,
    content: params.content,
    sources: primarySources,
    secondary_sources: alreadyPrimary,
    previous_reflection: params.previous_reflection,
    quality,
  };

  await storage.writeNode(node);
  nodeIndex.addSkeleton(skeletonFromNode(node));

  for (const srcId of primarySources) {
    nodeIndex.graph.addLink({
      from: id, to: srcId, type: "supported_by",
      status: "active", created_at: now,
      context: `Reflection ${params.period}`,
    });
  }

  if (params.previous_reflection && nodeIndex.has(params.previous_reflection)) {
    nodeIndex.graph.addLink({
      from: id, to: params.previous_reflection, type: "follows",
      status: "active", created_at: now,
    });
  }

  const meta = await storage.readMeta();
  meta.reflection_triggers.unreflected_observations = Math.max(
    0, meta.reflection_triggers.unreflected_observations - primarySources.length
  );
  meta.reflection_triggers.last_reflection_at = now;
  await storage.writeMeta(meta);

  let msg = `✅ 已创建 reflection [[${id}]]\n`;
  msg += `Primary sources: ${primarySources.length}`;
  if (alreadyPrimary.length > 0) msg += `\n⚠ ${alreadyPrimary.length} 个 source 已是 secondary`;
  msg += `\nQuality: ${quality}`;
  if (quality === "low") msg += `\n💡 建议更聚焦于具体观察。`;

  return { content: [{ type: "text", text: msg }], details: { id, quality } };
}

// ══════════════════════════════════════════════════════════════
//  kb_create_insight
// ══════════════════════════════════════════════════════════════

export async function createInsight(
  ctx: ToolContext,
  params: {
    title: string;
    statement: string;
    confidence: number;
    sources: string[];
    domain: string;
    tags?: string[];
  }
): Promise<ToolResult> {
  const { nodeIndex, storage, llmCaller } = ctx;
  if (!nodeIndex) return notReady();

  const missingSources = params.sources.filter((s) => !nodeIndex.has(s));
  if (missingSources.length > 0) {
    return {
      content: [{ type: "text", text: `❌ sources 不存在: ${missingSources.join(", ")}。` }],
      details: { blocked: true, missingSources },
    };
  }

  const now = Date.now();
  const staleSources: string[] = [];
  for (const srcId of params.sources) {
    const skel = nodeIndex.getSkeleton(srcId);
    if (skel && skel.status === "stale") staleSources.push(srcId);
  }

  // LLM dedup
  const dedup = await llmDedup(ctx, params.statement, params.domain);

  if (dedup.isDuplicate && dedup.duplicateId) {
    return {
      content: [{
        type: "text",
        text: `❌ 已存在相似 insight [[${dedup.duplicateId}]]。\n理由: ${dedup.reason}\n\n建议：kb_update_insight / kb_create_insight type=\"alternative_view\" / kb_add_evidence`,
      }],
      details: { blocked: true, duplicateId: dedup.duplicateId },
    };
  }

  // Evidence time weighting
  const timeAdjustedConfidence = await adjustConfidenceByEvidenceAge(
    nodeIndex, params.confidence, params.sources, params.domain as Domain
  );
  const finalConfidence = staleSources.length > 0
    ? Math.min(timeAdjustedConfidence, 0.6)
    : timeAdjustedConfidence;

  const id = storage.generateId();

  const node: InsightNode = {
    id, type: "insight",
    title: params.title,
    status: "active", created_by: "agent",
    created_at: now, updated_at: now,
    last_verified: now, last_touched: now,
    domain: params.domain as Domain,
    tags: params.tags || [],
    changelog: [{
      timestamp: now, actor: "agent", action: "created",
      detail: `base_confidence=${params.confidence}, adjusted=${finalConfidence}`,
    }],
    statement: params.statement,
    confidence: finalConfidence,
    sources: params.sources,
  };

  await storage.writeNode(node);
  nodeIndex.addSkeleton(skeletonFromNode(node));

  for (const srcId of params.sources) {
    nodeIndex.graph.addLink({
      from: id, to: srcId, type: "supported_by", status: "active", created_at: now,
    });
  }

  let msg = `✅ 已创建 insight [[${id}]]`;
  if (finalConfidence !== params.confidence) {
    msg += `\n📊 证据时间加权: ${params.confidence} → ${finalConfidence}`;
  }
  if (staleSources.length > 0) {
    msg += `\n⚠ ${staleSources.length} 个 source 已 stale。`;
  }
  if (dedup.isContradiction) {
    msg += `\n⚠ 存在方向不同的已有 insight，建议 kb_create_contradiction。`;
  }

  return { content: [{ type: "text", text: msg }], details: { id, dedup } };
}

// ══════════════════════════════════════════════════════════════
//  kb_update_insight
// ══════════════════════════════════════════════════════════════

export async function updateInsight(
  ctx: ToolContext,
  params: {
    id: string;
    statement?: string;
    confidence?: number;
    addSources?: string[];
    reason: string;
  }
): Promise<ToolResult> {
  const { nodeIndex, storage, config } = ctx;
  if (!nodeIndex) return notReady();

  const existing = await storage.readNode(params.id);
  if (!existing || existing.type !== "insight") {
    return { content: [{ type: "text", text: `❌ [[${params.id}]] 不存在或不是 insight。` }], details: {} };
  }

  const now = Date.now();
  const age = now - existing.created_at;
  const isSubstantialChange =
    params.statement !== undefined ||
    (params.confidence !== undefined &&
      Math.abs(params.confidence - (existing as InsightNode).confidence) > 0.2);

  if (existing.created_by === "agent" && age > config.selfCorrectionWindowMs && isSubstantialChange) {
    return {
      content: [{
        type: "text",
        text: `⚠ 超出窗口（${Math.round(age / 3600000)}h）。建议降低 confidence 或创建新 insight + evolved_from。`,
      }],
      details: { blocked: true, reason: "self_correction_window_expired" },
    };
  }

  const node = existing as InsightNode;
  const oldConfidence = node.confidence;

  if (params.statement !== undefined) node.statement = params.statement;
  if (params.confidence !== undefined) node.confidence = Math.max(0, Math.min(1, params.confidence));
  if (params.addSources) {
    for (const src of params.addSources) {
      if (!node.sources.includes(src)) node.sources.push(src);
    }
  }
  node.updated_at = now;
  node.changelog.push({
    timestamp: now, actor: "agent", action: "updated",
    detail: `${params.reason}${oldConfidence !== node.confidence ? ` (confidence: ${oldConfidence}→${node.confidence})` : ""}`,
  });

  await storage.writeNode(node);
  nodeIndex.updateSkeleton(params.id, { updated_at: now });
  nodeIndex.touch(params.id);

  const affected = nodeIndex.graph.getAffectedNodes(params.id);
  const staleMarked: string[] = [];
  for (const a of affected.slice(0, 20)) {
    if (nodeIndex.markStale(a.nodeId, `Upstream ${params.id} updated`)) {
      staleMarked.push(a.nodeId);
    }
  }

  let msg = `✅ 已更新 insight [[${params.id}]]`;
  if (params.confidence !== undefined) msg += `\nConfidence: ${oldConfidence} → ${node.confidence}`;
  if (staleMarked.length > 0) msg += `\n⚠ Ripple: ${staleMarked.length} 下游 stale`;

  return { content: [{ type: "text", text: msg }], details: { id: params.id, staleMarked } };
}

// ══════════════════════════════════════════════════════════════
//  kb_retrieve
// ══════════════════════════════════════════════════════════════

export async function retrieve(
  ctx: ToolContext,
  params: {
    query: string;
    scope?: string;
    domain?: string;
    type?: string;
    maxResults?: number;
    expandLinks?: boolean;
    offset?: number;
  }
): Promise<ToolResult> {
  const { nodeIndex, storage, llmCaller } = ctx;
  if (!nodeIndex) return notReady();

  const scope: RetrieveScope = (params.scope as RetrieveScope) || "routine";
  const maxResults = params.maxResults || 15;
  const offset = params.offset || 0;
  const shouldExpand = params.expandLinks !== false;

  let results = nodeIndex.search(params.query, {
    type: params.type as NodeType | undefined,
    domain: params.domain as Domain | undefined,
  });

  const scopedIds = nodeIndex.filterByScope(results.map((r) => r.nodeId), scope);
  results = results.filter((r) => scopedIds.includes(r.nodeId));

  let bfsIds: string[] = [];
  if (shouldExpand && results.length > 0) {
    const bfsSteps = nodeIndex.graph.bfs(results[0].nodeId, 2);
    bfsIds = bfsSteps.filter((s) => s.nodeId !== results[0].nodeId).map((s) => s.nodeId);
    const existingIds = new Set(results.map((r) => r.nodeId));
    for (const id of bfsIds) {
      if (!existingIds.has(id)) {
        const skel = nodeIndex.getSkeleton(id);
        if (skel) results.push({ nodeId: id, score: 0.3, skeleton: skel });
      }
    }
  }

  // LLM Rerank
  let ranked: { nodeId: string; rank: number }[];
  if (results.length > 3) {
    try {
      const candidates = results.map((r) => ({
        nodeId: r.nodeId, title: r.skeleton.title, snippet: r.skeleton.snippet,
      }));
      const reranked = await llmRerank(ctx, params.query, candidates);
      const rankMap = new Map<string, number>();
      reranked.ranked.forEach((id, i) => rankMap.set(id, results.length - i));
      reranked.irrelevant.forEach((id) => rankMap.set(id, -1));

      results = results.filter((r) => rankMap.get(r.nodeId) !== -1);
      ranked = results
        .map((r) => ({ nodeId: r.nodeId, rank: (rankMap.get(r.nodeId) || 0) / results.length }))
        .sort((a, b) => b.rank - a.rank);
    } catch {
      ranked = nodeIndex.rank(results.map((r) => r.nodeId));
    }
  } else {
    ranked = nodeIndex.rank(results.map((r) => r.nodeId));
  }

  // Token budget + pagination
  const TOKEN_BUDGET = 4096;
  let tokensUsed = 0;
  const lines: string[] = [
    `检索: ${ranked.length} 节点 (${scope})`,
    bfsIds.length > 0 ? `双链展开: ${bfsIds.length}` : "",
    "",
  ].filter(Boolean);

  const paginated = ranked.slice(offset, offset + maxResults);
  const included: string[] = [];
  let truncated = 0;

  for (const item of paginated) {
    const skel = nodeIndex.getSkeleton(item.nodeId);
    if (!skel) continue;
    const staleMark = skel.status === "stale" ? " ⚠" : "";
    const lineStr = `- [[${item.nodeId}]] **${skel.title}** (${skel.type}, ${skel.domain}${staleMark})`;
    if (tokensUsed + lineStr.length * 0.25 > TOKEN_BUDGET) { truncated++; break; }
    lines.push(lineStr);
    lines.push(`  ${skel.snippet.slice(0, 120)}`);
    tokensUsed += lineStr.length * 0.25 + 30;
    included.push(item.nodeId);
  }

  if (truncated > 0) lines.push("", `⚠ 截断 ${truncated} 个（上下文预算）。`);
  if (offset + maxResults < ranked.length) {
    lines.push("", `💡 还有 ${ranked.length - offset - maxResults} 个。offset=${offset + maxResults} 翻页。`);
  }

  if (ranked.length === 0) {
    const meta = await storage.readMeta();
    nodeIndex.recordKnowledgeGap(
      (params.domain as Domain) || "external-fact", params.query, meta
    );
    await storage.writeMeta(meta);
    lines.push("_(无结果)_", "已记录为 knowledge gap。");
  }

  for (const id of included) nodeIndex.touch(id);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { totalFound: ranked.length, returned: included.length, truncated, bfsExpanded: bfsIds.length, scope, offset },
  };
}

// ══════════════════════════════════════════════════════════════
//  Helper: LLM dedup
// ══════════════════════════════════════════════════════════════

export async function llmDedup(
  ctx: ToolContext,
  statement: string,
  domain: string
): Promise<{
  isDuplicate: boolean; duplicateId?: string;
  isContradiction: boolean; contradictId?: string;
  reason: string;
}> {
  const { nodeIndex, storage } = ctx;
  const candidates = nodeIndex.search(statement, { domain: domain as Domain });
  const topCandidates = candidates.slice(0, 5).filter((c) => c.score > 0);

  if (topCandidates.length === 0) {
    return { isDuplicate: false, isContradiction: false, reason: "no candidates" };
  }

  const candidateList = await Promise.all(
    topCandidates.map(async (c) => {
      const node = await storage.readNode(c.nodeId);
      const stmt = node && node.type === "insight" ? (node as InsightNode).statement : node?.title || "";
      return `${c.nodeId}: "${stmt}"`;
    })
  );

  try {
    const result = await ctx.llmCaller.call({
      system: `你是知识库去重检查器。判断新声明是否与已有节点实质重复或矛盾。返回 JSON：{"isDuplicate":bool,"duplicateId":"..."|null,"isContradiction":bool,"contradictId":"..."|null,"reason":"..."}`,
      prompt: `新声明：「${statement}」\n\n已有节点：\n${candidateList.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    });
    if (result) return JSON.parse(result);
  } catch { /* fall through */ }

  // Keyword fallback
  for (const c of topCandidates) {
    if (c.skeleton.title === statement) {
      return { isDuplicate: true, duplicateId: c.nodeId, isContradiction: false, reason: "exact title match (fallback)" };
    }
  }
  return { isDuplicate: false, isContradiction: false, reason: "keyword-only" };
}

// ══════════════════════════════════════════════════════════════
//  Helper: LLM rerank
// ══════════════════════════════════════════════════════════════

export async function llmRerank(
  ctx: ToolContext,
  query: string,
  candidates: { nodeId: string; title: string; snippet: string }[]
): Promise<{ ranked: string[]; irrelevant: string[] }> {
  if (candidates.length <= 3) {
    return { ranked: candidates.map((c) => c.nodeId), irrelevant: [] };
  }

  const candidateList = candidates
    .map((c, i) => `${i + 1}. [${c.nodeId}] ${c.title}: ${c.snippet.slice(0, 100)}`)
    .join("\n");

  try {
    const result = await ctx.llmCaller.call({
      system: `根据查询意图对候选节点按相关性排序。返回 JSON：{"ranked":["id1",...],"irrelevant":["id3",...]}`,
      prompt: `查询：「${query}」\n\n候选节点：\n${candidateList}`,
    });
    if (result) return JSON.parse(result);
  } catch { /* fall through */ }

  return { ranked: candidates.map((c) => c.nodeId), irrelevant: [] };
}

// ══════════════════════════════════════════════════════════════
//  Helper: Evidence time weighting
// ══════════════════════════════════════════════════════════════

export async function adjustConfidenceByEvidenceAge(
  nodeIndex: NodeIndex,
  baseConfidence: number,
  sourceIds: string[],
  domain: Domain
): Promise<number> {
  if (sourceIds.length === 0) return baseConfidence;

  const now = Date.now();
  const halflifeDays = DOMAIN_HALFLIFE_DAYS[domain] || 90;
  const lambda = Math.log(2) / (halflifeDays * 24 * 60 * 60 * 1000);

  let totalWeight = 0;
  let freshCount = 0;

  for (const srcId of sourceIds) {
    const skel = nodeIndex.getSkeleton(srcId);
    if (!skel) continue;
    const age = now - Math.max(skel.last_verified, skel.created_at);
    const weight = Math.exp(-lambda * age);
    totalWeight += weight;
    freshCount++;
  }

  if (freshCount === 0 || totalWeight === 0) return baseConfidence;

  const avgFreshness = totalWeight / freshCount;
  const adjusted = baseConfidence * 0.7 + avgFreshness * 0.3;

  return Math.round(adjusted * 100) / 100;
}

// ══════════════════════════════════════════════════════════════
//  kb_add_evidence
// ══════════════════════════════════════════════════════════════

export async function addEvidence(
  ctx: ToolContext,
  params: { insightId: string; sourceId: string; newConfidence?: number }
): Promise<ToolResult> {
  const { nodeIndex, storage } = ctx;
  if (!nodeIndex) return notReady();

  const existing = await storage.readNode(params.insightId);
  if (!existing || existing.type !== "insight") {
    return { content: [{ type: "text", text: `❌ [[${params.insightId}]] 不存在或不是 insight。` }], details: {} };
  }
  if (!nodeIndex.has(params.sourceId)) {
    return { content: [{ type: "text", text: `❌ source [[${params.sourceId}]] 不存在。` }], details: {} };
  }

  const node = existing as InsightNode;
  const now = Date.now();
  if (!node.sources.includes(params.sourceId)) node.sources.push(params.sourceId);
  if (params.newConfidence !== undefined) node.confidence = Math.max(0, Math.min(1, params.newConfidence));
  node.updated_at = now;
  node.last_verified = now;
  node.changelog.push({ timestamp: now, actor: "agent", action: "evidence_added", detail: `Added: ${params.sourceId}` });

  await storage.writeNode(node);
  nodeIndex.updateSkeleton(params.insightId, { updated_at: now, last_verified: now });
  nodeIndex.graph.addLink({ from: params.insightId, to: params.sourceId, type: "supported_by", status: "active", created_at: now });

  return { content: [{ type: "text", text: `✅ 已追加 evidence [[${params.sourceId}]] → [[${params.insightId}]]` }], details: { insightId: params.insightId } };
}

// ══════════════════════════════════════════════════════════════
//  kb_link
// ══════════════════════════════════════════════════════════════

export async function createLink(
  ctx: ToolContext,
  params: { from: string; to: string; type: string; context?: string }
): Promise<ToolResult> {
  const { nodeIndex, config } = ctx;
  if (!nodeIndex) return notReady();
  if (!nodeIndex.has(params.from)) {
    return { content: [{ type: "text", text: `❌ 源节点 [[${params.from}]] 不存在。` }], details: {} };
  }

  const now = Date.now();
  const toExists = nodeIndex.has(params.to);
  const status = toExists ? "active" : "pending";

  nodeIndex.graph.addLink({
    from: params.from, to: params.to,
    type: params.type as LinkType, status: status as "active" | "pending",
    created_at: now, context: params.context,
  });

  let msg = `✅ [[${params.from}]] → [[${params.to}]] (${params.type})`;
  if (!toExists) {
    msg += `\n⚠ pending (${config.pendingLinkTimeoutMs / 3600000}h timeout)`;
  }
  return { content: [{ type: "text", text: msg }], details: { from: params.from, to: params.to, status } };
}

// ══════════════════════════════════════════════════════════════
//  kb_create_contradiction
// ══════════════════════════════════════════════════════════════

export async function createContradiction(
  ctx: ToolContext,
  params: { title: string; nodeA: string; nodeB: string; severity: string; description?: string }
): Promise<ToolResult> {
  const { nodeIndex, storage } = ctx;
  if (!nodeIndex) return notReady();

  const id = storage.generateId();
  const now = Date.now();

  const node: ContradictionNode = {
    id, type: "contradiction", title: params.title,
    status: "active", created_by: "agent",
    created_at: now, updated_at: now,
    last_verified: now, last_touched: now,
    domain: "agent-self-knowledge", tags: ["contradiction"],
    changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "" }],
    conflicting_nodes: [params.nodeA, params.nodeB],
    severity: params.severity as "surface" | "substantial",
    contradiction_state: "unresolved",
  };

  await storage.writeNode(node);
  nodeIndex.addSkeleton(skeletonFromNode(node));

  for (const cid of [params.nodeA, params.nodeB]) {
    if (nodeIndex.has(cid)) {
      nodeIndex.graph.addLink({ from: id, to: cid, type: "contradicts", status: "active", created_at: now });
    }
  }

  return { content: [{ type: "text", text: `✅ 已创建矛盾节点 [[${id}]]` }], details: { id, type: "contradiction" } };
}

// ══════════════════════════════════════════════════════════════
//  kb_resolve_contradiction
// ══════════════════════════════════════════════════════════════

export async function resolveContradiction(
  ctx: ToolContext,
  params: { contradictionId: string; resolution: string; newInsightTitle: string; newInsightStatement: string; newConfidence: number; domain: string }
): Promise<ToolResult> {
  const { nodeIndex, storage } = ctx;
  if (!nodeIndex) return notReady();

  const contra = await storage.readNode(params.contradictionId);
  if (!contra || contra.type !== "contradiction") {
    return { content: [{ type: "text", text: `❌ [[${params.contradictionId}]] 不存在或不是矛盾节点。` }], details: {} };
  }

  const now = Date.now();
  const newId = storage.generateId();

  // Create refined insight
  const newInsight: InsightNode = {
    id: newId, type: "insight", title: params.newInsightTitle,
    status: "active", created_by: "agent",
    created_at: now, updated_at: now,
    last_verified: now, last_touched: now,
    domain: params.domain as Domain, tags: ["resolved-contradiction"],
    changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "Resolved contradiction" }],
    statement: params.newInsightStatement,
    confidence: params.newConfidence,
    sources: [],
    resolved_from_contradiction: params.contradictionId,
  };
  await storage.writeNode(newInsight);
  nodeIndex.addSkeleton(skeletonFromNode(newInsight));

  // Mark contradiction resolved
  const contraNode = contra as ContradictionNode;
  contraNode.contradiction_state = "resolved";
  contraNode.resolved_insight_id = newId;
  contraNode.resolution = params.resolution;
  contraNode.updated_at = now;
  contraNode.status = "stable";
  await storage.writeNode(contraNode);
  nodeIndex.updateSkeleton(params.contradictionId, { status: "stable" });

  // Deprecate conflicting nodes
  for (const cid of contraNode.conflicting_nodes) {
    if (nodeIndex.has(cid)) {
      nodeIndex.graph.addLink({ from: cid, to: newId, type: "deprecated_by", status: "active", created_at: now });
      const cn = await storage.readNode(cid);
      if (cn) { cn.status = "stable"; cn.updated_at = now; await storage.writeNode(cn); nodeIndex.updateSkeleton(cid, { status: "stable" }); }
    }
  }

  nodeIndex.graph.addLink({ from: params.contradictionId, to: newId, type: "evolved_from", status: "active", created_at: now });

  return { content: [{ type: "text", text: `✅ 矛盾已解决 → [[${newId}]]` }], details: { newInsightId: newId, contradictionId: params.contradictionId } };
}

// ══════════════════════════════════════════════════════════════
//  kb_deprecate_node
// ══════════════════════════════════════════════════════════════

export async function deprecateNode(
  ctx: ToolContext,
  params: { oldNodeId: string; newNodeId: string; reason: string }
): Promise<ToolResult> {
  const { nodeIndex, storage } = ctx;
  if (!nodeIndex) return notReady();

  const oldNode = await storage.readNode(params.oldNodeId);
  if (!oldNode) return { content: [{ type: "text", text: `❌ [[${params.oldNodeId}]] 不存在。` }], details: {} };
  if (!nodeIndex.has(params.newNodeId)) return { content: [{ type: "text", text: `❌ [[${params.newNodeId}]] 不存在。` }], details: {} };

  const now = Date.now();
  oldNode.status = "stable";
  oldNode.updated_at = now;
  oldNode.changelog.push({ timestamp: now, actor: "agent", action: "deprecated", detail: `${params.reason} → [[${params.newNodeId}]]` });
  await storage.writeNode(oldNode);
  nodeIndex.updateSkeleton(params.oldNodeId, { status: "stable" });
  nodeIndex.graph.addLink({ from: params.oldNodeId, to: params.newNodeId, type: "deprecated_by", status: "active", created_at: now, context: params.reason });

  const affected = nodeIndex.graph.getAffectedNodes(params.oldNodeId);
  const staleMarked: string[] = [];
  for (const a of affected.slice(0, 10)) {
    if (nodeIndex.markStale(a.nodeId, `Upstream ${params.oldNodeId} deprecated`)) staleMarked.push(a.nodeId);
  }

  let msg = `✅ 已废弃 [[${params.oldNodeId}]] → [[${params.newNodeId}]]`;
  if (staleMarked.length) msg += `\n⚠ ${staleMarked.length} 下游 stale`;
  return { content: [{ type: "text", text: msg }], details: { oldNodeId: params.oldNodeId, newNodeId: params.newNodeId, staleMarked } };
}

// ══════════════════════════════════════════════════════════════
//  kb_create_moc
// ══════════════════════════════════════════════════════════════

export async function createMoc(
  ctx: ToolContext,
  params: { title: string; description?: string; childNodes?: string[]; domain: string }
): Promise<ToolResult> {
  const { nodeIndex, storage } = ctx;
  if (!nodeIndex) return notReady();

  const id = storage.generateId();
  const now = Date.now();
  const children = params.childNodes || [];

  const node: MocNode = {
    id, type: "moc", title: params.title,
    status: "active", created_by: "agent",
    created_at: now, updated_at: now,
    last_verified: now, last_touched: now,
    domain: params.domain as Domain, tags: ["moc"],
    changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "" }],
    description: params.description,
    child_nodes: children,
  };

  await storage.writeNode(node);
  nodeIndex.addSkeleton(skeletonFromNode(node));

  for (const cid of children) {
    if (nodeIndex.has(cid)) {
      nodeIndex.graph.addLink({ from: id, to: cid, type: "parent_of", status: "active", created_at: now });
    }
  }

  return { content: [{ type: "text", text: `✅ 已创建 MOC [[${id}]]` }], details: { id, type: "moc" } };
}

// ══════════════════════════════════════════════════════════════
//  kb_add_to_moc
// ══════════════════════════════════════════════════════════════

export async function addToMoc(
  ctx: ToolContext,
  params: { mocId: string; nodeId: string }
): Promise<ToolResult> {
  const { nodeIndex, storage } = ctx;
  if (!nodeIndex) return notReady();

  const moc = await storage.readNode(params.mocId);
  if (!moc || moc.type !== "moc") return { content: [{ type: "text", text: `❌ [[${params.mocId}]] 不是 MOC。` }], details: {} };
  if (!nodeIndex.has(params.nodeId)) return { content: [{ type: "text", text: `❌ [[${params.nodeId}]] 不存在。` }], details: {} };

  const mocNode = moc as MocNode;
  if (mocNode.child_nodes.includes(params.nodeId)) return { content: [{ type: "text", text: "已在 MOC 中。" }], details: {} };

  const now = Date.now();
  mocNode.child_nodes.push(params.nodeId);
  mocNode.updated_at = now;
  await storage.writeNode(mocNode);
  nodeIndex.graph.addLink({ from: params.mocId, to: params.nodeId, type: "parent_of", status: "active", created_at: now });

  return { content: [{ type: "text", text: `✅ 已添加。` }], details: { mocId: params.mocId } };
}

// ══════════════════════════════════════════════════════════════
//  kb_re_reflect
// ══════════════════════════════════════════════════════════════

export async function reReflect(
  ctx: ToolContext,
  params: { previousReflectionId: string; content: string }
): Promise<ToolResult> {
  const { nodeIndex, storage } = ctx;
  if (!nodeIndex) return notReady();

  const id = storage.generateId();
  const now = Date.now();

  const node: ReflectionNode = {
    id, type: "reflection",
    title: `Re-reflection ${params.previousReflectionId.slice(0, 8)}`,
    status: "active", created_by: "agent",
    created_at: now, updated_at: now,
    last_verified: now, last_touched: now,
    domain: "agent-self-knowledge", tags: ["re-reflection"],
    changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "" }],
    period: new Date().toISOString().slice(0, 10),
    content: params.content,
    sources: [], secondary_sources: [],
    previous_reflection: params.previousReflectionId,
  };

  await storage.writeNode(node);
  nodeIndex.addSkeleton(skeletonFromNode(node));

  if (nodeIndex.has(params.previousReflectionId)) {
    nodeIndex.graph.addLink({ from: id, to: params.previousReflectionId, type: "evolved_from", status: "active", created_at: now });
  }

  return { content: [{ type: "text", text: `✅ 已创建 [[${id}]]` }], details: { id, type: "reflection" } };
}
