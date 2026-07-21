#!/usr/bin/env node
/**
 * pi-kb: Test runner
 *
 * Usage: node run_tests.cjs
 *
 * Runs all test suites using jiti for TypeScript module loading.
 * All 142 tests across 4 suites should pass.
 */

const { createJiti } = require("/root/data/nenv/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti");

const jiti = createJiti(__filename, { debug: false });

// Load source modules
const { LinkGraph } = jiti(__dirname + "/link_graph.ts");
const { NodeIndex } = jiti(__dirname + "/node_index.ts");
const { KBStorage } = jiti(__dirname + "/storage.ts");
const { createKBSystem } = jiti(__dirname + "/kb_system.ts");
const {
  recordObservation, updateObservation, createReflection, createInsight,
  updateInsight, retrieve, addEvidence, createLink, createContradiction,
  resolveContradiction, deprecateNode, createMoc, addToMoc, reReflect,
  adjustConfidenceByEvidenceAge, llmDedup, llmRerank,
} = jiti(__dirname + "/kb_tools.ts");

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// ─── Test Framework ───────────────────────────────────────────

const stats = { passed: 0, failed: 0, suites: 0 };

function suite(name) {
  stats.suites++;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"=".repeat(60)}`);
}

function assert(cond, msg) {
  if (!cond) { console.log(`  ✗ ${msg}`); stats.failed++; }
  else { console.log(`  ✓ ${msg}`); stats.passed++; }
}

function assertEquals(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) console.log(`  ✗ ${msg} — ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  ok ? stats.passed++ : stats.failed++;
}

function assertMatch(str, pattern, msg) {
  const ok = (typeof str === "string" && str.includes(pattern));
  if (!ok) console.log(`  ✗ ${msg} — "${str?.slice(0, 80)}" doesn't contain "${pattern}"`);
  ok ? stats.passed++ : stats.failed++;
}

function assertGt(a, b, msg) {
  if (a > b) { console.log(`  ✓ ${msg}`); stats.passed++; }
  else { console.log(`  ✗ ${msg} — ${a} <= ${b}`); stats.failed++; }
}

function mkLink(from, to, type = "related_to", status = "active") {
  return { from, to, type, status, created_at: Date.now() };
}

// ─── Mock Storage ─────────────────────────────────────────────

class MockStorage {
  constructor() {
    this.nodes = new Map();
    this.meta = {
      version: 1, created_at: Date.now(), updated_at: Date.now(), total_nodes: 0,
      reflection_triggers: { unreflected_observations: 0, threshold: 3, last_reflection_at: null, domains_with_pending: [] },
      knowledge_gaps: [],
    };
  }
  generateId() { return `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
  async writeNode(node) { this.nodes.set(node.id, JSON.parse(JSON.stringify(node))); }
  async readNode(id) { const n = this.nodes.get(id); return n ? JSON.parse(JSON.stringify(n)) : null; }
  async readMeta() { return JSON.parse(JSON.stringify(this.meta)); }
  async writeMeta(meta) { this.meta = JSON.parse(JSON.stringify(meta)); }
  async nodeMtime() { return Date.now(); }
  async listNodeIds() { return [...this.nodes.keys()]; }
  async readNodeSkeleton(id) {
    const n = this.nodes.get(id); if (!n) return null;
    return { id: n.id, type: n.type, title: n.title, status: n.status, created_by: n.created_by, domain: n.domain, created_at: n.created_at, updated_at: n.updated_at, last_verified: n.last_verified, last_touched: n.last_touched, tags: n.tags, snippet: n.content?.slice(0, 100) || "" };
  }
  nodePath(id) { return `/mock/${id}.md`; }
  async deleteNode() {}
  async appendAutoLog() {}
  async ensure() {}
}

function makeCtx(overrides = {}) {
  const storage = new MockStorage();
  const nodeIndex = new NodeIndex(storage);
  return {
    nodeIndex, storage,
    sessionId: "test-session", kbRoot: "/mock/kb",
    llmCaller: { async call() { return null; } },
    config: { selfCorrectionWindowMs: 60 * 60 * 1000, pendingLinkTimeoutMs: 48 * 60 * 60 * 1000, reflectionQualityThreshold: 0.02, llmDedupModel: "test" },
    ...overrides,
  };
}

function mkObs(id, overrides = {}) {
  const now = overrides.created_at || Date.now();
  return { id, type: "observation", title: overrides.title || "Obs", status: overrides.status || "active", created_by: "agent", domain: overrides.domain || "user-preference", created_at: now, updated_at: now, last_verified: overrides.last_verified ?? now, last_touched: now, tags: overrides.tags || [], snippet: overrides.snippet || `content for ${id}` };
}

async function seedObs(ctx, overrides = {}) {
  const id = ctx.storage.generateId();
  const now = overrides.created_at || Date.now();
  const node = {
    id, type: "observation", title: overrides.title || "Test", status: "active", created_by: "agent",
    created_at: now, updated_at: now, last_verified: now, last_touched: now,
    domain: overrides.domain || "user-preference", tags: overrides.tags || [],
    changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "" }],
    source_log: "[[test]]", content: overrides.content || "test content",
    significance: overrides.significance || "medium",
  };
  await ctx.storage.writeNode(node);
  ctx.nodeIndex.addSkeleton({ id, type: node.type, title: node.title, status: node.status, created_by: node.created_by, domain: node.domain, created_at: node.created_at, updated_at: node.updated_at, last_verified: node.last_verified, last_touched: node.last_touched, tags: node.tags, snippet: node.content?.slice(0, 100) || "" });
  return node;
}

async function seedSkeletons(ctx, skeletons) {
  for (const s of skeletons) ctx.nodeIndex.addSkeleton(s);
}

// ══════════════════════════════════════════════════════════════
//  Suite 1: LinkGraph
// ══════════════════════════════════════════════════════════════

suite("LinkGraph");

(function testAddRetrieve() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "B", "supported_by"));
  assertEquals(g.getOutgoing("A").length, 1, "addLink creates outgoing");
  assertEquals(g.getOutgoing("A")[0].to, "B", "correct target");
  assertEquals(g.getIncoming("B").length, 1, "addLink creates incoming");
})();

(function testMultipleLinks() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "B")); g.addLink(mkLink("A", "C"));
  assertEquals(g.getOutgoing("A").length, 2, "multiple outgoing");
  assertEquals(g.size, 2, "size tracks links");
})();

(function testUpdateExisting() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "B", "related_to"));
  g.addLink(mkLink("A", "B", "supported_by"));
  assertEquals(g.getOutgoing("A").length, 1, "update does not duplicate");
  assertEquals(g.getOutgoing("A")[0].type, "supported_by", "updates type");
})();

(function testBFS() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "B")); g.addLink(mkLink("B", "D")); g.addLink(mkLink("A", "C"));
  const bfs = g.bfs("A", 2);
  assertEquals(bfs.map(r => r.nodeId).sort(), ["A", "B", "C", "D"].sort(), "BFS finds all nodes");
  assertEquals(bfs[0].depth, 0, "start node depth=0");
})();

(function testBFSCycles() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "B")); g.addLink(mkLink("B", "C")); g.addLink(mkLink("C", "A"));
  assert(g.bfs("A", 5).length <= 3, "BFS terminates with cycles");
})();

(function testBFSMaxDepth() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "B")); g.addLink(mkLink("B", "C")); g.addLink(mkLink("C", "D"));
  assertEquals(g.bfs("A", 1).map(r => r.nodeId), ["A", "B"], "maxDepth respected");
})();

(function testBFSFilterType() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "B", "supported_by")); g.addLink(mkLink("A", "C", "related_to"));
  assertEquals(g.bfs("A", 2, ["supported_by"]).map(r => r.nodeId), ["A", "B"], "BFS filters by type");
})();

(function testBFSSkipsPending() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "B", "related_to", "pending")); g.addLink(mkLink("A", "C"));
  assert(!g.bfs("A", 2).map(r => r.nodeId).includes("B"), "BFS skips pending");
})();

(function testReverseBFS() {
  const g = new LinkGraph();
  g.addLink(mkLink("B", "A")); g.addLink(mkLink("C", "B"));
  assertEquals(g.reverseBfs("A", 2).map(r => r.nodeId).sort(), ["A", "B", "C"].sort(), "reverse BFS");
})();

(function testRemoveLink() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "B")); g.addLink(mkLink("A", "C"));
  g.removeLink("A", "B");
  assertEquals(g.getOutgoing("A").length, 1, "removeLink reduces outgoing");
  assertEquals(g.getIncoming("B").length, 0, "removeLink clears incoming");
})();

(function testRemoveLinksFrom() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "B")); g.addLink(mkLink("A", "C")); g.addLink(mkLink("X", "A"));
  g.removeLinksFrom("A");
  assertEquals(g.getOutgoing("A").length, 0, "removeLinksFrom clears outgoing");
  assertEquals(g.getIncoming("A").length, 1, "incoming TO node preserved");
})();

(function testRipple() {
  const g = new LinkGraph();
  g.addLink(mkLink("B", "A", "supported_by")); g.addLink(mkLink("C", "B", "supported_by"));
  const affected = g.getAffectedNodes("A");
  assertEquals(affected.map(a => a.nodeId), ["B", "C"], "ripple finds dependents");
  assert(affected[0].impact > affected[1].impact, "impact decays");
})();

(function testRippleStrongOnly() {
  const g = new LinkGraph();
  g.addLink(mkLink("B", "A", "supported_by")); g.addLink(mkLink("C", "A", "related_to"));
  assertEquals(g.getAffectedNodes("A").map(a => a.nodeId), ["B"], "ripple only strong links");
})();

(function testPendingResolution() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "Z", "related_to", "pending"));
  assertEquals(g.resolvePendingLinks("Z").length, 1, "resolvePendingLinks activates");
  assertEquals(g.getOutgoing("A")[0].status, "active", "status updated");
})();

(function testPendingExpiration() {
  const g = new LinkGraph();
  g.addLink({ from: "A", to: "Z", type: "related_to", status: "pending", created_at: Date.now() - 100 * 60 * 60 * 1000 });
  assertEquals(g.expirePendingLinks(48 * 60 * 60 * 1000).length, 1, "old links expire");
})();

(function testDegenerateNodes() {
  const g = new LinkGraph();
  g.addLink(mkLink("X", "A")); g.addLink(mkLink("A", "Y"));
  g.addLink(mkLink("P", "B")); g.addLink(mkLink("B", "Q")); g.addLink(mkLink("B", "R"));
  assertEquals(g.findDegenerateNodes(), ["A"], "one-in-one-out detected");
})();

(function testJSONRoundtrip() {
  const g = new LinkGraph();
  g.addLink(mkLink("A", "B", "supported_by")); g.addLink(mkLink("B", "C"));
  const restored = LinkGraph.fromJSON(g.toJSON());
  assertEquals(restored.size, 2, "JSON roundtrip size");
  assertEquals(restored.getOutgoing("A")[0].to, "B", "JSON roundtrip data");
})();

(function testEdgeCases() {
  const g = new LinkGraph();
  assertEquals(g.getOutgoing("X"), [], "empty outgoing");
  assertEquals(g.getIncoming("X"), [], "empty incoming");
  assert(!g.hasLink("A", "B"), "hasLink false initially");
  g.addLink(mkLink("A", "B")); assert(g.hasLink("A", "B"), "hasLink true");
  assert(!g.removeLink("A", "C"), "removeLink false on nonexistent");
})();

// ══════════════════════════════════════════════════════════════
//  Suite 2: kb_tools
// ══════════════════════════════════════════════════════════════

suite("kb_tools");

(async () => {
  const ctx = makeCtx();
  const r = await recordObservation(ctx, { content: "User likes TypeScript", significance: "high", domain: "user-preference" });
  assertMatch(r.content[0].text, "✅", "recordObservation returns success");
  const node = await ctx.storage.readNode(r.details.id);
  assert(node?.content === "User likes TypeScript", "content preserved");
  assertEquals((await ctx.storage.readMeta()).reflection_triggers.unreflected_observations, 1, "counter incremented");
})();

(async () => {
  const ctx = makeCtx();
  ctx.storage.meta.reflection_triggers.threshold = 1;
  const r = await recordObservation(ctx, { content: "t", significance: "low", domain: "user-preference" });
  assertMatch(r.content[0].text, "⚠", "warns at threshold");
})();

(async () => {
  const ctx = makeCtx();
  const obs = await seedObs(ctx, { content: "old", created_at: Date.now() });
  const r = await updateObservation(ctx, { id: obs.id, content: "new", reason: "typo" });
  assertMatch(r.content[0].text, "✅", "update within window");
  assertEquals((await ctx.storage.readNode(obs.id)).content, "new", "content updated");
})();

(async () => {
  const ctx = makeCtx();
  const obs = await seedObs(ctx, { content: "old", created_at: Date.now() - 3 * 60 * 60 * 1000 });
  const r = await updateObservation(ctx, { id: obs.id, content: "too late", reason: "typo" });
  assertMatch(r.content[0].text, "❌", "block outside window");
})();

(async () => {
  const ctx = makeCtx();
  const obs = await seedObs(ctx, { significance: "low" });
  await updateObservation(ctx, { id: obs.id, significance: "high", reason: "reeval" });
  assertEquals((await ctx.storage.readNode(obs.id)).significance, "high", "significance updatable");
})();

(async () => {
  const ctx = makeCtx();
  const obs = await seedObs(ctx);
  const r = await createInsight(ctx, { title: "Rust pref", statement: "User prefers Rust", confidence: 0.85, sources: [obs.id], domain: "user-preference" });
  assertMatch(r.content[0].text, "✅", "insight created");
  assertEquals(ctx.nodeIndex.graph.getOutgoing(r.details.id).length, 1, "evidence link created");
})();

(async () => {
  const ctx = makeCtx();
  const r = await createInsight(ctx, { title: "t", statement: "t", confidence: 0.9, sources: ["no-such-id"], domain: "user-preference" });
  assertMatch(r.content[0].text, "❌", "blocks missing sources");
})();

(async () => {
  const ctx = makeCtx();
  const obs = await seedObs(ctx, { created_at: Date.now() - 200 * 24 * 60 * 60 * 1000 });
  ctx.nodeIndex.updateSkeleton(obs.id, { status: "stale" });
  const r = await createInsight(ctx, { title: "Old insight", statement: "Old", confidence: 0.9, sources: [obs.id], domain: "user-preference" });
  assert((await ctx.storage.readNode(r.details.id)).confidence <= 0.6, "stale sources cap confidence");
})();

(async () => {
  const ctx = makeCtx();
  const obs = await seedObs(ctx);
  const r = await createInsight(ctx, { title: "Orig", statement: "Orig", confidence: 0.8, sources: [obs.id], domain: "user-preference" });
  ctx.nodeIndex.addSkeleton({ id: "dep-1", type: "insight", title: "Dep", status: "active", created_by: "agent", domain: "user-preference", created_at: Date.now(), updated_at: Date.now(), last_verified: Date.now(), last_touched: Date.now(), tags: [], snippet: "" });
  ctx.nodeIndex.graph.addLink({ from: "dep-1", to: r.details.id, type: "supported_by", status: "active", created_at: Date.now() });
  const ur = await updateInsight(ctx, { id: r.details.id, confidence: 0.3, reason: "changed" });
  assertMatch(ur.content[0].text, "Ripple", "ripple triggered");
  assertEquals(ctx.nodeIndex.getSkeleton("dep-1").status, "stale", "dependent marked stale");
})();

(async () => {
  const ctx = makeCtx();
  const r = await retrieve(ctx, { query: "nothing" });
  assertMatch(r.content[0].text, "无结果", "empty KB");
  assert((await ctx.storage.readMeta()).knowledge_gaps.length > 0, "knowledge gap");
})();

(async () => {
  const ctx = makeCtx();
  await seedObs(ctx, { content: "Rust programming", tags: ["rust"] });
  await seedObs(ctx, { content: "Python data", tags: ["python"] });
  const r = await retrieve(ctx, { query: "Rust" });
  assertMatch(r.content[0].text, "Rust", "finds match");
  assert(!r.content[0].text.includes("Python"), "excludes non-match");
})();

(async () => {
  const ctx = makeCtx();
  const id = ctx.storage.generateId();
  ctx.nodeIndex.addSkeleton({ id, type: "observation", title: "Fresh", status: "active", created_by: "agent", domain: "user-preference", created_at: Date.now(), updated_at: Date.now(), last_verified: Date.now(), last_touched: Date.now(), tags: [], snippet: "" });
  const c = await adjustConfidenceByEvidenceAge(ctx.nodeIndex, 0.9, [id], "user-preference");
  assert(c >= 0.85, `fresh evidence confidence >= 0.85, got ${c}`);
  assertEquals(await adjustConfidenceByEvidenceAge(ctx.nodeIndex, 0.9, [], "user-preference"), 0.9, "no sources = base");
})();

(async () => {
  const ctx = makeCtx();
  const r = await llmDedup(ctx, "unique", "user-preference");
  assertEquals(r.isDuplicate, false, "no duplicate");
})();

(async () => {
  const ctx = makeCtx();
  const id = ctx.storage.generateId();
  ctx.nodeIndex.addSkeleton({ id, type: "insight", title: "User prefers Rust", status: "active", created_by: "agent", domain: "user-preference", created_at: Date.now(), updated_at: Date.now(), last_verified: Date.now(), last_touched: Date.now(), tags: [], snippet: "Rust" });
  await ctx.storage.writeNode({ id, type: "insight", title: "User prefers Rust", statement: "User prefers Rust", confidence: 0.9, sources: [], status: "active", created_by: "agent", created_at: Date.now(), updated_at: Date.now(), last_verified: Date.now(), last_touched: Date.now(), domain: "user-preference", tags: [], changelog: [] });
  const r = await llmDedup(ctx, "User prefers Rust", "user-preference");
  assertEquals(r.isDuplicate, true, "exact title = duplicate");
})();

(async () => {
  const ctx = makeCtx();
  const r = await llmRerank(ctx, "q", [{ nodeId: "A", title: "A", snippet: "a" }, { nodeId: "B", title: "B", snippet: "b" }]);
  assertEquals(r.ranked.length, 2, "≤3 all ranked");
})();

// ─── Extracted tools: quick smoke tests ────────────────

(async () => {
  const ctx = makeCtx();
  const obs = await seedObs(ctx, { content: "Evidence test" });
  const ir = await createInsight(ctx, { title: "ET", statement: "Evidence target", confidence: 0.5, sources: [obs.id], domain: "user-preference" });
  const r = await addEvidence(ctx, { insightId: ir.details.id, sourceId: obs.id });
  assertMatch(r.content[0].text, "✅", "addEvidence success");
})();

(async () => {
  const ctx = makeCtx();
  await seedSkeletons(ctx, [mkObs("a"), mkObs("b")]);
  const r = await createLink(ctx, { from: "a", to: "b", type: "related_to" });
  assertMatch(r.content[0].text, "✅", "createLink success");
  assert(ctx.nodeIndex.graph.hasLink("a", "b"), "link created");
})();

(async () => {
  const ctx = makeCtx();
  await seedSkeletons(ctx, [mkObs("a"), mkObs("b")]);
  const r = await createContradiction(ctx, { title: "Test contra", nodeA: "a", nodeB: "b", severity: "surface" });
  assertMatch(r.content[0].text, "✅", "createContradiction success");
})();

(async () => {
  const ctx = makeCtx();
  await seedSkeletons(ctx, [mkObs("a"), mkObs("b")]);
  const cr = await createContradiction(ctx, { title: "TC", nodeA: "a", nodeB: "b", severity: "surface" });
  const r = await resolveContradiction(ctx, { contradictionId: cr.details.id, resolution: "resolved", newInsightTitle: "Refined", newInsightStatement: "Refined insight", newConfidence: 0.9, domain: "user-preference" });
  assertMatch(r.content[0].text, "✅", "resolveContradiction success");
})();

(async () => {
  const ctx = makeCtx();
  const oldNode = await seedObs(ctx, { title: "old" });
  const newNode = await seedObs(ctx, { title: "new" });
  const r = await deprecateNode(ctx, { oldNodeId: oldNode.id, newNodeId: newNode.id, reason: "replaced" });
  assertMatch(r.content[0].text, "✅", "deprecateNode success");
  assertEquals((await ctx.storage.readNode(oldNode.id)).status, "stable", "old marked stable");
})();

(async () => {
  const ctx = makeCtx();
  await seedSkeletons(ctx, [mkObs("a"), mkObs("b")]);
  const r = await createMoc(ctx, { title: "Test MOC", childNodes: ["a", "b"], domain: "user-preference" });
  assertMatch(r.content[0].text, "✅", "createMoc success");
})();

(async () => {
  const ctx = makeCtx();
  await seedSkeletons(ctx, [mkObs("child")]);
  const mr = await createMoc(ctx, { title: "M", childNodes: [], domain: "user-preference" });
  const r = await addToMoc(ctx, { mocId: mr.details.id, nodeId: "child" });
  assertMatch(r.content[0].text, "✅", "addToMoc success");
})();

(async () => {
  const ctx = makeCtx();
  const r = await reReflect(ctx, { previousReflectionId: "nonexistent", content: "Re-reflect content" });
  assertMatch(r.content[0].text, "✅", "reReflect success");
})();

// ══════════════════════════════════════════════════════════════
//  Suite 3: NodeIndex
// ══════════════════════════════════════════════════════════════

suite("NodeIndex");

(async () => {
  const ctx = makeCtx();
  await seedSkeletons(ctx, [
    mkObs("a", { title: "Rust preferences", tags: ["rust"], snippet: "User prefers Rust" }),
    mkObs("b", { title: "Python data", tags: ["python"], snippet: "Python for data science" }),
  ]);
  assertEquals(ctx.nodeIndex.search("Rust").length, 1, "search finds Rust");
  assertEquals(ctx.nodeIndex.search("python").length, 1, "search finds by tag");
  assertEquals(ctx.nodeIndex.search("zzz").length, 0, "no match empty");
  assertEquals(ctx.nodeIndex.search("preferences", { domain: "user-preference" }).length, 1, "domain filter");
  assertEquals(ctx.nodeIndex.search("Rust", { type: "observation" }).length, 1, "type filter works");
  assertEquals(ctx.nodeIndex.search("Rust", { type: "insight" }).length, 0, "wrong type empty");
})();

(() => {
  const ctx = makeCtx();
  seedSkeletons(ctx, [
    mkObs("a", { status: "active" }), mkObs("b", { status: "stale" }),
    mkObs("c", { status: "archived" }), mkObs("d", { status: "dead" }),
    mkObs("e", { status: "stable" }),
  ]);
  const ids = ["a", "b", "c", "d", "e"];
  assertEquals(ctx.nodeIndex.filterByScope(ids, "routine").sort(), ["a", "e"].sort(), "routine scope");
  assertEquals(ctx.nodeIndex.filterByScope(ids, "deep").sort(), ["a", "b", "c", "e"].sort(), "deep scope");
  assertEquals(ctx.nodeIndex.filterByScope(ids, "forensic").length, 5, "forensic all");
})();

(() => {
  const ctx = makeCtx();
  const now = Date.now();
  seedSkeletons(ctx, [
    mkObs("a", { status: "active", created_at: now }),
    mkObs("b", { status: "stale", created_at: now }),
    mkObs("c", { status: "active", created_at: now - 365 * 24 * 60 * 60 * 1000 }),
  ]);
  const ranked = ctx.nodeIndex.rank(["a", "b", "c"]);
  assertEquals(ranked[0].nodeId, "a", "active+recent ranks first");
})();

(async () => {
  const ctx = makeCtx();
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const vOld = Date.now() - 200 * 24 * 60 * 60 * 1000;
  seedSkeletons(ctx, [
    mkObs("a", { status: "active", created_at: old, updated_at: old }),
    mkObs("b", { status: "stable", created_at: vOld, updated_at: vOld, last_verified: vOld }),
  ]);
  const lc = ctx.nodeIndex.advanceLifecycles();
  assert(lc.toStable.includes("a"), "active→stable");
  assert(lc.toStale.includes("b"), "stable→stale after 90d unverified");
})();

(() => {
  const ctx = makeCtx();
  const longAgo = Date.now() - 200 * 24 * 60 * 60 * 1000;
  seedSkeletons(ctx, [
    mkObs("a", { domain: "user-preference", last_verified: longAgo }),
    mkObs("b", { domain: "project-status", last_verified: longAgo }),
    mkObs("c", { domain: "user-preference", last_verified: Date.now() }),
  ]);
  const hl = ctx.nodeIndex.checkHalflives();
  assertEquals(hl.length, 2, "two stale nodes");
  assert(hl.find(r => r.nodeId === "b").isCritical, "project-status 200d critical");
})();

(() => {
  const ctx = makeCtx();
  seedSkeletons(ctx, [mkObs("a", { status: "active" }), mkObs("b", { status: "archived" })]);
  assert(ctx.nodeIndex.markStale("a", "test"), "markStale success");
  assertEquals(ctx.nodeIndex.getSkeleton("a").status, "stale", "status changed");
  assert(!ctx.nodeIndex.markStale("b", "test"), "markStale blocked on archived");
  ctx.nodeIndex.touch("a");
  assert(ctx.nodeIndex.getSkeleton("a").last_verified >= Date.now() - 1000, "touch updates verified");
})();

(() => {
  const ctx = makeCtx();
  seedSkeletons(ctx, [
    mkObs("a", { domain: "user-preference", status: "stale" }),
    mkObs("b", { domain: "user-preference", status: "stale" }),
    mkObs("c", { domain: "project-status", status: "stale" }),
  ]);
  const agg = ctx.nodeIndex.aggregateStale();
  assertEquals(agg.length, 2, "two domains");
  assertEquals(agg.find(a => a.domain === "user-preference").count, 2, "correct count");
})();

// ══════════════════════════════════════════════════════════════
//  Suite 4: Storage + KBSystem
// ══════════════════════════════════════════════════════════════

suite("Storage + KBSystem");

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-storage-test-"));
  const storage = new KBStorage(tmpDir);
  await storage.ensure();

  const id = storage.generateId(); const now = Date.now();

  // Observation roundtrip
  await storage.writeNode({
    id, type: "observation", title: "Test Obs", status: "active", created_by: "agent",
    created_at: now, updated_at: now, last_verified: now, last_touched: now,
    domain: "user-preference", tags: ["test", "yaml"],
    changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "roundtrip test" }],
    source_log: "[[session-test]]", content: "Multi\nline\ncontent",
    significance: "high",
  });
  const obs = await storage.readNode(id);
  assert(obs !== null, "observation read back");
  assertEquals(obs.tags, ["test", "yaml"], "tags preserved");
  assertEquals(obs.changelog.length, 1, "changelog preserved");
  assertEquals(obs.changelog[0].detail, "roundtrip test", "changelog detail intact");
  assertEquals(obs.content, "Multi\nline\ncontent", "multi-line content preserved");

  // Insight roundtrip
  const iid = storage.generateId();
  await storage.writeNode({
    id: iid, type: "insight", title: "TI", statement: "Statement text", confidence: 0.85,
    sources: [id], status: "active", created_by: "agent",
    created_at: now, updated_at: now, last_verified: now, last_touched: now,
    domain: "user-preference", tags: [], changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "" }],
  });
  const ins = await storage.readNode(iid);
  assertEquals(ins.statement, "Statement text", "statement preserved");
  assertEquals(ins.confidence, 0.85, "confidence preserved");
  assertEquals(ins.sources, [id], "sources preserved");

  // Contradiction roundtrip
  const cid = storage.generateId();
  await storage.writeNode({
    id: cid, type: "contradiction", title: "TC", conflicting_nodes: [id, iid],
    severity: "substantial", contradiction_state: "unresolved",
    status: "active", created_by: "agent",
    created_at: now, updated_at: now, last_verified: now, last_touched: now,
    domain: "agent-self-knowledge", tags: [], changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "" }],
  });
  const contra = await storage.readNode(cid);
  assertEquals(contra.conflicting_nodes, [id, iid], "conflicting_nodes preserved");
  assertEquals(contra.contradiction_state, "unresolved", "contradiction_state preserved");

  // MOC roundtrip
  const mid = storage.generateId();
  await storage.writeNode({
    id: mid, type: "moc", title: "MOC", child_nodes: [id, iid], description: "Test MOC",
    status: "active", created_by: "agent",
    created_at: now, updated_at: now, last_verified: now, last_touched: now,
    domain: "user-preference", tags: [], changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "" }],
  });
  const moc = await storage.readNode(mid);
  assertEquals(moc.child_nodes, [id, iid], "child_nodes preserved");

  // Reflection roundtrip
  const rid = storage.generateId();
  await storage.writeNode({
    id: rid, type: "reflection", title: "TR", period: "2026-07-20",
    content: "Reflection body", sources: [id], secondary_sources: [],
    quality: "high", status: "active", created_by: "agent",
    created_at: now, updated_at: now, last_verified: now, last_touched: now,
    domain: "agent-self-knowledge", tags: [], changelog: [{ timestamp: now, actor: "agent", action: "created", detail: "" }],
  });
  const refl = await storage.readNode(rid);
  assertEquals(refl.period, "2026-07-20", "period preserved");
  assertEquals(refl.quality, "high", "quality preserved");
  assert(refl.content.length > 0, "content not empty");

  // Auto-log
  await storage.appendAutoLog("test-s", { role: "user", content: "Hello", timestamp: now });
  const logContent = fs.readFileSync(path.join(tmpDir, "logs", "test-s.md"), "utf-8");
  assert(logContent.includes("Hello"), "auto-log works");

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-system-test-"));
  const kb = await createKBSystem(tmpDir);
  let r = await kb.initialize();
  assertEquals(r.nodesLoaded, 0, "empty KB: 0 nodes");

  const id = kb.storage.generateId();
  const now = Date.now();
  await kb.storage.writeNode({
    id, type: "observation", title: "Sys test", status: "active", created_by: "agent",
    created_at: now, updated_at: now, last_verified: now, last_touched: now,
    domain: "user-preference", tags: [], changelog: [],
    source_log: "", content: "test", significance: "medium",
  });

  r = await kb.reload();
  assertEquals(r.nodesLoaded, 1, "reload picks up node");
  assert(kb.nodeIndex.has(id), "nodeIndex has node");

  await kb.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ══════════════════════════════════════════════════════════════
//  Results
// ══════════════════════════════════════════════════════════════

setTimeout(() => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  TOTAL: ${stats.passed} passed, ${stats.failed} failed (${stats.suites} suites)`);
  console.log(`${"=".repeat(60)}`);
  process.exit(stats.failed > 0 ? 1 : 0);
}, 3000);
