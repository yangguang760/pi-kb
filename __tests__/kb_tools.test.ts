/**
 * pi-kb: kb_tools unit tests
 *
 * Tests tool logic with mocked dependencies.
 */

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  recordObservation,
  updateObservation,
  createInsight,
  updateInsight,
  retrieve,
  adjustConfidenceByEvidenceAge,
  llmDedup,
  llmRerank,
  type ToolContext,
  type LLMCaller,
} from "../kb_tools";
import { LinkGraph } from "../link_graph";
import { NodeIndex } from "../node_index";
import type {
  KBStorage,
} from "../storage";
import type {
  KBMeta,
  KBNode,
  NodeSkeleton,
  ObservationNode,
  InsightNode,
} from "../types";

// ─── In-memory mock storage ───────────────────────────────────

class MockStorage {
  private nodes: Map<string, KBNode> = new Map();
  private meta: KBMeta;
  rootDir = "/mock/kb";
  nodesDir = "/mock/kb/nodes";
  tmpDir = "/mock/kb/.tmp";
  metaPath = "/mock/kb/.kb_meta.json";

  constructor() {
    this.meta = {
      version: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
      total_nodes: 0,
      reflection_triggers: {
        unreflected_observations: 0,
        threshold: 3,
        last_reflection_at: null,
        domains_with_pending: [],
      },
      knowledge_gaps: [],
    };
  }

  generateId(): string { return randomUUID(); }
  async ensure(): Promise<void> {}

  async writeNode(node: KBNode): Promise<void> {
    this.nodes.set(node.id, structuredClone(node));
  }

  async readNode(id: string): Promise<KBNode | null> {
    const n = this.nodes.get(id);
    return n ? structuredClone(n) : null;
  }

  async readMeta(): Promise<KBMeta> {
    return structuredClone(this.meta);
  }

  async writeMeta(meta: KBMeta): Promise<void> {
    this.meta = structuredClone(meta);
  }

  // Minimal stubs for tests that don't need them
  async nodeMtime(_id: string): Promise<number | null> { return Date.now(); }
  async listNodeIds(): Promise<string[]> { return [...this.nodes.keys()]; }
  async readNodeSkeleton(id: string): Promise<NodeSkeleton | null> {
    const n = this.nodes.get(id);
    if (!n) return null;
    return {
      id: n.id, type: n.type, title: n.title, status: n.status,
      created_by: n.created_by, domain: n.domain,
      created_at: n.created_at, updated_at: n.updated_at,
      last_verified: n.last_verified, last_touched: n.last_touched,
      tags: n.tags, snippet: "",
    };
  }
  nodePath(_id: string): string { return `/mock/kb/nodes/${_id}.md`; }
  async deleteNode(_id: string): Promise<void> {}
  async appendAutoLog(_s: string, _e: unknown): Promise<void> {}
}

// ─── Helpers ──────────────────────────────────────────────────

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  const storage = new MockStorage() as unknown as KBStorage;
  const nodeIndex = new NodeIndex(storage);
  const llmCaller: LLMCaller = {
    async call() { return null; }, // no LLM by default
  };

  return {
    nodeIndex,
    storage,
    sessionId: "test-session-001",
    kbRoot: "/mock/kb",
    llmCaller,
    config: {
      selfCorrectionWindowMs: 60 * 60 * 1000,
      pendingLinkTimeoutMs: 48 * 60 * 60 * 1000,
      reflectionQualityThreshold: 0.02,
      llmDedupModel: "test-model",
    },
    ...overrides,
  };
}

/** Seed the index with a skeleton (without writing to storage) */
function seedSkeleton(ctx: ToolContext, skeleton: NodeSkeleton): void {
  ctx.nodeIndex.addSkeleton(skeleton);
}

/** Create a full observation node in storage AND index */
async function seedObservation(
  ctx: ToolContext,
  overrides?: Partial<ObservationNode>
): Promise<ObservationNode> {
  const id = ctx.storage.generateId();
  const now = Date.now();
  const node: ObservationNode = {
    id, type: "observation",
    title: overrides?.title || "Test Observation",
    status: "active", created_by: "agent",
    created_at: overrides?.created_at || now,
    updated_at: now, last_verified: now, last_touched: now,
    domain: overrides?.domain || "user-preference",
    tags: overrides?.tags || [],
    changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "" }],
    source_log: "[[test-session]]",
    content: overrides?.content || "Test content",
    significance: overrides?.significance || "medium",
    ...overrides,
  };
  await ctx.storage.writeNode(node);
  ctx.nodeIndex.addSkeleton(skelFromNode(node));
  return node;
}

function skelFromNode(node: KBNode): NodeSkeleton {
  return {
    id: node.id, type: node.type, title: node.title, status: node.status,
    created_by: node.created_by, domain: node.domain,
    created_at: node.created_at, updated_at: node.updated_at,
    last_verified: node.last_verified, last_touched: node.last_touched,
    tags: node.tags, snippet: "",
  };
}

// ══════════════════════════════════════════════════════════════
//  Tests
// ══════════════════════════════════════════════════════════════

describe("kb_tools", () => {
  describe("recordObservation", () => {
    it("creates an observation and updates reflection counter", async () => {
      const ctx = makeCtx();

      const result = await recordObservation(ctx, {
        content: "User likes TypeScript",
        significance: "high",
        domain: "user-preference",
      });

      // Check result
      assert.match(result.content[0].text, /✅/);
      assert.ok(result.details.id);

      // Check node was written
      const node = await ctx.storage.readNode(result.details.id as string);
      assert.ok(node);
      assert.equal(node!.type, "observation");
      assert.equal((node as ObservationNode).content, "User likes TypeScript");
      assert.equal((node as ObservationNode).significance, "high");

      // Check counter
      const meta = await (ctx.storage as unknown as MockStorage).readMeta();
      assert.equal(meta.reflection_triggers.unreflected_observations, 1);
    });

    it("warns when threshold reached", async () => {
      const ctx = makeCtx();
      // Set threshold to 1
      const storage = ctx.storage as unknown as MockStorage;
      const meta = await storage.readMeta();
      meta.reflection_triggers.threshold = 1;
      await storage.writeMeta(meta);

      const result = await recordObservation(ctx, {
        content: "test",
        significance: "low",
        domain: "user-preference",
      });

      assert.match(result.content[0].text, /⚠/);
    });
  });

  describe("updateObservation", () => {
    it("updates content within self-correction window", async () => {
      const ctx = makeCtx();
      const obs = await seedObservation(ctx, {
        content: "original content",
        created_at: Date.now(), // just now
      });

      const result = await updateObservation(ctx, {
        id: obs.id,
        content: "corrected content",
        reason: "typo",
      });

      assert.match(result.content[0].text, /✅/);

      const updated = await ctx.storage.readNode(obs.id);
      assert.equal((updated as ObservationNode).content, "corrected content");
    });

    it("blocks update outside self-correction window", async () => {
      const ctx = makeCtx();
      const obs = await seedObservation(ctx, {
        content: "old content",
        created_at: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
      });

      const result = await updateObservation(ctx, {
        id: obs.id,
        content: "too late",
        reason: "typo",
      });

      assert.match(result.content[0].text, /❌/);
    });

    it("allows updating significance", async () => {
      const ctx = makeCtx();
      const obs = await seedObservation(ctx, {
        significance: "low",
      });

      await updateObservation(ctx, {
        id: obs.id,
        significance: "high",
        reason: "reevaluated",
      });

      const updated = await ctx.storage.readNode(obs.id);
      assert.equal((updated as ObservationNode).significance, "high");
    });
  });

  describe("createInsight", () => {
    it("creates insight with evidence links", async () => {
      const ctx = makeCtx();
      const obs = await seedObservation(ctx, {
        content: "User chose Rust",
        domain: "user-preference",
      });

      const result = await createInsight(ctx, {
        title: "Rust preference",
        statement: "User prefers Rust for systems programming",
        confidence: 0.85,
        sources: [obs.id],
        domain: "user-preference",
      });

      assert.match(result.content[0].text, /✅/);

      // Check link was created
      const nodeId = result.details.id as string;
      const links = ctx.nodeIndex.graph.getOutgoing(nodeId);
      assert.equal(links.length, 1);
      assert.equal(links[0].to, obs.id);
      assert.equal(links[0].type, "supported_by");
    });

    it("blocks creation when sources are missing", async () => {
      const ctx = makeCtx();

      const result = await createInsight(ctx, {
        title: "test",
        statement: "test",
        confidence: 0.9,
        sources: ["nonexistent-id"],
        domain: "user-preference",
      });

      assert.match(result.content[0].text, /❌/);
    });

    it("reduces confidence when sources are stale", async () => {
      const ctx = makeCtx();
      const obs = await seedObservation(ctx, {
        content: "Old preference",
        created_at: Date.now() - 200 * 24 * 60 * 60 * 1000, // 200 days ago
      });

      // Manually mark as stale
      ctx.nodeIndex.updateSkeleton(obs.id, { status: "stale" });

      const result = await createInsight(ctx, {
        title: "Old insight",
        statement: "Based on old data",
        confidence: 0.9,
        sources: [obs.id],
        domain: "user-preference",
      });

      // Confidence should be capped at 0.6 when all sources are stale
      const node = await ctx.storage.readNode(result.details.id as string);
      assert.ok(node);
      assert.ok((node as InsightNode).confidence <= 0.6);
    });
  });

  describe("updateInsight", () => {
    it("updates confidence and triggers ripple", async () => {
      const ctx = makeCtx();
      const obs = await seedObservation(ctx);
      const insight = await createInsight(ctx, {
        title: "Original", statement: "Original insight",
        confidence: 0.8, sources: [obs.id], domain: "user-preference",
      });
      const insightId = insight.details.id as string;

      // Create a node that depends on this insight
      const depNode: NodeSkeleton = {
        id: "dep-001", type: "insight", title: "Dependent",
        status: "active", created_by: "agent", domain: "user-preference",
        created_at: Date.now(), updated_at: Date.now(),
        last_verified: Date.now(), last_touched: Date.now(),
        tags: [], snippet: "",
      };
      seedSkeleton(ctx, depNode);
      ctx.nodeIndex.graph.addLink({
        from: "dep-001", to: insightId, type: "supported_by",
        status: "active", created_at: Date.now(),
      });

      const result = await updateInsight(ctx, {
        id: insightId, confidence: 0.3, reason: "User changed mind",
      });

      assert.match(result.content[0].text, /✅/);
      assert.match(result.content[0].text, /Ripple/);

      // Dependent node should be stale
      const dep = ctx.nodeIndex.getSkeleton("dep-001");
      assert.equal(dep!.status, "stale");
    });
  });

  describe("retrieve", () => {
    it("returns empty on empty KB", async () => {
      const ctx = makeCtx();
      const result = await retrieve(ctx, { query: "anything" });
      assert.match(result.content[0].text, /无结果/);
    });

    it("finds keyword matches", async () => {
      const ctx = makeCtx();
      await seedObservation(ctx, { content: "Rust language preference", tags: ["rust"] });
      await seedObservation(ctx, { content: "Python for data science", tags: ["python"] });

      const result = await retrieve(ctx, { query: "Rust" });
      assert.match(result.content[0].text, /Rust/);
      assert.doesNotMatch(result.content[0].text, /Python/);
    });

    it("filters by scope", async () => {
      const ctx = makeCtx();
      await seedObservation(ctx, { content: "Active observation" });

      const result = await retrieve(ctx, { query: "Active", scope: "routine" });
      assert.match(result.content[0].text, /Active/);
    });

    it("records knowledge gap on zero results", async () => {
      const ctx = makeCtx();
      await retrieve(ctx, { query: "nonexistent topic" });

      const meta = await (ctx.storage as unknown as MockStorage).readMeta();
      assert.ok(meta.knowledge_gaps.length > 0);
      assert.equal(meta.knowledge_gaps[0].query_pattern, "nonexistent topic");
    });
  });

  describe("adjustConfidenceByEvidenceAge", () => {
    it("returns base confidence when no sources", async () => {
      const ctx = makeCtx();
      const result = await adjustConfidenceByEvidenceAge(
        ctx.nodeIndex, 0.9, [], "user-preference"
      );
      assert.equal(result, 0.9);
    });

    it("reduces confidence for old evidence", async () => {
      const ctx = makeCtx();
      // Create very old observation (200 days)
      const oldObsId = ctx.storage.generateId();
      const longAgo = Date.now() - 200 * 24 * 60 * 60 * 1000;
      ctx.nodeIndex.addSkeleton({
        id: oldObsId, type: "observation", title: "Old",
        status: "stable", created_by: "agent", domain: "user-preference",
        created_at: longAgo, updated_at: longAgo,
        last_verified: longAgo, last_touched: longAgo,
        tags: [], snippet: "",
      });

      const result = await adjustConfidenceByEvidenceAge(
        ctx.nodeIndex, 0.9, [oldObsId], "user-preference"
      );
      // user-preference halflife = 90 days, evidence is 200 days old
      // Should be noticeably lower than 0.9
      assert.ok(result < 0.8, `Expected < 0.8, got ${result}`);
    });

    it("keeps high confidence for recent evidence", async () => {
      const ctx = makeCtx();
      const freshId = ctx.storage.generateId();
      const now = Date.now();
      ctx.nodeIndex.addSkeleton({
        id: freshId, type: "observation", title: "Fresh",
        status: "active", created_by: "agent", domain: "user-preference",
        created_at: now, updated_at: now,
        last_verified: now, last_touched: now,
        tags: [], snippet: "",
      });

      const result = await adjustConfidenceByEvidenceAge(
        ctx.nodeIndex, 0.9, [freshId], "user-preference"
      );
      // Should be close to 0.9 (70% base + 30% freshness ~= 0.93)
      assert.ok(result >= 0.85, `Expected >= 0.85, got ${result}`);
    });
  });

  describe("llmDedup", () => {
    it("returns no duplicate when no candidates", async () => {
      const ctx = makeCtx();
      const result = await llmDedup(ctx, "unique statement", "user-preference");
      assert.equal(result.isDuplicate, false);
      assert.equal(result.isContradiction, false);
    });

    it("detects exact title match as duplicate (keyword fallback)", async () => {
      const ctx = makeCtx();
      const insightId = ctx.storage.generateId();
      ctx.nodeIndex.addSkeleton({
        id: insightId, type: "insight", title: "User prefers Rust",
        status: "active", created_by: "agent", domain: "user-preference",
        created_at: Date.now(), updated_at: Date.now(),
        last_verified: Date.now(), last_touched: Date.now(),
        tags: [], snippet: "User prefers Rust for systems",
      });
      // Also seed the actual node in storage for statement reading
      const node: InsightNode = {
        id: insightId, type: "insight",
        title: "User prefers Rust",
        status: "active", created_by: "agent",
        created_at: Date.now(), updated_at: Date.now(),
        last_verified: Date.now(), last_touched: Date.now(),
        domain: "user-preference", tags: [],
        changelog: [],
        statement: "User prefers Rust",
        confidence: 0.9, sources: [],
      };
      await ctx.storage.writeNode(node);

      const result = await llmDedup(ctx, "User prefers Rust", "user-preference");
      assert.equal(result.isDuplicate, true);
      assert.equal(result.duplicateId, insightId);
    });

    it("respects domain filter in candidate search", async () => {
      const ctx = makeCtx();
      const insightId = ctx.storage.generateId();
      ctx.nodeIndex.addSkeleton({
        id: insightId, type: "insight", title: "User prefers Rust",
        status: "active", created_by: "agent", domain: "user-preference",
        created_at: Date.now(), updated_at: Date.now(),
        last_verified: Date.now(), last_touched: Date.now(),
        tags: [], snippet: "Rust preference",
      });
      await ctx.storage.writeNode({
        id: insightId, type: "insight", title: "User prefers Rust",
        status: "active", created_by: "agent",
        created_at: Date.now(), updated_at: Date.now(),
        last_verified: Date.now(), last_touched: Date.now(),
        domain: "user-preference", tags: [],
        changelog: [],
        statement: "User prefers Rust", confidence: 0.9, sources: [],
      });

      // Search in a different domain — should find no candidates
      const result = await llmDedup(ctx, "User prefers Rust", "project-status");
      assert.equal(result.isDuplicate, false);
    });
  });

  describe("llmRerank", () => {
    it("returns all as ranked when <= 3 candidates", async () => {
      const ctx = makeCtx();
      const candidates = [
        { nodeId: "A", title: "A", snippet: "a" },
        { nodeId: "B", title: "B", snippet: "b" },
      ];

      const result = await llmRerank(ctx, "query", candidates);
      assert.equal(result.ranked.length, 2);
      assert.equal(result.irrelevant.length, 0);
    });
  });
});
