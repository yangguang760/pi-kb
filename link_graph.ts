/**
 * pi-kb: In-memory link graph
 *
 * Manages a directed graph of links between KB nodes.
 * Provides BFS traversal, reverse-link queries, and ripple propagation.
 *
 * Design decision (principle 13.6, scenario 24):
 *   The link graph in memory is the authoritative source of truth.
 *   [[...]] references in MD body text are human-readable presentation only.
 */

import type { Link, LinkType, LinkStatus } from "./types";
import { RETRIEVAL_DEFAULTS } from "./types";

// ─── Core Graph ───────────────────────────────────────────────

export class LinkGraph {
  /** Adjacency list: fromId → Link[] */
  private outgoing: Map<string, Link[]> = new Map();
  /** Reverse index: toId → Link[] (system-maintained, not user-created) */
  private incoming: Map<string, Link[]> = new Map();

  // ─── Mutation ────────────────────────────────────────────

  /**
   * Add a link. Automatically maintains the reverse index.
   * If a link with the same from+to already exists, it is updated.
   */
  addLink(link: Link): void {
    const key = `${link.from}→${link.to}`;

    // Update outgoing
    const outList = this.outgoing.get(link.from) || [];
    const existingIdx = outList.findIndex(
      (l) => l.from === link.from && l.to === link.to
    );
    if (existingIdx >= 0) {
      outList[existingIdx] = { ...link };
    } else {
      outList.push({ ...link });
    }
    this.outgoing.set(link.from, outList);

    // Update incoming (reverse index)
    const inList = this.incoming.get(link.to) || [];
    const inIdx = inList.findIndex(
      (l) => l.from === link.from && l.to === link.to
    );
    if (inIdx >= 0) {
      inList[inIdx] = { ...link };
    } else {
      inList.push({ ...link });
    }
    this.incoming.set(link.to, inList);
  }

  /**
   * Remove all links FROM a given node.
   * Used when a node is deleted.
   */
  removeLinksFrom(nodeId: string): void {
    const outLinks = this.outgoing.get(nodeId) || [];
    for (const link of outLinks) {
      const inList = this.incoming.get(link.to) || [];
      this.incoming.set(
        link.to,
        inList.filter((l) => l.from !== nodeId)
      );
    }
    this.outgoing.delete(nodeId);
  }

  /**
   * Remove a specific link.
   */
  removeLink(fromId: string, toId: string): boolean {
    const outList = this.outgoing.get(fromId);
    if (!outList) return false;

    const before = outList.length;
    this.outgoing.set(
      fromId,
      outList.filter((l) => l.to !== toId)
    );
    if (this.outgoing.get(fromId)!.length === before) return false;

    // Also remove from incoming
    const inList = this.incoming.get(toId);
    if (inList) {
      this.incoming.set(
        toId,
        inList.filter((l) => l.from !== fromId)
      );
    }
    return true;
  }

  /** Resolve pending links when target node is created */
  resolvePendingLinks(targetId: string): Link[] {
    const resolved: Link[] = [];
    const inList = this.incoming.get(targetId) || [];
    for (const link of inList) {
      if (link.status === "pending") {
        link.status = "active";
        this.addLink(link); // update both directions
        resolved.push(link);
      }
    }
    return resolved;
  }

  /** Expire pending links older than timeout (48h default) */
  expirePendingLinks(timeoutMs: number = 48 * 60 * 60 * 1000): Link[] {
    const now = Date.now();
    const expired: Link[] = [];
    for (const [, links] of this.outgoing) {
      for (const link of links) {
        if (
          link.status === "pending" &&
          now - link.created_at > timeoutMs
        ) {
          link.status = "expired";
          this.addLink(link);
          expired.push(link);
        }
      }
    }
    return expired;
  }

  // ─── Query ────────────────────────────────────────────────

  /** Get all outgoing links from a node */
  getOutgoing(nodeId: string): Link[] {
    return [...(this.outgoing.get(nodeId) || [])];
  }

  /** Get all incoming links to a node */
  getIncoming(nodeId: string): Link[] {
    return [...(this.incoming.get(nodeId) || [])];
  }

  /**
   * Get all nodes directly linked (outgoing) with an optional type filter.
   * Returns target node IDs.
   */
  getNeighbors(
    nodeId: string,
    linkTypes?: LinkType[]
  ): string[] {
    const links = this.outgoing.get(nodeId) || [];
    if (!linkTypes) return links.map((l) => l.to);
    return links
      .filter((l) => linkTypes.includes(l.type as LinkType))
      .map((l) => l.to);
  }

  /**
   * Get all nodes that link TO this node (incoming), with optional type filter.
   * Returns source node IDs.
   */
  getBacklinkedBy(
    nodeId: string,
    linkTypes?: LinkType[]
  ): string[] {
    const links = this.incoming.get(nodeId) || [];
    if (!linkTypes) return links.map((l) => l.from);
    return links
      .filter((l) => linkTypes.includes(l.type as LinkType))
      .map((l) => l.from);
  }

  /** Does a specific link exist? */
  hasLink(fromId: string, toId: string): boolean {
    const links = this.outgoing.get(fromId) || [];
    return links.some((l) => l.to === toId);
  }

  /** Get total number of links */
  get size(): number {
    let count = 0;
    for (const links of this.outgoing.values()) {
      count += links.length;
    }
    return count;
  }

  // ─── BFS Traversal ────────────────────────────────────────

  /**
   * BFS traversal from a starting node.
   *
   * @param startId - Starting node ID
   * @param maxDepth - Maximum traversal depth (default from RETRIEVAL_DEFAULTS)
   * @param linkTypes - Optional filter for link types to follow
   * @returns Array of {nodeId, depth, linkType} in BFS order
   */
  bfs(
    startId: string,
    maxDepth: number = RETRIEVAL_DEFAULTS.max_depth,
    linkTypes?: LinkType[]
  ): BFSStep[] {
    const visited = new Set<string>();
    const queue: { nodeId: string; depth: number; linkType: string }[] = [];
    const result: BFSStep[] = [];

    visited.add(startId);
    queue.push({ nodeId: startId, depth: 0, linkType: "self" });

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push({
        nodeId: current.nodeId,
        depth: current.depth,
        linkType: current.linkType,
      });

      if (current.depth >= maxDepth) continue;

      const links = this.outgoing.get(current.nodeId) || [];
      for (const link of links) {
        if (link.status !== "active") continue;
        if (linkTypes && !linkTypes.includes(link.type as LinkType)) continue;
        if (visited.has(link.to)) continue;

        visited.add(link.to);
        queue.push({
          nodeId: link.to,
          depth: current.depth + 1,
          linkType: link.type,
        });
      }
    }

    return result;
  }

  /**
   * BFS in reverse direction (follow incoming links).
   * Used for ripple propagation: "who depends on this node?"
   */
  reverseBfs(
    startId: string,
    maxDepth: number = RETRIEVAL_DEFAULTS.max_depth,
    linkTypes?: LinkType[]
  ): BFSStep[] {
    const visited = new Set<string>();
    const queue: { nodeId: string; depth: number; linkType: string }[] = [];
    const result: BFSStep[] = [];

    visited.add(startId);
    queue.push({ nodeId: startId, depth: 0, linkType: "self" });

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push({
        nodeId: current.nodeId,
        depth: current.depth,
        linkType: current.linkType,
      });

      if (current.depth >= maxDepth) continue;

      const links = this.incoming.get(current.nodeId) || [];
      for (const link of links) {
        if (link.status !== "active") continue;
        if (linkTypes && !linkTypes.includes(link.type as LinkType)) continue;
        if (visited.has(link.from)) continue;

        visited.add(link.from);
        queue.push({
          nodeId: link.from,
          depth: current.depth + 1,
          linkType: link.type,
        });
      }
    }

    return result;
  }

  // ─── Ripple Propagation ───────────────────────────────────

  /**
   * Find all nodes affected by a change to the given node.
   * Uses reverse BFS following strong-propagation link types.
   *
   * Strong propagation: supported_by, parent_of, evolved_from, deprecated_by
   * Weak propagation: related_to, alternative_view (not followed here)
   *
   * Returns affected node IDs with distance and impact decay.
   */
  getAffectedNodes(changedId: string): AffectedNode[] {
    const STRONG_LINK_TYPES: LinkType[] = [
      "supported_by",
      "parent_of",
      "evolved_from",
      "deprecated_by",
      "contradicts",
    ];

    const steps = this.reverseBfs(
      changedId,
      RETRIEVAL_DEFAULTS.max_depth,
      STRONG_LINK_TYPES
    );

    return steps
      .filter((s) => s.nodeId !== changedId)
      .map((s) => ({
        nodeId: s.nodeId,
        distance: s.depth,
        // Impact decays with distance (principle 2.3)
        impact: Math.pow(0.5, s.depth - 1),
      }));
  }

  // ─── Statistics ───────────────────────────────────────────

  /** Find nodes with exactly one incoming and one outgoing link */
  findDegenerateNodes(): string[] {
    const candidates: string[] = [];
    for (const [nodeId] of this.outgoing) {
      const outDegree = (this.outgoing.get(nodeId) || []).length;
      const inDegree = (this.incoming.get(nodeId) || []).length;
      if (outDegree === 1 && inDegree === 1) {
        candidates.push(nodeId);
      }
    }
    return candidates;
  }

  /** Serialize for persistence */
  toJSON(): Link[] {
    const allLinks: Link[] = [];
    for (const links of this.outgoing.values()) {
      allLinks.push(...links);
    }
    return allLinks;
  }

  /** Restore from serialized links */
  static fromJSON(links: Link[]): LinkGraph {
    const graph = new LinkGraph();
    for (const link of links) {
      graph.addLink(link);
    }
    return graph;
  }
}

// ─── Types ────────────────────────────────────────────────────

export interface BFSStep {
  nodeId: string;
  depth: number;
  linkType: string;
}

export interface AffectedNode {
  nodeId: string;
  distance: number;
  /** Impact factor [0, 1], decays with distance */
  impact: number;
}
