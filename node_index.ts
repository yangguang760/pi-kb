/**
 * pi-kb: In-memory node index
 *
 * Central coordination point between storage and link graph.
 * Maintains a skeleton index of all nodes for fast lookup,
 * with full content loaded from disk on demand.
 */

import type {
  KBNode,
  NodeSkeleton,
  NodeType,
  NodeStatus,
  Domain,
  Creator,
  LinkType,
  ChangelogEntry,
  KBMeta,
  RetrieveScope,
} from "./types";
import {
  STATUS_RANK_WEIGHT,
  RETRIEVAL_DEFAULTS,
  DOMAIN_HALFLIFE_DAYS,
  LIFECYCLE_RULES,
} from "./types";
import type { KBStorage } from "./storage";
import type { LinkGraph, BFSStep, AffectedNode } from "./link_graph";
import { LinkGraph as LinkGraphClass } from "./link_graph";

// ─── Index State ──────────────────────────────────────────────

export class NodeIndex {
  private skeletons: Map<string, NodeSkeleton> = new Map();
  private linkGraph: LinkGraph;

  constructor(
    private storage: KBStorage,
    linkGraph?: LinkGraph
  ) {
    this.linkGraph = linkGraph || new LinkGraphClass();
  }

  get graph(): LinkGraph {
    return this.linkGraph;
  }

  // ─── Population ──────────────────────────────────────────

  /**
   * Full index rebuild from disk.
   * Called on session_start or when consistency check fails.
   */
  async rebuild(): Promise<{ loaded: number; errors: string[] }> {
    this.skeletons.clear();
    this.linkGraph = new LinkGraphClass();
    const ids = await this.storage.listNodeIds();
    const errors: string[] = [];
    let loaded = 0;

    for (const id of ids) {
      const skeleton = await this.storage.readNodeSkeleton(id);
      if (skeleton) {
        this.skeletons.set(id, skeleton);
        loaded++;
      } else {
        errors.push(`Failed to parse skeleton for ${id}`);
      }
    }

    // Reconstruct link graph from skeleton metadata
    const now = Date.now();
    for (const skeleton of this.skeletons.values()) {
      // Reflection/insight sources → supported_by links
      if (skeleton.sources) {
        for (const srcId of skeleton.sources) {
          if (this.skeletons.has(srcId)) {
            this.linkGraph.addLink({
              from: skeleton.id, to: srcId, type: "supported_by",
              status: "active", created_at: now,
            });
          }
        }
      }
      // MOC child_nodes → parent_of links
      if (skeleton.child_nodes) {
        for (const childId of skeleton.child_nodes) {
          if (this.skeletons.has(childId)) {
            this.linkGraph.addLink({
              from: skeleton.id, to: childId, type: "parent_of",
              status: "active", created_at: now,
            });
          }
        }
      }
    }

    return { loaded, errors };
  }

  /**
   * Incremental sync: detect new, modified, and deleted nodes.
   */
  async sync(): Promise<SyncResult> {
    const diskIds = new Set(await this.storage.listNodeIds());
    const indexIds = new Set(this.skeletons.keys());
    const result: SyncResult = {
      added: [],
      modified: [],
      deleted: [],
      errors: [],
    };

    // Detect new nodes on disk
    for (const id of diskIds) {
      if (!indexIds.has(id)) {
        const skeleton = await this.storage.readNodeSkeleton(id);
        if (skeleton) {
          this.skeletons.set(id, skeleton);
          result.added.push(id);
        } else {
          result.errors.push(`Cannot parse new node: ${id}`);
        }
      }
    }

    // Detect modified nodes (mtime > index timestamp)
    for (const id of diskIds) {
      if (!indexIds.has(id) || result.added.includes(id)) continue;
      const skeleton = this.skeletons.get(id)!;
      const mtime = await this.storage.nodeMtime(id);
      if (mtime && mtime > skeleton.updated_at + 1000) {
        // 1s buffer for filesystem precision
        // Reload skeleton
        const updated = await this.storage.readNodeSkeleton(id);
        if (updated) {
          this.skeletons.set(id, updated);
          result.modified.push(id);
        }
      }
    }

    // Detect deleted nodes (in index but not on disk)
    for (const id of indexIds) {
      if (!diskIds.has(id)) {
        this.skeletons.delete(id);
        this.linkGraph.removeLinksFrom(id);
        result.deleted.push(id);
      }
    }

    return result;
  }

  /**
   * Consistency self-check (principle 13.5, scenario 20).
   * Samples a subset of nodes and validates file existence / mtime.
   */
  async consistencyCheck(
    sampleSize: number = 50
  ): Promise<ConsistencyResult> {
    const ids = [...this.skeletons.keys()];
    const sample = this.sample(ids, Math.min(sampleSize, ids.length));
    const missing: string[] = [];
    const modified: string[] = [];

    for (const id of sample) {
      const skeleton = this.skeletons.get(id);
      if (!skeleton) continue;

      const mtime = await this.storage.nodeMtime(id);
      if (mtime === null) {
        missing.push(id);
      } else if (mtime > skeleton.updated_at + 1000) {
        modified.push(id);
      }
    }

    const inconsistencyRate = (missing.length + modified.length) / sample.length;

    return {
      checked: sample.length,
      missing,
      modified,
      inconsistencyRate,
      needsFullRebuild: inconsistencyRate > 0.1,
    };
  }

  // ─── CRUD ─────────────────────────────────────────────────

  addSkeleton(skeleton: NodeSkeleton): void {
    this.skeletons.set(skeleton.id, skeleton);

    // Auto-create links from sources/child_nodes metadata
    const now = Date.now();
    if (skeleton.sources) {
      for (const srcId of skeleton.sources) {
        if (this.skeletons.has(srcId)) {
          this.linkGraph.addLink({
            from: skeleton.id, to: srcId, type: "supported_by",
            status: "active", created_at: now,
          });
        }
      }
    }
    if (skeleton.child_nodes) {
      for (const childId of skeleton.child_nodes) {
        if (this.skeletons.has(childId)) {
          this.linkGraph.addLink({
            from: skeleton.id, to: childId, type: "parent_of",
            status: "active", created_at: now,
          });
        }
      }
    }
  }

  updateSkeleton(
    id: string,
    updates: Partial<NodeSkeleton>
  ): boolean {
    const existing = this.skeletons.get(id);
    if (!existing) return false;
    this.skeletons.set(id, { ...existing, ...updates, updated_at: Date.now() });
    return true;
  }

  removeSkeleton(id: string): boolean {
    return this.skeletons.delete(id);
  }

  getSkeleton(id: string): NodeSkeleton | undefined {
    return this.skeletons.get(id);
  }

  async getNode(id: string): Promise<KBNode | null> {
    return this.storage.readNode(id);
  }

  has(id: string): boolean {
    return this.skeletons.has(id);
  }

  get size(): number {
    return this.skeletons.size;
  }

  /** Public accessor for iteration (used by /kb list command and UI) */
  getAllSkeletons(): NodeSkeleton[] {
    return [...this.skeletons.values()];
  }

  /** Get all skeleton IDs (used for serialization/debugging) */
  getAllIds(): string[] {
    return [...this.skeletons.keys()];
  }

  // ─── Full-text Search ─────────────────────────────────────

  /**
   * Keyword search across skeleton titles, snippets, and tags.
   * Returns matching node IDs ranked by match quality.
   */
  search(
    query: string,
    options: {
      type?: NodeType;
      domain?: Domain;
      status?: NodeStatus[];
    } = {}
  ): SearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: SearchResult[] = [];

    for (const [, skeleton] of this.skeletons) {
      // Filter by options
      if (options.type && skeleton.type !== options.type) continue;
      if (options.domain && skeleton.domain !== options.domain) continue;
      if (
        options.status &&
        !options.status.includes(skeleton.status)
      )
        continue;

      const searchable = [
        skeleton.title.toLowerCase(),
        skeleton.snippet.toLowerCase(),
        ...skeleton.tags.map((t) => t.toLowerCase()),
      ].join(" ");

      // Simple TF-like scoring: count term hits
      let score = 0;
      for (const term of terms) {
        const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        const matches = searchable.match(regex);
        if (matches) score += matches.length;
      }

      if (score > 0) {
        results.push({ nodeId: skeleton.id, score, skeleton });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Filter nodes by scope (for retrieval).
   */
  filterByScope(ids: string[], scope: RetrieveScope): string[] {
    const activeStatuses: NodeStatus[] = ["birth", "active", "stable"];
    const deepStatuses: NodeStatus[] = [
      ...activeStatuses,
      "stale",
      "archived",
    ];

    switch (scope) {
      case "routine":
        return ids.filter((id) => {
          const s = this.skeletons.get(id);
          return s && activeStatuses.includes(s.status);
        });
      case "deep":
        return ids.filter((id) => {
          const s = this.skeletons.get(id);
          return s && deepStatuses.includes(s.status);
        });
      case "forensic":
        return ids; // all, including dead
    }
  }

  /**
   * Rank nodes by lifecycle stage + recency.
   */
  rank(ids: string[]): { nodeId: string; rank: number }[] {
    const now = Date.now();
    return ids
      .map((id) => {
        const s = this.skeletons.get(id);
        if (!s) return { nodeId: id, rank: -1 };

        const statusWeight = STATUS_RANK_WEIGHT[s.status];
        // Recency: newer = higher (0..1 normalized)
        const ageDays = (now - s.updated_at) / (1000 * 60 * 60 * 24);
        const recencyWeight = Math.exp(-0.01 * ageDays); // ~halflife 70 days

        return {
          nodeId: id,
          rank: statusWeight * 0.6 + recencyWeight * 0.4,
        };
      })
      .sort((a, b) => b.rank - a.rank);
  }

  // ─── Lifecycle Management ─────────────────────────────────

  /**
   * Advance node lifecycles based on time rules.
   * Called on session_start.
   */
  advanceLifecycles(): LifecycleChanges {
    const now = Date.now();
    const changes: LifecycleChanges = {
      toStable: [],
      toStale: [],
      toArchived: [],
      toDead: [],
      contradictionEscalations: [],
    };

    for (const [id, skeleton] of this.skeletons) {
      const ageDays = (now - skeleton.updated_at) / (1000 * 60 * 60 * 24);
      const unverifiedDays =
        (now - skeleton.last_verified) / (1000 * 60 * 60 * 24);

      if (skeleton.status === "birth" || skeleton.status === "active") {
        if (ageDays >= LIFECYCLE_RULES.active_to_stable_days) {
          skeleton.status = "stable";
          changes.toStable.push(id);
        }
      }

      if (skeleton.status === "stable") {
        if (unverifiedDays >= LIFECYCLE_RULES.stable_to_stale_days) {
          skeleton.status = "stale";
          changes.toStale.push(id);
        }
      }

      if (skeleton.status === "stale") {
        if (unverifiedDays >= LIFECYCLE_RULES.stale_to_archived_days + LIFECYCLE_RULES.stable_to_stale_days) {
          skeleton.status = "archived";
          changes.toArchived.push(id);
        }
      }

      if (skeleton.status === "archived") {
        if (ageDays >= LIFECYCLE_RULES.archived_to_dead_days) {
          skeleton.status = "dead";
          changes.toDead.push(id);
        }
      }

      // Contradiction timeout escalation (principle 13.4, scenario 16)
      if (skeleton.type === "contradiction" && skeleton.status === "active") {
        const contradictionAgeDays = (now - skeleton.created_at) / (1000 * 60 * 60 * 24);
        // unresolved → chronic after 30 days, chronic → dormant after 90 days
        // The actual contradiction_state is in the full node on disk.
        // We record the ID for escalation processing upstream.
        if (contradictionAgeDays >= 30 || contradictionAgeDays >= 90) {
          changes.contradictionEscalations.push(id);
        }
      }
    }

    return changes;
  }

  /**
   * Mark a node as stale (called on ripple propagation).
   */
  markStale(id: string, reason: string): boolean {
    const skeleton = this.skeletons.get(id);
    if (!skeleton) return false;
    if (skeleton.status === "archived" || skeleton.status === "dead")
      return false;

    skeleton.status = "stale";
    skeleton.updated_at = Date.now();
    return true;
  }

  /**
   * Touch a node (update last_touched and last_verified).
   * Called on retrieval (principle 3.4).
   */
  touch(id: string): void {
    const skeleton = this.skeletons.get(id);
    if (!skeleton) return;
    const now = Date.now();
    skeleton.last_touched = now;
    skeleton.last_verified = now;
  }

  // ─── Halflife Check ───────────────────────────────────────

  /**
   * Check which nodes have exceeded their domain-specific halflife
   * without verification. Returns stale candidate IDs.
   */
  checkHalflives(): HalflifeResult[] {
    const now = Date.now();
    const results: HalflifeResult[] = [];

    for (const [id, skeleton] of this.skeletons) {
      if (skeleton.status === "archived" || skeleton.status === "dead")
        continue;

      const halflifeDays =
        DOMAIN_HALFLIFE_DAYS[skeleton.domain] || 90;
      const unverifiedDays =
        (now - skeleton.last_verified) / (1000 * 60 * 60 * 24);

      if (unverifiedDays > halflifeDays) {
        results.push({
          nodeId: id,
          domain: skeleton.domain,
          halflifeDays,
          unverifiedDays,
          isCritical: unverifiedDays > halflifeDays * 2,
        });
      }
    }

    return results.sort(
      (a, b) => b.unverifiedDays - a.unverifiedDays
    );
  }

  // ─── Stale Aggregation ────────────────────────────────────

  /**
   * Aggregate stale nodes by domain for compact reporting.
   */
  aggregateStale(): StaleAggregate[] {
    const byDomain = new Map<Domain, { ids: string[]; oldest: number; newest: number }>();

    for (const [id, skeleton] of this.skeletons) {
      if (skeleton.status !== "stale") continue;

      let agg = byDomain.get(skeleton.domain);
      if (!agg) {
        agg = { ids: [], oldest: Infinity, newest: 0 };
        byDomain.set(skeleton.domain, agg);
      }
      agg.ids.push(id);
      agg.oldest = Math.min(agg.oldest, skeleton.updated_at);
      agg.newest = Math.max(agg.newest, skeleton.updated_at);
    }

    return [...byDomain.entries()]
      .map(([domain, agg]) => ({
        domain,
        count: agg.ids.length,
        oldestStale: agg.oldest,
        newestStale: agg.newest,
        nodeIds: agg.ids,
      }))
      .sort((a, b) => b.count - a.count);
  }

  // ─── Knowledge Gaps ───────────────────────────────────────

  /**
   * Record a zero-result search as a potential knowledge gap.
   */
  recordKnowledgeGap(
    domain: Domain,
    queryPattern: string,
    meta: KBMeta
  ): void {
    const existing = meta.knowledge_gaps.find(
      (g) => g.domain === domain && g.query_pattern === queryPattern
    );
    if (existing) {
      existing.zero_result_count++;
      existing.last_seen = Date.now();
    } else {
      meta.knowledge_gaps.push({
        domain,
        query_pattern: queryPattern,
        zero_result_count: 1,
        first_seen: Date.now(),
        last_seen: Date.now(),
      });
    }
    // Prune gaps older than 90 days with low counts
    meta.knowledge_gaps = meta.knowledge_gaps.filter(
      (g) =>
        g.zero_result_count >= 3 ||
        Date.now() - g.first_seen < 90 * 24 * 60 * 60 * 1000
    );
  }

  // ─── Helpers ──────────────────────────────────────────────

  private sample<T>(arr: T[], n: number): T[] {
    if (n >= arr.length) return [...arr];
    const result: T[] = [];
    const copy = [...arr];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * copy.length);
      result.push(copy.splice(idx, 1)[0]);
    }
    return result;
  }
}

// ─── Result Types ─────────────────────────────────────────────

export interface SyncResult {
  added: string[];
  modified: string[];
  deleted: string[];
  errors: string[];
}

export interface ConsistencyResult {
  checked: number;
  missing: string[];
  modified: string[];
  inconsistencyRate: number;
  needsFullRebuild: boolean;
}

export interface SearchResult {
  nodeId: string;
  score: number;
  skeleton: NodeSkeleton;
}

export interface LifecycleChanges {
  toStable: string[];
  toStale: string[];
  toArchived: string[];
  toDead: string[];
  /** Contradiction nodes that need state escalation (unresolved→chronic→dormant) */
  contradictionEscalations: string[];
}

export interface HalflifeResult {
  nodeId: string;
  domain: Domain;
  halflifeDays: number;
  unverifiedDays: number;
  isCritical: boolean;
}

export interface StaleAggregate {
  domain: Domain;
  count: number;
  oldestStale: number;
  newestStale: number;
  nodeIds: string[];
}
