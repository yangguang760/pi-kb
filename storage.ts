/**
 * pi-kb: File system storage layer
 *
 * Responsibilities:
 * - KB directory structure management
 * - Node MD file read/write with frontmatter
 * - .kb_meta.json persistence
 * - Atomic writes (tmp file + rename)
 * - Auto-log session recording
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  KBMeta,
  KBNode,
  NodeSkeleton,
  ChangelogEntry,
  Link,
  LinkType,
} from "./types";
import { REFLECTION_THRESHOLD } from "./types";

// ─── Path Management ──────────────────────────────────────────

export class KBStorage {
  readonly rootDir: string;
  readonly nodesDir: string;
  readonly tmpDir: string;
  readonly metaPath: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.nodesDir = path.join(rootDir, "nodes");
    this.tmpDir = path.join(rootDir, ".tmp");
    this.metaPath = path.join(rootDir, ".kb_meta.json");
  }

  /** Ensure all directory structure exists */
  async ensure(): Promise<void> {
    await fsp.mkdir(this.nodesDir, { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });
    if (!fs.existsSync(this.metaPath)) {
      await this.writeMeta(this.defaultMeta());
    }
  }

  // ─── Metadata ────────────────────────────────────────────

  defaultMeta(): KBMeta {
    return {
      version: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
      total_nodes: 0,
      reflection_triggers: {
        unreflected_observations: 0,
        threshold: REFLECTION_THRESHOLD,
        last_reflection_at: null,
        domains_with_pending: [],
      },
      knowledge_gaps: [],
    };
  }

  async readMeta(): Promise<KBMeta> {
    const raw = await fsp.readFile(this.metaPath, "utf-8");
    return JSON.parse(raw) as KBMeta;
  }

  async writeMeta(meta: KBMeta): Promise<void> {
    meta.updated_at = Date.now();
    await fsp.writeFile(this.metaPath, JSON.stringify(meta, null, 2), "utf-8");
  }

  // ─── Node I/O ────────────────────────────────────────────

  /** Generate a new UUID-based filename */
  generateId(): string {
    return randomUUID();
  }

  /** Node file path from ID */
  nodePath(id: string): string {
    return path.join(this.nodesDir, `${id}.md`);
  }

  /** Serialize a node to Markdown with YAML frontmatter */
  serializeNode(node: KBNode): string {
    const fm = this.buildFrontmatter(node);
    const body = this.buildBody(node);
    return `---\n${fm}\n---\n\n${body}`;
  }

  /** Write a node to disk with atomic rename */
  async writeNode(node: KBNode): Promise<void> {
    const content = this.serializeNode(node);
    const tmpPath = path.join(this.tmpDir, `${node.id}.md.tmp`);
    const targetPath = this.nodePath(node.id);

    await fsp.writeFile(tmpPath, content, "utf-8");
    await fsp.rename(tmpPath, targetPath);
  }

  /** Read and parse a node from disk */
  async readNode(id: string): Promise<KBNode | null> {
    const p = this.nodePath(id);
    if (!fs.existsSync(p)) return null;
    const content = await fsp.readFile(p, "utf-8");
    return this.parseNode(id, content);
  }

  /** Quick read of frontmatter only (for skeleton population) */
  async readNodeSkeleton(id: string): Promise<NodeSkeleton | null> {
    const p = this.nodePath(id);
    if (!fs.existsSync(p)) return null;
    const content = await fsp.readFile(p, "utf-8");
    return this.parseSkeleton(id, content);
  }

  /** Delete a node file */
  async deleteNode(id: string): Promise<void> {
    const p = this.nodePath(id);
    if (fs.existsSync(p)) {
      await fsp.unlink(p);
    }
  }

  /** List all node IDs on disk */
  async listNodeIds(): Promise<string[]> {
    const entries = await fsp.readdir(this.nodesDir);
    return entries
      .filter((e) => e.endsWith(".md"))
      .map((e) => e.replace(".md", ""));
  }

  /** Get mtime of a node file (for external-modification detection) */
  async nodeMtime(id: string): Promise<number | null> {
    const p = this.nodePath(id);
    if (!fs.existsSync(p)) return null;
    const stat = await fsp.stat(p);
    return stat.mtimeMs;
  }

  // ─── Auto-log ────────────────────────────────────────────

  /** Append an entry to the session auto-log */
  async appendAutoLog(
    sessionId: string,
    entry: { role: string; content: string; timestamp: number }
  ): Promise<void> {
    const logPath = path.join(this.rootDir, "logs");
    await fsp.mkdir(logPath, { recursive: true });
    const filePath = path.join(logPath, `${sessionId}.md`);

    const line = `\n---\n## ${entry.role} - ${new Date(entry.timestamp).toISOString()}\n\n${entry.content}\n`;
    await fsp.appendFile(filePath, line, "utf-8");
  }

  // ─── Frontmatter Helpers ─────────────────────────────────

  private buildFrontmatter(node: KBNode): string {
    const base: Record<string, unknown> = {
      id: node.id,
      type: node.type,
      title: node.title,
      status: node.status,
      created_by: node.created_by,
      created_at: node.created_at,
      updated_at: node.updated_at,
      last_verified: node.last_verified,
      last_touched: node.last_touched,
      domain: node.domain,
      tags: node.tags,
      changelog: node.changelog,
    };

    // Type-specific fields
    switch (node.type) {
      case "observation":
        Object.assign(base, {
          source_log: node.source_log,
          significance: node.significance,
        });
        break;
      case "reflection":
        Object.assign(base, {
          period: node.period,
          sources: node.sources,
          secondary_sources: node.secondary_sources,
          previous_reflection: node.previous_reflection,
          quality: node.quality,
        });
        break;
      case "insight":
        Object.assign(base, {
          statement: node.statement,
          confidence: node.confidence,
          sources: node.sources,
          resolved_from_contradiction: node.resolved_from_contradiction,
        });
        break;
      case "contradiction":
        Object.assign(base, {
          conflicting_nodes: node.conflicting_nodes,
          severity: node.severity,
          contradiction_state: node.contradiction_state,
          resolution: node.resolution,
          resolved_insight_id: node.resolved_insight_id,
        });
        break;
      case "moc":
        Object.assign(base, {
          description: node.description,
          child_nodes: node.child_nodes,
        });
        break;
    }

    return this.yamlify(base, 0);
  }

  private buildBody(node: KBNode): string {
    switch (node.type) {
      case "observation":
        return node.content;
      case "reflection": {
        const parts: string[] = [
          `# Reflection ${node.period}`,
          "",
          node.content || "",
        ];
        if (node.sources.length > 0) {
          parts.push("", "## Sources", ...node.sources.map((s) => `- [[${s}]]`));
        }
        return parts.join("\n");
      }
      case "insight": {
        const parts: string[] = [
          `# ${node.title}`,
          "",
          node.statement,
          "",
          `**Confidence:** ${node.confidence}`,
        ];
        if (node.sources.length > 0) {
          parts.push(
            "",
            "## Evidence",
            ...node.sources.map((s) => `- [[${s}]]`)
          );
        }
        return parts.join("\n");
      }
      case "contradiction": {
        const parts: string[] = [
          `# ${node.title}`,
          "",
          `**State:** ${node.contradiction_state}`,
          `**Severity:** ${node.severity}`,
          "",
          "## Conflicting Nodes",
          ...node.conflicting_nodes.map((id) => `- [[${id}]]`),
        ];
        if (node.resolution) {
          parts.push("", "## Resolution", node.resolution);
        }
        return parts.join("\n");
      }
      case "moc": {
        const parts: string[] = [
          `# ${node.title}`,
          "",
          node.description || "",
        ];
        if (node.child_nodes.length > 0) {
          parts.push(
            "",
            "## Contents",
            ...node.child_nodes.map((id) => `- [[${id}]]`)
          );
        }
        return parts.join("\n");
      }
    }
  }

  // ─── Parsing ──────────────────────────────────────────────

  private parseNode(id: string, raw: string): KBNode | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    if (!match) return null;

    const fm = this.parseYaml(match[1]);
    const body = match[2];
    const type = fm.type as string;

    const base = {
      id,
      type: type as KBNode["type"],
      title: (fm.title as string) || "",
      status: (fm.status as KBNode["status"]) || "active",
      created_by: (fm.created_by as KBNode["created_by"]) || "agent",
      created_at: (fm.created_at as number) || 0,
      updated_at: (fm.updated_at as number) || 0,
      last_verified: (fm.last_verified as number) || 0,
      last_touched: (fm.last_touched as number) || 0,
      domain: (fm.domain as KBNode["domain"]) || "external-fact",
      tags: (fm.tags as string[]) || [],
      changelog: (fm.changelog as ChangelogEntry[]) || [],
    };

    switch (type) {
      case "observation":
        return {
          ...base,
          type: "observation",
          source_log: (fm.source_log as string) || "",
          content: body,
          significance: (fm.significance as Significance) || "medium",
        } as ObservationNode;

      case "reflection":
        return {
          ...base,
          type: "reflection",
          period: (fm.period as string) || "",
          content: body,
          sources: (fm.sources as string[]) || [],
          secondary_sources: (fm.secondary_sources as string[]) || [],
          previous_reflection: fm.previous_reflection as string | undefined,
          quality: fm.quality as "high" | "medium" | "low" | undefined,
        } as ReflectionNode;

      case "insight":
        return {
          ...base,
          type: "insight",
          statement: (fm.statement as string) || "",
          confidence: (fm.confidence as number) || 0.5,
          sources: (fm.sources as string[]) || [],
          resolved_from_contradiction:
            fm.resolved_from_contradiction as string | undefined,
        } as InsightNode;

      case "contradiction":
        return {
          ...base,
          type: "contradiction",
          conflicting_nodes: (fm.conflicting_nodes as [string, string]) || [
            "",
            "",
          ],
          severity: (fm.severity as "surface" | "substantial") || "surface",
          contradiction_state:
            (fm.contradiction_state as ContradictionState) || "unresolved",
          resolution: fm.resolution as string | undefined,
          resolved_insight_id: fm.resolved_insight_id as string | undefined,
        } as ContradictionNode;

      case "moc":
        return {
          ...base,
          type: "moc",
          description: fm.description as string | undefined,
          child_nodes: (fm.child_nodes as string[]) || [],
        } as MocNode;
    }

    return null;
  }

  private parseSkeleton(id: string, raw: string): NodeSkeleton | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return null;
    const fm = this.parseYaml(match[1]);
    const bodyStart = raw.indexOf("\n---\n\n");
    const snippet =
      bodyStart >= 0
        ? raw.slice(bodyStart + 6, bodyStart + 206).replace(/\n/g, " ")
        : "";

    return {
      id,
      type: (fm.type as NodeType) || "observation",
      title: (fm.title as string) || "",
      status: (fm.status as NodeStatus) || "active",
      created_by: (fm.created_by as Creator) || "agent",
      domain: (fm.domain as Domain) || "external-fact",
      created_at: (fm.created_at as number) || 0,
      updated_at: (fm.updated_at as number) || 0,
      last_verified: (fm.last_verified as number) || 0,
      last_touched: (fm.last_touched as number) || 0,
      tags: (fm.tags as string[]) || [],
      snippet,
      sources: (fm.sources as string[]) || undefined,
      child_nodes: (fm.child_nodes as string[]) || undefined,
    };
  }

  // ─── Minimal YAML Parser ──────────────────────────────────

  private yamlify(obj: Record<string, unknown>, indent: number): string {
    const pad = "  ".repeat(indent);
    const lines: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || value === null) continue;

      if (Array.isArray(value)) {
        if (value.length === 0) {
          lines.push(`${pad}${key}: []`);
        } else if (
          value.every((v) => typeof v === "string" || typeof v === "number")
        ) {
          lines.push(`${pad}${key}:`);
          for (const item of value) {
            lines.push(`${pad}  - ${JSON.stringify(item)}`);
          }
        } else {
          lines.push(`${pad}${key}:`);
          for (const item of value) {
            lines.push(`${pad}  - ${this.yamlify(item as Record<string, unknown>, indent + 2).trimStart()}`);
          }
        }
      } else if (typeof value === "object") {
        lines.push(`${pad}${key}:`);
        lines.push(
          this.yamlify(value as Record<string, unknown>, indent + 1)
        );
      } else if (typeof value === "string") {
        // Strings that contain special YAML chars need quoting
        if (
          value.includes(":") ||
          value.includes("#") ||
          value.includes("{") ||
          value.includes("[") ||
          value.includes("'") ||
          value.includes('"') ||
          value.startsWith(" ") ||
          value.endsWith(" ") ||
          value === ""
        ) {
          lines.push(`${pad}${key}: "${value.replace(/"/g, '\\"')}"`);
        } else {
          lines.push(`${pad}${key}: ${value}`);
        }
      } else {
        lines.push(`${pad}${key}: ${value}`);
      }
    }

    return lines.join("\n");
  }

  private parseYaml(raw: string): Record<string, unknown> {
    const lines = raw.split("\n");
    return this.parseYamlBlock(lines, 0, 0).result as Record<string, unknown>;
  }

  /**
   * Recursive YAML block parser.
   * Handles: scalars, flat objects, arrays of primitives, arrays of objects (1 level nesting).
   * Does NOT handle: deeply nested objects, multi-line strings, anchors, tags.
   */
  private parseYamlBlock(
    lines: string[],
    startIdx: number,
    baseIndent: number
  ): { result: unknown; nextIdx: number } {
    const result: Record<string, unknown> = {};
    let i = startIdx;

    while (i < lines.length) {
      const line = lines[i];
      if (!line || !line.trim() || line.trim().startsWith("#")) {
        i++;
        continue;
      }

      const indent = line.search(/\S/);
      if (indent < baseIndent) break; // dedented: end of this block

      const trimmed = line.trim();

      // Array item marker: "- value" or "- key: value"
      if (trimmed.startsWith("- ")) {
        // This is an array inside the current object — we shouldn't be here.
        // Arrays are only parsed inside their parent key context.
        i++;
        continue;
      }

      // Key: value pair
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) { i++; continue; }

      const key = trimmed.slice(0, colonIdx).trim();
      const rest = trimmed.slice(colonIdx + 1).trim();

      if (rest === "") {
        // Could be: empty array (next line starts with "- "),
        // nested object (next lines are indented key:value pairs),
        // or empty array `[]`
        const nextLine = lines[i + 1];
        if (!nextLine || !nextLine.trim()) {
          result[key] = "";
          i++;
          continue;
        }

        const nextIndent = nextLine.search(/\S/);
        const nextTrimmed = nextLine.trim();

        if (nextIndent > indent && nextTrimmed.startsWith("- ")) {
          // Array of items
          const items: unknown[] = [];
          let j = i + 1;
          while (j < lines.length) {
            const arrLine = lines[j];
            if (!arrLine || !arrLine.trim()) { j++; continue; }
            const arrIndent = arrLine.search(/\S/);
            if (arrIndent <= indent) break; // dedented
            const arrTrimmed = arrLine.trim();

            if (arrTrimmed.startsWith("- ")) {
              const afterDash = arrTrimmed.slice(2).trim();
              const itemColon = afterDash.indexOf(":");

              if (itemColon !== -1) {
                // Array of objects: "- key: value"
                const itemKey = afterDash.slice(0, itemColon).trim();
                const itemVal = afterDash.slice(itemColon + 1).trim();
                const obj: Record<string, unknown> = {};

                if (itemVal !== "") {
                  obj[itemKey] = this.parseScalar(itemVal);
                }

                // Collect subsequent indented key:value pairs for this object
                let k = j + 1;
                while (k < lines.length) {
                  const subLine = lines[k];
                  if (!subLine || !subLine.trim()) { k++; continue; }
                  const subIndent = subLine.search(/\S/);
                  // Must be indented deeper than the array item itself (arrIndent + 2)
                  if (subIndent <= arrIndent) break;
                  const subTrimmed = subLine.trim();
                  if (subTrimmed.startsWith("- ")) break; // next array item

                  const subColon = subTrimmed.indexOf(":");
                  if (subColon !== -1) {
                    const subKey = subTrimmed.slice(0, subColon).trim();
                    const subVal = subTrimmed.slice(subColon + 1).trim();
                    obj[subKey] = this.parseScalar(subVal);
                  }
                  k++;
                }
                items.push(obj);
                j = k;
                continue;
              } else {
                // Array of primitives: "- value"
                items.push(this.parseScalar(afterDash));
                j++;
                continue;
              }
            }
            j++;
          }
          result[key] = items;
          i = j;
          continue;
        } else if (nextIndent > indent) {
          // Nested object
          const nested = this.parseYamlBlock(lines, i + 1, nextIndent);
          result[key] = nested.result;
          i = nested.nextIdx;
          continue;
        } else {
          result[key] = "";
          i++;
          continue;
        }
      } else if (rest === "[]") {
        result[key] = [];
      } else {
        result[key] = this.parseScalar(rest);
      }
      i++;
    }

    return { result, nextIdx: i };
  }

  private parseScalar(raw: string): unknown {
    const trimmed = raw.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null" || trimmed === "~") return null;
    // Unquoted string
    const unquoted = trimmed.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    const num = Number(unquoted);
    if (!isNaN(num) && unquoted !== "") return num;
    return unquoted;
  }
}

// Re-export types needed by consumers
import type { ObservationNode, ReflectionNode, InsightNode, ContradictionNode, MocNode, Significance, ContradictionState } from "./types";
