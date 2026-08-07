/**
 * pi-kb: Standalone KB system factory
 *
 * Creates and wires up Storage + NodeIndex + LinkGraph independently of pi.
 * Useful for testing, scripting, batch imports, and other Agent frameworks.
 */

import { KBStorage } from "./storage";
import { NodeIndex } from "./node_index";
import { LinkGraph } from "./link_graph";
import type { KBNode, NodeSkeleton, KBMeta } from "./types";

export interface KBSystem {
  storage: KBStorage;
  nodeIndex: NodeIndex;
  linkGraph: LinkGraph;

  /** Initialize: ensure directories, rebuild index, advance lifecycles */
  initialize(): Promise<KBSystemInitResult>;

  /** Reload index from disk (on session start or after external modifications) */
  reload(): Promise<KBSystemInitResult>;

  /** Shutdown: persist any pending state */
  shutdown(): Promise<void>;
}

export interface KBSystemInitResult {
  nodesLoaded: number;
  parseErrors: string[];
  newNodesDiscovered: number;
  nodesModifiedExternally: number;
  nodesRemovedExternally: number;
  pendingLinksExpired: number;
  lifecycleChanges: string[];
  contradictionEscalations: number;
  staleNodeCount: number;
  criticalStaleNodes: number;
}

/**
 * Create a KBSystem for a given root directory.
 * All operations are file-system based and can run without pi.
 */
export async function createKBSystem(rootDir: string): Promise<KBSystem> {
  const storage = new KBStorage(rootDir);
  await storage.ensure();

  let nodeIndex = new NodeIndex(storage);

  const system: KBSystem = {
    storage,
    get nodeIndex() { return nodeIndex; },
    get linkGraph() { return nodeIndex.graph; },

    async initialize() {
      return initializeInternal({ storage, nodeIndex });
    },

    async reload() {
      const newIndex = new NodeIndex(storage);
      const result = await initializeInternal({ storage, nodeIndex: newIndex });
      nodeIndex = newIndex;
      return result;
    },

    async shutdown() {
      // Currently no persistent state to flush beyond what's already on disk
    },
  };

  return system;
}

async function initializeInternal(sys: {
  storage: KBStorage;
  nodeIndex: NodeIndex;
}): Promise<KBSystemInitResult> {
  const { storage, nodeIndex } = sys;

  const { loaded, errors } = await nodeIndex.rebuild();
  const sync = await nodeIndex.sync();
  const expiredLinks = nodeIndex.graph.expirePendingLinks();

  // Lifecycle
  const lc = nodeIndex.advanceLifecycles();
  let contradictionEscalations = 0;
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
    if (node.contradiction_state !== (contra as import("./types").ContradictionNode).contradiction_state) {
      node.changelog.push({
        timestamp: Date.now(), actor: "system",
        action: "contradiction_escalated",
        detail: `${node.contradiction_state} after ${Math.round(ageDays)} days`,
      });
      await storage.writeNode(node);
      contradictionEscalations++;
    }
  }

  const lcParts: string[] = [];
  if (lc.toStable.length) lcParts.push(`${lc.toStable.length}→stable`);
  if (lc.toStale.length) lcParts.push(`${lc.toStale.length}→stale`);
  if (lc.toArchived.length) lcParts.push(`${lc.toArchived.length}→archived`);
  if (lc.toDead.length) lcParts.push(`${lc.toDead.length}→dead`);

  const hlWarnings = nodeIndex.checkHalflives();
  const criticalStale = hlWarnings.filter((h) => h.isCritical).length;
  const staleAgg = nodeIndex.aggregateStale();
  const staleNodeCount = staleAgg.reduce((sum, a) => sum + a.count, 0);

  // Recalculate unreflected count from actual node/link state (fix stale counter)
  let actualUnreflected = 0;
  for (const skel of nodeIndex.getAllSkeletons()) {
    if (skel.type !== "observation") continue;
    if (skel.status === "dead" || skel.status === "archived") continue;
    const hasReflection = nodeIndex.graph
      .getIncoming(skel.id)
      .some((l) => l.type === "supported_by" && l.status === "active");
    if (!hasReflection) actualUnreflected++;
  }
  const meta = await storage.readMeta();
  if (meta.reflection_triggers.unreflected_observations !== actualUnreflected) {
    meta.reflection_triggers.unreflected_observations = actualUnreflected;
    await storage.writeMeta(meta);
  }

  return {
    nodesLoaded: loaded,
    parseErrors: errors,
    newNodesDiscovered: sync.added.length,
    nodesModifiedExternally: sync.modified.length,
    nodesRemovedExternally: sync.deleted.length,
    pendingLinksExpired: expiredLinks.length,
    lifecycleChanges: lcParts,
    contradictionEscalations,
    staleNodeCount,
    criticalStaleNodes: criticalStale,
  };
}
