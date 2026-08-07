/**
 * pi-kb: Knowledge Base type system
 *
 * All nodes and links share a UUID-based identity model.
 * Physical filenames are UUIDs. Human-readable titles live in frontmatter.
 */

// ─── Node Identity ────────────────────────────────────────────

export type NodeType =
  | "observation"
  | "reflection"
  | "insight"
  | "contradiction"
  | "moc";

export type NodeStatus =
  | "birth"      // just created, not yet indexed
  | "active"     // participating in routine retrieval
  | "stable"     // unchanged for 30 days
  | "stale"      // unverified beyond halflife
  | "archived"   // excluded from routine retrieval
  | "dead";      // explicitly deprecated, audit-only

export type Creator = "agent" | "human";

export type LinkType =
  | "supported_by"    // insight → evidence (strong propagation)
  | "related_to"       // weak association
  | "parent_of"        // MOC → child
  | "child_of"         // child → MOC (reverse of parent_of)
  | "contradicts"      // contradiction → conflicting node
  | "precedes"         // temporal ordering
  | "follows"          // temporal ordering (reverse)
  | "evolved_from"     // new replaces old
  | "deprecated_by"    // old replaced by new
  | "alternative_view"; // same topic, different perspective

export type LinkStatus = "active" | "pending" | "expired";

export type Significance = "high" | "medium" | "low";

export type Domain =
  | "user-preference"
  | "user-behavior"
  | "user-identity"
  | "project-status"
  | "project-decision"
  | "agent-self-knowledge"
  | "external-fact";

export type RetrieveScope = "routine" | "deep" | "forensic";

export type ContradictionState =
  | "unresolved"  // < 30 days
  | "chronic"     // 30-90 days
  | "dormant"     // > 90 days
  | "resolved";

// ─── Node Structures ──────────────────────────────────────────

export interface NodeBase {
  id: string;               // UUID, also the physical filename
  type: NodeType;
  title: string;            // human-readable display name
  status: NodeStatus;
  created_by: Creator;
  created_at: number;       // unix ms
  updated_at: number;       // unix ms
  last_verified: number;    // unix ms; updated on retrieval
  last_touched: number;     // unix ms; updated on any access
  domain: Domain;
  /** Tags for keyword-based filtering */
  tags: string[];
  /** Changelog entries (appended by system) */
  changelog: ChangelogEntry[];
}

export interface ChangelogEntry {
  timestamp: number;
  actor: Creator | "system";
  action: string;           // e.g. "created", "confidence_changed", "exernal_edit"
  detail: string;
}

export interface ObservationNode extends NodeBase {
  type: "observation";
  /** Link to the auto-log session file */
  source_log: string;
  /** The actual content of the observation */
  content: string;
  significance: Significance;
}

export interface ReflectionNode extends NodeBase {
  type: "reflection";
  /** Period label, e.g. "2026-07-19" */
  period: string;
  /** Primary source observation IDs this reflection digests */
  sources: string[];
  /** Secondary (already-reflected) observation IDs */
  secondary_sources: string[];
  /** Previous reflection ID in chain */
  previous_reflection?: string;
  /** Quality score derived from source density */
  quality?: "high" | "medium" | "low";
}

export interface InsightNode extends NodeBase {
  type: "insight";
  /** The single atomic claim (principle 4.1) */
  statement: string;
  /** Confidence 0.0 - 1.0 */
  confidence: number;
  /** IDs of nodes that support this insight (reflections or observations) */
  sources: string[];
  /** If this insight was created by resolving a contradiction */
  resolved_from_contradiction?: string;
}

export interface ContradictionNode extends NodeBase {
  type: "contradiction";
  /** The conflicting node IDs */
  conflicting_nodes: [string, string];
  /** LLM-assessed severity */
  severity: "surface" | "substantial";
  /** Current resolution state */
  contradiction_state: ContradictionState;
  /** Resolution explanation (set when resolved) */
  resolution?: string;
  /** The new insight created by resolving this contradiction */
  resolved_insight_id?: string;
}

export interface MocNode extends NodeBase {
  type: "moc";
  /** Description of what this MOC organizes */
  description?: string;
  /** Ordered list of child node IDs */
  child_nodes: string[];
}

export type KBNode =
  | ObservationNode
  | ReflectionNode
  | InsightNode
  | ContradictionNode
  | MocNode;

// ─── Link Structure ───────────────────────────────────────────

export interface Link {
  /** Source node ID (the node that contains the link) */
  from: string;
  /** Target node ID */
  to: string;
  /** Semantic type of the link */
  type: LinkType;
  status: LinkStatus;
  created_at: number;
  /** Context explaining why this link exists (for reverse-link display) */
  context?: string;
}

// ─── KB Metadata ──────────────────────────────────────────────

export interface KBMeta {
  version: number;
  created_at: number;
  updated_at: number;
  total_nodes: number;
  reflection_triggers: {
    unreflected_observations: number;
    threshold: number;
    last_reflection_at: number | null;
    domains_with_pending: Domain[];
  };
  /** Knowledge gaps tracked by system (from repeated zero-result queries) */
  knowledge_gaps: KnowledgeGap[];
}

export interface KnowledgeGap {
  domain: Domain;
  query_pattern: string;
  zero_result_count: number;
  first_seen: number;
  last_seen: number;
}

// ─── Node Index Skeleton ──────────────────────────────────────

/**
 * Minimal representation of a node kept in the in-memory index.
 * Full content is loaded from MD files on demand.
 */
export interface NodeSkeleton {
  id: string;
  type: NodeType;
  title: string;
  status: NodeStatus;
  created_by: Creator;
  domain: Domain;
  created_at: number;
  updated_at: number;
  last_verified: number;
  last_touched: number;
  tags: string[];
  /** First line of content for quick display */
  snippet: string;
  /** Source node IDs (for reflections/insights) */
  sources?: string[];
  /** Child node IDs (for MOCs) */
  child_nodes?: string[];
}

// ─── Domain Half-life Configuration ───────────────────────────

export const DOMAIN_HALFLIFE_DAYS: Record<Domain, number> = {
  "user-preference": 90,
  "user-behavior": 60,
  "user-identity": 365,
  "project-status": 14,
  "project-decision": 180,
  "agent-self-knowledge": 30,
  "external-fact": 90,
};

// ─── Lifecycle Transition Rules ────────────────────────────────

export const LIFECYCLE_RULES = {
  /** Days without update to move active → stable */
  active_to_stable_days: 30,
  /** Days without verification to move stable → stale */
  stable_to_stale_days: 90,
  /** Days stale without review to move stale → archived */
  stale_to_archived_days: 30,
  /** Days archived to move archived → dead */
  archived_to_dead_days: 365,
} as const;

// ─── Retrieval Configuration ──────────────────────────────────

export const RETRIEVAL_DEFAULTS = {
  /** Max BFS depth for link traversal */
  max_depth: 3,
  /** Max token budget for kb_retrieve results */
  token_budget: 4096,
  /** Approximate tokens per character (for budget estimation) */
  tokens_per_char: 0.25,
} as const;

/** Default reflection threshold — overridable via PIKB_REFLECTION_THRESHOLD env var */
export const REFLECTION_THRESHOLD =
  parseInt(process.env.PIKB_REFLECTION_THRESHOLD || "10", 10);

/** Status weights for retrieval ranking */
export const STATUS_RANK_WEIGHT: Record<NodeStatus, number> = {
  birth: 1.0,
  active: 1.0,
  stable: 0.8,
  stale: 0.4,
  archived: 0.0,
  dead: 0.0,
};
