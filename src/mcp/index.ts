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

const ADDRESS =
  "handle (#317H), position (src/main.rs:12 or :3-15), or symbol (Widget::count)";

async function main(): Promise<void> {
  const root = process.env.FLUENT_ROOT ?? process.cwd();
  const daemon = new DaemonClient(root);

  const server = new McpServer({ name: "mcp-fluent", version: "0.0.1" });

  const call = async (request: Request) => {
    const res = await daemon.send(request);
    return {
      content: [{ type: "text" as const, text: `${indexNotice(res.index)}${res.text}` }],
      isError: !res.ok,
    };
  };

  server.registerTool(
    "find",
    {
      description: "Search for a string. Returns hits grouped by file and enclosing item, each with a handle and size.",
      inputSchema: {
        needle: z.string().describe("text to search for"),
        haystack: z.string().optional().describe(`scope to search: ${ADDRESS}`),
      },
    },
    async ({ needle, haystack }) =>
      call({ op: "find", ...(haystack === undefined ? {} : { haystack }), needle }),
  );

  server.registerTool(
    "read",
    {
      description: "Return source. A handle returns its whole referent; a position returns those literal lines.",
      inputSchema: {
        target: z.string().describe(ADDRESS),
        maxLines: z.number().int().optional(),
        maxBytesPerLine: z.number().int().optional().describe("average across response; -1 to disable"),
      },
    },
    async (args) => call({ op: "read", ...args }),
  );

  server.registerTool(
    "refs",
    {
      description: "Find references to a symbol. Re-run rather than reusing an earlier result before editing.",
      inputSchema: { target: z.string().describe(ADDRESS) },
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
            "handles this edit's correctness depends on. List every one — over-listing costs a retry, under-listing costs a wrong edit.",
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
          .describe("handles this move's correctness depends on, same as edit's deps"),
      },
    },
    async (args) => call({ op: "move", ...args }),
  );

  server.registerTool(
    "trace",
    {
      description: "Follow a value up or down the call chain. Naive: every branch reports why it stopped.",
      inputSchema: {
        target: z.string().describe(ADDRESS),
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
  if (index.readiness === "failed") return "index unavailable: rust-analyzer failed to start\n";

  const detail = [
    index.phase,
    index.percentage === undefined ? undefined : `${index.percentage}%`,
  ].filter((item): item is string => item !== undefined).join(" ");
  const message = index.message === undefined ? "" : ` — ${index.message}`;
  return `index warming${detail === "" ? "" : `: ${detail}`}${message}\n`;
}

void main();
