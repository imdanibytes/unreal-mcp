#!/usr/bin/env node

/**
 * unreal-mcp — MCP server for controlling Unreal Engine via the Remote Control API.
 *
 * Runs as a stdio MCP server that proxies tool calls to UE's Web Remote Control
 * HTTP API. Requires the "Web Remote Control" plugin enabled in UE.
 *
 * Environment variables:
 *   UE_HOST  — Unreal Engine host (default: 127.0.0.1)
 *   UE_PORT  — Remote Control API port (default: 30010)
 *   UE_SSH_USER — SSH user on the UE host for file readback (default: claude)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";
import { z } from "zod";

// ─── Configuration ──────────────────────────────────────────────────────────

const UE_HOST = process.env.UE_HOST ?? "127.0.0.1";
const UE_PORT = parseInt(process.env.UE_PORT ?? "30010", 10);
const UE_SSH_USER = process.env.UE_SSH_USER ?? "claude";
const UE_BASE = `http://${UE_HOST}:${UE_PORT}`;
const RESULT_FILE = "C:/tmp/nora_mcp_result.json";

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function ue(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const resp = await fetch(`${UE_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(
      `UE ${method} ${path} → ${resp.status}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return text || null;
  }
}

// ─── SSH helpers ────────────────────────────────────────────────────────────

function sshRead(remotePath: string): string {
  const escaped = remotePath.replace(/\//g, "\\");
  return execSync(
    `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no ${UE_SSH_USER}@${UE_HOST} "type ${escaped}"`,
    { timeout: 10_000, encoding: "utf-8" },
  );
}

// ─── Python execution with output capture ───────────────────────────────────

async function execPythonWithOutput(code: string): Promise<string> {
  // Wrap user code to capture stdout and write to a temp file
  const wrapper = `
import sys, io, json, traceback
_nora_stdout = sys.stdout
_nora_buf = io.StringIO()
sys.stdout = _nora_buf
_nora_err = None
try:
    exec(${JSON.stringify(code)})
except Exception as e:
    _nora_err = traceback.format_exc()
finally:
    sys.stdout = _nora_stdout
    _nora_out = _nora_buf.getvalue()
    with open(${JSON.stringify(RESULT_FILE.replace(/\\/g, "/"))}, 'w', encoding='utf-8') as f:
        json.dump({"output": _nora_out, "error": _nora_err}, f)
`.trim();

  await ue("PUT", "/remote/object/call", {
    objectPath: "/Script/PythonScriptPlugin.Default__PythonScriptLibrary",
    functionName: "ExecutePythonCommand",
    parameters: { PythonCommand: wrapper },
  });

  // Small delay for file write to flush
  await new Promise((r) => setTimeout(r, 200));

  // Read result back via SSH
  const raw = sshRead(RESULT_FILE);
  const result = JSON.parse(raw);

  if (result.error) {
    throw new Error(result.error);
  }
  return result.output || "(no output)";
}

// ─── Result helpers ─────────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function err(error: unknown): ToolResult {
  const msg = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "unreal-engine",
  version: "0.2.0",
});

// ── ue_get_property ─────────────────────────────────────────────────────────

server.tool(
  "ue_get_property",
  "Read a UPROPERTY value from a UObject in Unreal Engine",
  {
    object_path: z
      .string()
      .describe(
        "Full object path (e.g. /Game/Maps/Main.Main:PersistentLevel.MyActor)",
      ),
    property_name: z.string().describe("Property name to read"),
  },
  async ({ object_path, property_name }) => {
    try {
      return ok(
        await ue("PUT", "/remote/object/property", {
          objectPath: object_path,
          access: "READ_ACCESS",
          propertyName: property_name,
        }),
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ── ue_set_property ─────────────────────────────────────────────────────────

server.tool(
  "ue_set_property",
  "Set a UPROPERTY value on a UObject in Unreal Engine (with undo support)",
  {
    object_path: z.string().describe("Full object path"),
    property_name: z.string().describe("Property name to set"),
    value: z
      .string()
      .describe(
        "New property value as a JSON string (will be parsed). " +
          'Examples: "true", "42", \'{"X":1,"Y":2,"Z":3}\'',
      ),
  },
  async ({ object_path, property_name, value }) => {
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }

      return ok(
        await ue("PUT", "/remote/object/property", {
          objectPath: object_path,
          access: "WRITE_TRANSACTION_ACCESS",
          propertyName: property_name,
          propertyValue: parsed,
        }),
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ── ue_call_function ────────────────────────────────────────────────────────

server.tool(
  "ue_call_function",
  "Call a UFUNCTION on a UObject in Unreal Engine. For static library " +
    "functions, use the Default__ object path (e.g. " +
    "/Script/EditorScriptingUtilities.Default__EditorLevelLibrary).",
  {
    object_path: z
      .string()
      .describe("Full object path or Default__ class path"),
    function_name: z.string().describe("Function name to call"),
    parameters: z
      .string()
      .optional()
      .describe(
        "Function parameters as a JSON object string. " +
          'Example: \'{"NewLocation":{"X":100,"Y":0,"Z":0}}\'',
      ),
    generate_transaction: z
      .boolean()
      .optional()
      .default(true)
      .describe("Record in undo history (default: true)"),
  },
  async ({ object_path, function_name, parameters, generate_transaction }) => {
    try {
      let params: Record<string, unknown> = {};
      if (parameters) {
        try {
          params = JSON.parse(parameters);
        } catch {
          return err(`Invalid JSON in parameters: ${parameters}`);
        }
      }

      return ok(
        await ue("PUT", "/remote/object/call", {
          objectPath: object_path,
          functionName: function_name,
          parameters: params,
          generateTransaction: generate_transaction,
        }),
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ── ue_describe_object ──────────────────────────────────────────────────────

server.tool(
  "ue_describe_object",
  "Get metadata about a UObject: its class, properties, and callable functions",
  {
    object_path: z.string().describe("Full object path"),
  },
  async ({ object_path }) => {
    try {
      const raw = (await ue("PUT", "/remote/object/describe", {
        objectPath: object_path,
      })) as Record<string, unknown>;

      // Return a compact summary: class + property/function name lists
      const props = (raw.Properties as Array<Record<string, unknown>>) ?? [];
      const funcs = (raw.Functions as Array<Record<string, unknown>>) ?? [];

      const summary = {
        Class: raw.Class,
        Name: raw.Name,
        PropertyCount: props.length,
        Properties: props.map((p) => ({
          Name: p.Name,
          Type: p.Type,
          ...(p.Description ? { Description: p.Description } : {}),
        })),
        FunctionCount: funcs.length,
        Functions: funcs.map((f) => ({
          Name: f.Name,
          ...(f.Description ? { Description: f.Description } : {}),
        })),
      };

      return ok(summary);
    } catch (e) {
      return err(e);
    }
  },
);

// ── ue_search_assets ────────────────────────────────────────────────────────

server.tool(
  "ue_search_assets",
  "Search the Unreal Engine Asset Registry by name, class, or path",
  {
    query: z.string().describe("Search query string"),
    class_names: z
      .string()
      .optional()
      .describe(
        'Comma-separated class filter (e.g. "Blueprint,StaticMesh")',
      ),
    path_filter: z
      .string()
      .optional()
      .describe('Content path filter (e.g. "/Game/Characters")'),
  },
  async ({ query, class_names, path_filter }) => {
    try {
      const filter: Record<string, unknown> = {};
      if (class_names) {
        filter.classNames = class_names.split(",").map((s) => s.trim());
      }
      if (path_filter) {
        filter.paths = [path_filter];
      }

      const raw = (await ue("PUT", "/remote/search/assets", {
        query,
        filter,
      })) as Record<string, unknown>;

      // Return compact results: name, class, path only (no metadata blob)
      const assets = (raw.Assets as Array<Record<string, unknown>>) ?? [];
      const compact = assets.map((a) => ({
        Name: a.Name,
        Class: a.Class,
        Path: a.Path,
      }));

      return ok({ Count: compact.length, Assets: compact });
    } catch (e) {
      return err(e);
    }
  },
);

// ── ue_list_actors ──────────────────────────────────────────────────────────

server.tool(
  "ue_list_actors",
  "List all actors in the current editor level. Requires the " +
    "Editor Scripting Utilities plugin.",
  {},
  async () => {
    try {
      const output = await execPythonWithOutput(`
import unreal
actors = unreal.EditorLevelLibrary.get_all_level_actors()
for a in actors:
    loc = a.get_actor_location()
    print(f"{a.get_name()} | {a.get_class().get_name()} | ({loc.x:.0f}, {loc.y:.0f}, {loc.z:.0f})")
`);
      return ok(output);
    } catch (e) {
      return err(e);
    }
  },
);

// ── ue_exec_console ─────────────────────────────────────────────────────────

server.tool(
  "ue_exec_console",
  "Execute an Unreal Engine console command. Fire-and-forget — output " +
    "appears in UE's Output Log, not in the response.",
  {
    command: z
      .string()
      .describe(
        'Console command (e.g. "stat fps", "HighResShot 1920x1080", "py print(42)")',
      ),
  },
  async ({ command }) => {
    try {
      await ue("PUT", "/remote/object/call", {
        objectPath: "/Script/Engine.Default__KismetSystemLibrary",
        functionName: "ExecuteConsoleCommand",
        parameters: {
          WorldContextObject: { objectPath: "" },
          Command: command,
        },
      });
      return ok(
        `Console command sent: ${command}\nCheck UE Output Log for results.`,
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ── ue_exec_python ──────────────────────────────────────────────────────────

server.tool(
  "ue_exec_python",
  "Execute Python code inside the Unreal Engine editor. Requires the " +
    'Python Editor Script Plugin. Use the "unreal" module for UE API access. ' +
    "Output appears in UE's Output Log.",
  {
    code: z
      .string()
      .describe(
        "Python code to execute. For multi-line scripts, separate lines " +
          "with semicolons or use exec() with a triple-quoted string.",
      ),
  },
  async ({ code }) => {
    try {
      const output = await execPythonWithOutput(code);
      return ok(output);
    } catch (e) {
      return err(e);
    }
  },
);

// ── ue_batch ────────────────────────────────────────────────────────────────

server.tool(
  "ue_batch",
  "Execute multiple Remote Control operations in a single HTTP round-trip. " +
    "Each request is a JSON object for /remote/object/property or " +
    "/remote/object/call.",
  {
    requests: z
      .string()
      .describe(
        "JSON array of request objects. Each object should have the same " +
          "shape as ue_get_property, ue_set_property, or ue_call_function payloads.",
      ),
  },
  async ({ requests }) => {
    try {
      let parsed: unknown[];
      try {
        parsed = JSON.parse(requests);
      } catch {
        return err(`Invalid JSON array: ${requests.slice(0, 200)}`);
      }

      return ok(
        await ue("PUT", "/remote/batch", {
          requests: parsed,
        }),
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ── ue_remote_info ──────────────────────────────────────────────────────────

server.tool(
  "ue_remote_info",
  "List all available HTTP routes on the UE Remote Control API. " +
    "Useful for discovering what endpoints are available.",
  {},
  async () => {
    try {
      return ok(await ue("GET", "/remote/info"));
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[unreal-mcp] v0.2.0 ready — target: ${UE_BASE}`);
}

main().catch((error) => {
  console.error("[unreal-mcp] Fatal:", error);
  process.exit(1);
});
