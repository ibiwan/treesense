#!/usr/bin/env node
/**
 * mcp-fluent — the thin half. Spawned per client session, holds no state.
 *
 * Tool descriptions are deliberately terse: definitions sit in the model's
 * context on every single request, used or not, so a comprehensive surface is
 * a permanent tax paid against the exact metric this tool exists to improve.
 * Six verbs, short schemas, no `mode` or `scope` knobs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DaemonClient } from "./client.js";
import type { Request } from "../shared/protocol.js";

const HANDLE_OR_POSITION = "handle (#317H) or position (src/main.rs:12 or :3-15)";
const REFS_ADDRESS = `${HANDLE_OR_POSITION}, or symbolic name (Widget::count)`;

async function main(): Promise<void> {
  const root = process.env.FLUENT_ROOT ?? process.cwd();
  const daemon = new DaemonClient(root);

  const server = new McpServer(
    { name: "mcp-fluent", version: "0.0.1" },
    {
      instructions:
        "Start overview → find({needle: \"marine\", collapse: true}) → read({target: \"#handle\"}). find/read work immediately; refs/trace wait for the semantic index. Cite handles after reconnaissance; avoid bulk source reads.",
    },
  );

  const call = async (request: Request) => {
    const res = await daemon.send(request);
    return {
      content: [{ type: "text" as const, text: `${indexNotice(res.index)}${res.text}` }],
      // Text keeps the readiness decision visible to agents; this companion
      // shape lets MCP clients consume the same status without parsing prose.
      structuredContent: { index: res.index, capabilities: indexCapabilities(res.index) },
      isError: !res.ok,
    };
  };

  server.registerTool(
    "overview",
    {
      description: "Orient in a project without reading source: bounded source tree, manifests, and heuristic entry-like files. Listed file paths can be passed to read or find's haystack. Example: overview({}).",
    },
    async () => call({ op: "overview" }),
  );

  server.registerTool(
    "find",
    {
      description: "Search source and return handle-bearing structural hits. Exact text first; a zero retries case-insensitive and identifier-normalized spelling. Set collapse for one enclosing region per hit cluster during reconnaissance. Example: find({needle: \"marine\", collapse: true}). haystack accepts a file, file range, or handle.",
      inputSchema: {
        needle: z.string().describe("text to search for"),
        haystack: z.string().optional().describe("optional scope: file, line range, or handle"),
        collapse: z.boolean().optional().describe("one best enclosing region per hit cluster; use for reconnaissance, not precise edits"),
      },
    },
    async ({ needle, haystack, collapse }) =>
      call({
        op: "find",
        needle,
        collapse: collapse ?? false,
        ...(haystack === undefined ? {} : { haystack }),
      }),
  );

  server.registerTool(
    "read",
    {
      description: "Return source for a handle or position. A large whole-file request returns a structural overview; pass one of its handles back to read for that section. Prefer mcp_fluent summaries and handle-based drill-down; raw reads are an exception. Example: read({target: \"#6B\"}); a path/position is src/main.rs:12. Use -1 only when raw source is deliberately needed.",
      inputSchema: {
        target: z.string().describe(HANDLE_OR_POSITION),
        sections: z.array(z.string()).max(8).optional().describe("optional child handles from target's overview; reads those sections in one call"),
        maxLines: z.number().int().optional().describe("maximum position-read lines; -1 forces source instead of an overview"),
        maxBytesPerLine: z.number().int().optional().describe("average bytes per line; -1 disables the density guard and forces source"),
      },
    },
    async (args) => call({ op: "read", ...args }),
  );

  server.registerTool(
    "refs",
    {
      description: "Resolve a symbol and list references. Waits for the semantic index; symbolic names work here, and ambiguity returns handles to choose from. Example: refs({target: \"#6B\"}). Re-run before editing.",
      inputSchema: { target: z.string().describe(REFS_ADDRESS) },
    },
    async ({ target }) => call({ op: "refs", target }),
  );

  server.registerTool(
    "edit",
    {
      description: "Modify source at a handle. Fails if the target or any dep changed.",
      inputSchema: {
        target: z.string().describe("handle only"),
        action: z.enum(["replace", "insert-before", "insert-after", "delete"]),
        content: z.string().default(""),
        deps: z
          .array(z.string())
          .default([])
          .describe(
            "optional risk reduction: list handles whose current form the edit assumes. Omit for a loose workflow; listed deps must be current. Over-listing costs a retry, under-listing risks a wrong edit.",
          ),
      },
    },
    async (args) => call({ op: "edit", ...args }),
  );

  server.registerTool(
    "move",
    {
      description: "Relocate a handle's bytes to sit before or after another handle. Cross-file writes the destination first, so a failure partway through leaves a duplicate, never a loss.",
      inputSchema: {
        source: z.string().describe("handle only"),
        destination: z.string().describe("handle only"),
        action: z.enum(["insert-before", "insert-after"]),
        deps: z
          .array(z.string())
          .default([])
          .describe("optional risk reduction: handles whose current form this move assumes. Omit for a loose workflow; listed deps must be current."),
      },
    },
    async (args) => call({ op: "move", ...args }),
  );

  server.registerTool(
    "trace",
    {
      description: "Follow a value up or down the call chain. Waits for the semantic index; supports handles and positions, not symbolic names. Example: trace({target: \"#6B\", maxDown: 2}). Naive: every branch reports why it stopped.",
      inputSchema: {
        target: z.string().describe(HANDLE_OR_POSITION),
        maxUp: z.number().int().default(-1),
        maxDown: z.number().int().default(3),
      },
    },
    async (args) => call({ op: "trace", ...args }),
  );

  await server.connect(new StdioServerTransport());
}

/**
 * Visible only while warming: its purpose is to let an agent choose immediate
 * read/find work over a semantic request that would otherwise wait silently.
 */
function indexNotice(index: {
  readiness: "starting" | "indexing" | "ready" | "failed";
  phase?: string | undefined;
  message?: string | undefined;
  percentage?: number | undefined;
}): string {
  if (index.readiness === "ready") return "";
  if (index.readiness === "failed") {
    return "capabilities: find=ready read=ready refs=unavailable trace=unavailable\nindex unavailable: semantic refs/trace cannot run; find/read remain available\n";
  }

  const detail = [
    index.phase,
    index.percentage === undefined ? undefined : `${index.percentage}%`,
  ].filter((item): item is string => item !== undefined).join(" ");
  const message = index.message === undefined ? "" : ` — ${index.message}`;
  return (
    `index warming${detail === "" ? "" : `: ${detail}`}${message}\n`
    + "capabilities: find=ready read=ready refs=pending trace=pending\n"
    + "refs/trace wait automatically for semantic resolution, so do not retry them. Continue discovery now; the index stays warm while fluentd runs.\n"
  );
}

function indexCapabilities(index: { readiness: "starting" | "indexing" | "ready" | "failed" }): Record<string, "ready" | "pending" | "unavailable"> {
  if (index.readiness === "failed") {
    return { find: "ready", read: "ready", refs: "unavailable", trace: "unavailable" };
  }
  if (index.readiness === "ready") {
    return { find: "ready", read: "ready", refs: "ready", trace: "ready" };
  }
  return { find: "ready", read: "ready", refs: "pending", trace: "pending" };
}

void main();
