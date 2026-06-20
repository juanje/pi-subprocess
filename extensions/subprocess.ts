/**
 * Pi Subprocess Extension
 *
 * Minimal subprocess isolation for Pi. Registers a `subprocess` tool that
 * spawns an isolated Pi subprocess, waits for it to finish, and returns the
 * final assistant text. The parent's context stays clean — only the curated
 * result comes back.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a focused worker agent. Investigate thoroughly, then write a concise",
  "summary of your findings. Your output will be passed to another agent as",
  "context — include only what that agent needs to continue its work. No filler.",
].join(" ");

const DEFAULT_TOOLS = "read,bash,grep,find,ls";
const MAX_OUTPUT_LINES = 100;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const RECURSION_ENV_VAR = "PI_SUBPROCESS_CHILD";

type Effort = "fast" | "balanced" | "thorough";

const EFFORT_TO_THINKING: Record<Effort, string> = {
  fast: "low",
  balanced: "medium",
  thorough: "high",
};

interface MessageContent {
  type: string;
  text?: string;
}

interface MessageUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface Message {
  role: string;
  content: MessageContent[];
  usage?: MessageUsage;
}

interface SubprocessStats {
  turns: number;
  toolCalls: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  sessionDir: string;
  timedOut: boolean;
  outputTruncated: boolean;
  fullOutputFile?: string;
}

interface SubprocessParams {
  task: string;
  system_prompt?: string;
  tools?: string;
  max_lines?: number;
  effort?: Effort;
  timeout_ms?: number;
}

interface JsonEvent {
  type: string;
  message?: Message;
}

function extractFinalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      for (const part of messages[i].content) {
        if (part.type === "text" && part.text?.trim()) return part.text;
      }
    }
  }
  return "(no output)";
}

function computeStats(
  messages: Message[],
  startTime: number,
  sessionDir: string,
): Omit<SubprocessStats, "timedOut" | "outputTruncated" | "fullOutputFile"> {
  let toolCalls = 0;
  let totalTokens = 0;
  let cost = 0;

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "toolCall") toolCalls++;
      }
      if (msg.usage) {
        totalTokens += msg.usage.totalTokens ?? 0;
        cost += msg.usage.cost?.total ?? 0;
      }
    }
  }

  return {
    turns: messages.filter((m) => m.role === "assistant").length,
    toolCalls,
    totalTokens,
    cost,
    durationMs: Date.now() - startTime,
    sessionDir,
  };
}

interface TruncateResult {
  text: string;
  truncated: boolean;
}

function truncate(text: string, maxLines: number): TruncateResult {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  const truncatedText = `${lines.slice(0, maxLines).join("\n")}\n\n[TRUNCATED: showing ${maxLines} of ${lines.length} lines]`;
  return { text: truncatedText, truncated: true };
}

function saveFullOutput(text: string, sessionDir: string): string {
  const outputPath = join(sessionDir, "full-output.md");
  writeFileSync(outputPath, text);
  return outputPath;
}

function parseJsonlBuffer(buffer: string, messages: Message[]): string {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as JsonEvent;
      if (event.type === "message_end" && event.message) {
        messages.push(event.message);
      }
    } catch {
      /* skip non-JSON lines */
    }
  }
  return remainder;
}

function buildSessionDir(ctx: {
  sessionManager: { getSessionFile?: () => string | undefined };
}): string {
  const subprocId = Math.random().toString(36).slice(2, 10);
  const parentSession = ctx.sessionManager.getSessionFile?.();
  const parentDir = parentSession ? parentSession.replace(/\.jsonl$/, "") : null;
  if (parentDir) {
    const dir = join(parentDir, `subprocess-${subprocId}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  return mkdtempSync(join(tmpdir(), "pi-subprocess-"));
}

function buildArgs(
  params: SubprocessParams,
  sessionDir: string,
  promptFile: string,
  appendFile: string | null,
): string[] {
  const thinking = params.effort ? EFFORT_TO_THINKING[params.effort] : undefined;
  return [
    "--mode",
    "json",
    "-p",
    "--session-dir",
    sessionDir,
    "--system-prompt",
    promptFile,
    ...(appendFile ? ["--append-system-prompt", appendFile] : []),
    ...(thinking ? ["--thinking", thinking] : []),
    "--tools",
    params.tools || DEFAULT_TOOLS,
    params.task,
  ];
}

export default function piSubprocess(pi: ExtensionAPI) {
  if (process.env[RECURSION_ENV_VAR] === "1") return;

  pi.registerTool({
    name: "subprocess",
    label: "Subprocess",
    description:
      "Run a task in an isolated subprocess that investigates code, logs, or documents. " +
      "The subprocess runs in its own context and returns a curated summary. " +
      "Use when investigation would flood your context with raw data, or when " +
      "the user or a skill asks to run something in a subprocess.",
    parameters: Type.Object({
      task: Type.String({ description: "What the worker should do" }),
      system_prompt: Type.Optional(
        Type.String({
          description: "Custom system prompt (appended to default worker prompt)",
        }),
      ),
      tools: Type.Optional(
        Type.String({
          description: `Comma-separated tools for the worker (default: ${DEFAULT_TOOLS})`,
        }),
      ),
      max_lines: Type.Optional(
        Type.Number({
          description: `Max output lines returned (default: ${MAX_OUTPUT_LINES})`,
        }),
      ),
      effort: Type.Optional(
        Type.Union([Type.Literal("fast"), Type.Literal("balanced"), Type.Literal("thorough")], {
          description: "Thinking depth: fast (low), balanced (medium), thorough (high)",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS / 1000}s)`,
        }),
      ),
    }),

    async execute(_id, params: SubprocessParams, signal, _onUpdate, ctx) {
      const startTime = Date.now();
      const runDir = buildSessionDir(ctx);
      const promptFile = join(runDir, "system.md");
      const appendFile = params.system_prompt ? join(runDir, "append.md") : null;
      const timeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;

      writeFileSync(promptFile, DEFAULT_SYSTEM_PROMPT);
      if (appendFile) writeFileSync(appendFile, params.system_prompt as string);

      const args = buildArgs(params, runDir, promptFile, appendFile);

      const messages: Message[] = [];
      let stderr = "";
      let timedOut = false;

      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn("pi", args, {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, [RECURSION_ENV_VAR]: "1" },
          });

          const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeout);

          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            child.kill();
          });

          let buffer = "";
          child.stdout.on("data", (chunk: Buffer) => {
            buffer = parseJsonlBuffer(buffer + chunk.toString(), messages);
          });

          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });

          child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0 || messages.length > 0) resolve();
            else reject(new Error(`Worker exited with code ${code}: ${stderr.slice(0, 500)}`));
          });

          child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
      } finally {
        try {
          unlinkSync(promptFile);
        } catch {
          /* cleanup best-effort */
        }
        try {
          if (appendFile) unlinkSync(appendFile);
        } catch {
          /* cleanup best-effort */
        }
      }

      const maxLines = params.max_lines ?? MAX_OUTPUT_LINES;
      const rawOutput = extractFinalText(messages);
      const { text: output, truncated } = truncate(rawOutput, maxLines);
      const fullOutputFile = truncated ? saveFullOutput(rawOutput, runDir) : undefined;
      const stats: SubprocessStats = {
        ...computeStats(messages, startTime, runDir),
        timedOut,
        outputTruncated: truncated,
        fullOutputFile,
      };

      return {
        content: [{ type: "text", text: output }],
        details: stats,
      };
    },
  });
}

export type {
  Effort,
  JsonEvent,
  Message,
  MessageContent,
  MessageUsage,
  SubprocessParams,
  SubprocessStats,
  TruncateResult,
};
export {
  buildArgs,
  buildSessionDir,
  computeStats,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOLS,
  EFFORT_TO_THINKING,
  extractFinalText,
  MAX_OUTPUT_LINES,
  parseJsonlBuffer,
  RECURSION_ENV_VAR,
  saveFullOutput,
  truncate,
};
