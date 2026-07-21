/**
 * pi-kb: LinkGraph unit tests
 *
 * Tests the pure data structure with no external dependencies.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { LinkGraph } from "../link_graph";
import type { Link } from "../types";

function mkLink(
  from: string,
  to: string,
  type = "related_to" as const,
  status: "active" | "pending" | "expired" = "active"
): Link {
  return { from, to, type, status, created_at: Date.now() };
}

describe("LinkGraph", () => {
  describe("addLink / getOutgoing / getIncoming", () => {
    it("adds a single link and retrieves it from both directions", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B", "supported_by"));

      const out = g.getOutgoing("A");
      assert.equal(out.length, 1);
      assert.equal(out[0].to, "B");
      assert.equal(out[0].type, "supported_by");

      const incoming = g.getIncoming("B");
      assert.equal(incoming.length, 1);
      assert.equal(incoming[0].from, "A");
    });

    it("handles multiple outgoing links", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B"));
      g.addLink(mkLink("A", "C"));
      g.addLink(mkLink("A", "D"));

      assert.equal(g.getOutgoing("A").length, 3);
      assert.equal(g.getIncoming("B").length, 1);
      assert.equal(g.getIncoming("C").length, 1);
    });

    it("multiple incoming links to same node", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("X", "Z"));
      g.addLink(mkLink("Y", "Z"));

      assert.equal(g.getIncoming("Z").length, 2);
    });

    it("updates existing link instead of duplicating", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B", "related_to"));
      g.addLink(mkLink("A", "B", "supported_by"));

      assert.equal(g.getOutgoing("A").length, 1);
      assert.equal(g.getOutgoing("A")[0].type, "supported_by");
    });

    it("empty query returns empty arrays", () => {
      const g = new LinkGraph();
      assert.deepEqual(g.getOutgoing("nonexistent"), []);
      assert.deepEqual(g.getIncoming("nonexistent"), []);
    });
  });

  describe("getNeighbors / getBacklinkedBy", () => {
    it("filters by link type", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B", "supported_by"));
      g.addLink(mkLink("A", "C", "related_to"));
      g.addLink(mkLink("A", "D", "contradicts"));

      const supported = g.getNeighbors("A", ["supported_by"]);
      assert.deepEqual(supported, ["B"]);

      const related = g.getNeighbors("A", ["related_to", "contradicts"]);
      assert.deepEqual(related.sort(), ["C", "D"].sort());
    });

    it("getBacklinkedBy filters by type", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("X", "A", "supported_by"));
      g.addLink(mkLink("Y", "A", "related_to"));

      const backlinked = g.getBacklinkedBy("A", ["supported_by"]);
      assert.deepEqual(backlinked, ["X"]);
    });
  });

  describe("hasLink", () => {
    it("returns true for existing link", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B"));
      assert.equal(g.hasLink("A", "B"), true);
    });

    it("returns false for non-existing link", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B"));
      assert.equal(g.hasLink("A", "C"), false);
      assert.equal(g.hasLink("B", "A"), false);
    });
  });

  describe("removeLink", () => {
    it("removes from both outgoing and incoming", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B"));
      g.addLink(mkLink("A", "C"));

      g.removeLink("A", "B");

      assert.equal(g.getOutgoing("A").length, 1);
      assert.equal(g.getOutgoing("A")[0].to, "C");
      assert.equal(g.getIncoming("B").length, 0);
      assert.equal(g.getIncoming("C").length, 1);
    });

    it("returns false for non-existing link", () => {
      const g = new LinkGraph();
      assert.equal(g.removeLink("A", "B"), false);
    });
  });

  describe("removeLinksFrom", () => {
    it("removes all outgoing links and cleans incoming", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B"));
      g.addLink(mkLink("A", "C"));
      g.addLink(mkLink("X", "A")); // incoming to A, should remain

      g.removeLinksFrom("A");

      assert.equal(g.getOutgoing("A").length, 0);
      assert.equal(g.getIncoming("B").length, 0);
      assert.equal(g.getIncoming("C").length, 0);
      // The incoming link TO A should still be there (not removed)
      assert.equal(g.getIncoming("A").length, 1);
    });
  });

  describe("size", () => {
    it("counts total links", () => {
      const g = new LinkGraph();
      assert.equal(g.size, 0);
      g.addLink(mkLink("A", "B"));
      g.addLink(mkLink("A", "C"));
      assert.equal(g.size, 2);
    });
  });

  describe("BFS", () => {
    it("returns only the start node at depth 0 when no links", () => {
      const g = new LinkGraph();
      const result = g.bfs("A", 2);
      assert.equal(result.length, 1);
      assert.equal(result[0].nodeId, "A");
      assert.equal(result[0].depth, 0);
    });

    it("traverses a simple chain", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B"));
      g.addLink(mkLink("B", "C"));

      const result = g.bfs("A", 2);
      const ids = result.map((r) => r.nodeId);
      assert.deepEqual(ids, ["A", "B", "C"]);
    });

    it("respects maxDepth", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B"));
      g.addLink(mkLink("B", "C"));
      g.addLink(mkLink("C", "D"));

      const result = g.bfs("A", 1);
      const ids = result.map((r) => r.nodeId);
      assert.deepEqual(ids, ["A", "B"]);
    });

    it("handles cycles via visited set", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B"));
      g.addLink(mkLink("B", "C"));
      g.addLink(mkLink("C", "A")); // cycle

      const result = g.bfs("A", 5);
      const ids = result.map((r) => r.nodeId);
      assert.equal(ids.length, 3);
      assert.deepEqual(ids.sort(), ["A", "B", "C"].sort());
    });

    it("filters by link type", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B", "supported_by"));
      g.addLink(mkLink("A", "C", "related_to"));

      const result = g.bfs("A", 2, ["supported_by"]);
      const ids = result.map((r) => r.nodeId);
      assert.deepEqual(ids, ["A", "B"]);
    });

    it("skips pending links", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B", "related_to", "pending"));
      g.addLink(mkLink("A", "C"));

      const result = g.bfs("A", 2);
      const ids = result.map((r) => r.nodeId);
      assert.deepEqual(ids, ["A", "C"]); // B is pending, skipped
    });

    it("tracks depth and linkType correctly", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B", "supported_by"));
      g.addLink(mkLink("B", "C", "related_to"));

      const result = g.bfs("A", 2);
      assert.equal(result[0].depth, 0);
      assert.equal(result[0].linkType, "self");
      assert.equal(result[1].depth, 1);
      assert.equal(result[1].linkType, "supported_by");
      assert.equal(result[2].depth, 2);
      assert.equal(result[2].linkType, "related_to");
    });
  });

  describe("reverseBfs", () => {
    it("traverses incoming links", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("B", "A"));
      g.addLink(mkLink("C", "B"));

      const result = g.reverseBfs("A", 2);
      const ids = result.map((r) => r.nodeId);
      assert.equal(ids.length, 3);
      assert.equal(ids[0], "A");
      assert.deepEqual(ids.slice(1).sort(), ["B", "C"].sort());
    });

    it("filters by link type in reverse", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("B", "A", "supported_by"));
      g.addLink(mkLink("C", "A", "related_to"));

      const result = g.reverseBfs("A", 2, ["supported_by"]);
      const ids = result.map((r) => r.nodeId);
      assert.deepEqual(ids, ["A", "B"]);
    });
  });

  describe("getAffectedNodes (ripple propagation)", () => {
    it("finds all nodes that depend on the changed node", () => {
      // A → B (supported_by), B → C (supported_by)
      // If B changes, C is affected (reverse BFS from B following supported_by)
      const g = new LinkGraph();
      g.addLink(mkLink("B", "A", "supported_by"));
      g.addLink(mkLink("C", "B", "supported_by"));

      const affected = g.getAffectedNodes("A");
      const ids = affected.map((a) => a.nodeId);
      assert.deepEqual(ids, ["B", "C"]);
    });

    it("impact decays with distance", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("B", "A", "supported_by"));
      g.addLink(mkLink("C", "B", "supported_by"));
      g.addLink(mkLink("D", "C", "supported_by"));

      const affected = g.getAffectedNodes("A");
      assert.equal(affected.length, 3);
      // Distance 1: impact 1.0, Distance 2: 0.5, Distance 3: 0.25
      assert.equal(affected[0].impact, 1.0);  // B, distance 1
      assert.equal(affected[1].impact, 0.5);  // C, distance 2
      assert.equal(affected[2].impact, 0.25); // D, distance 3
    });

    it("only follows strong-propagation link types", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("B", "A", "supported_by"));   // strong
      g.addLink(mkLink("C", "A", "related_to"));      // weak → not followed

      const affected = g.getAffectedNodes("A");
      const ids = affected.map((a) => a.nodeId);
      assert.deepEqual(ids, ["B"]); // only B, not C
    });
  });

  describe("resolvePendingLinks", () => {
    it("activates pending links when target is created", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "Z", "related_to", "pending"));

      const resolved = g.resolvePendingLinks("Z");
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].status, "active");

      const outgoing = g.getOutgoing("A");
      assert.equal(outgoing[0].status, "active");
    });
  });

  describe("expirePendingLinks", () => {
    it("expires pending links older than timeout", () => {
      const g = new LinkGraph();
      // Create a pending link with an old timestamp
      const oldLink: Link = {
        from: "A",
        to: "Z",
        type: "related_to",
        status: "pending",
        created_at: Date.now() - 100 * 60 * 60 * 1000, // 100 hours ago
      };
      g.addLink(oldLink);

      const expired = g.expirePendingLinks(48 * 60 * 60 * 1000); // 48h timeout
      assert.equal(expired.length, 1);
      assert.equal(expired[0].status, "expired");
    });

    it("does not expire recent pending links", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "Z", "related_to", "pending"));

      const expired = g.expirePendingLinks(48 * 60 * 60 * 1000);
      assert.equal(expired.length, 0);
      assert.equal(g.getOutgoing("A")[0].status, "pending");
    });
  });

  describe("findDegenerateNodes", () => {
    it("finds nodes with exactly one in and one out link", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("X", "A")); // A: 1 in
      g.addLink(mkLink("A", "Y")); // A: 1 out → degenerate
      g.addLink(mkLink("P", "B")); // B: 1 in
      g.addLink(mkLink("B", "Q")); // B: 1 out
      g.addLink(mkLink("B", "R")); // B: 2 out → not degenerate

      const degenerate = g.findDegenerateNodes();
      assert.deepEqual(degenerate, ["A"]);
    });
  });

  describe("toJSON / fromJSON", () => {
    it("roundtrips correctly", () => {
      const g = new LinkGraph();
      g.addLink(mkLink("A", "B", "supported_by"));
      g.addLink(mkLink("B", "C", "related_to"));

      const json = g.toJSON();
      const restored = LinkGraph.fromJSON(json);

      assert.equal(restored.size, g.size);
      assert.equal(restored.getOutgoing("A").length, 1);
      assert.equal(restored.getIncoming("C").length, 1);
    });
  });
});
