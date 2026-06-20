import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildArgs,
  computeStats,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOLS,
  EFFORT_TO_THINKING,
  extractFinalText,
  MAX_OUTPUT_LINES,
  type Message,
  parseJsonlBuffer,
  RECURSION_ENV_VAR,
  type SubprocessParams,
  saveFullOutput,
  truncate,
} from "../extensions/delegate.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("extractFinalText", () => {
  it("extracts text from last assistant message", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "first response" }] },
      { role: "user", content: [{ type: "text", text: "follow up" }] },
      { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    ];
    expect(extractFinalText(messages)).toBe("final answer");
  });

  it("returns '(no output)' for empty messages", () => {
    expect(extractFinalText([])).toBe("(no output)");
  });

  it("returns '(no output)' when no assistant messages", () => {
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    expect(extractFinalText(messages)).toBe("(no output)");
  });

  it("skips assistant messages with only tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "actual output" }],
      },
    ];
    expect(extractFinalText(messages)).toBe("actual output");
  });

  it("skips empty text parts", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   " },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "real content" }],
      },
    ];
    expect(extractFinalText(messages)).toBe("real content");
  });

  it("returns '(no output)' when all text is whitespace", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "   \n  " }],
      },
    ];
    expect(extractFinalText(messages)).toBe("(no output)");
  });

  it("handles mixed content types", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall" }, { type: "text", text: "after tool" }],
      },
    ];
    expect(extractFinalText(messages)).toBe("after tool");
  });
});

describe("computeStats", () => {
  it("computes stats from messages", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall" }, { type: "toolCall" }, { type: "text", text: "done" }],
        usage: { totalTokens: 500, cost: { total: 0.05 } },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        usage: { totalTokens: 200, cost: { total: 0.02 } },
      },
    ];
    const stats = computeStats(messages, Date.now() - 1000, "/tmp/session");
    expect(stats.turns).toBe(2);
    expect(stats.toolCalls).toBe(2);
    expect(stats.totalTokens).toBe(700);
    expect(stats.cost).toBeCloseTo(0.07);
    expect(stats.durationMs).toBeGreaterThanOrEqual(1000);
    expect(stats.sessionDir).toBe("/tmp/session");
  });

  it("handles messages with no usage", () => {
    const messages: Message[] = [{ role: "assistant", content: [{ type: "text", text: "hi" }] }];
    const stats = computeStats(messages, Date.now(), "/tmp/s");
    expect(stats.turns).toBe(1);
    expect(stats.toolCalls).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.cost).toBe(0);
  });

  it("handles empty messages", () => {
    const stats = computeStats([], Date.now(), "/tmp/s");
    expect(stats.turns).toBe(0);
    expect(stats.toolCalls).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.cost).toBe(0);
  });

  it("ignores user messages", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall" }],
        usage: { totalTokens: 100 },
      },
    ];
    const stats = computeStats(messages, Date.now(), "/tmp/s");
    expect(stats.turns).toBe(1);
    expect(stats.toolCalls).toBe(1);
    expect(stats.totalTokens).toBe(100);
  });

  it("handles missing cost object", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text" }],
        usage: { totalTokens: 100 },
      },
    ];
    const stats = computeStats(messages, Date.now(), "/tmp/s");
    expect(stats.cost).toBe(0);
  });
});

describe("truncate", () => {
  it("returns text unchanged when under limit", () => {
    const result = truncate("line1\nline2\nline3", 5);
    expect(result.text).toBe("line1\nline2\nline3");
    expect(result.truncated).toBe(false);
  });

  it("returns text unchanged at exact limit", () => {
    const result = truncate("a\nb\nc", 3);
    expect(result.text).toBe("a\nb\nc");
    expect(result.truncated).toBe(false);
  });

  it("truncates and adds notice when over limit", () => {
    const result = truncate("a\nb\nc\nd\ne", 3);
    expect(result.text).toContain("a\nb\nc");
    expect(result.text).toContain("[TRUNCATED: showing 3 of 5 lines]");
    expect(result.text).not.toContain("\nd\n");
    expect(result.truncated).toBe(true);
  });

  it("handles single line within limit", () => {
    const result = truncate("single line", 10);
    expect(result.text).toBe("single line");
    expect(result.truncated).toBe(false);
  });

  it("truncates to 1 line", () => {
    const result = truncate("a\nb\nc", 1);
    expect(result.text).toContain("a");
    expect(result.text).toContain("[TRUNCATED: showing 1 of 3 lines]");
    expect(result.truncated).toBe(true);
  });
});

describe("parseJsonlBuffer", () => {
  it("extracts message_end events", () => {
    const messages: Message[] = [];
    const msg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    };
    const buffer = `${JSON.stringify({ type: "message_end", message: msg })}\n`;
    const remainder = parseJsonlBuffer(buffer, messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].content[0].text).toBe("hello");
    expect(remainder).toBe("");
  });

  it("ignores non-message_end events", () => {
    const messages: Message[] = [];
    const buffer = `${JSON.stringify({ type: "tool_start", name: "read" })}\n`;
    parseJsonlBuffer(buffer, messages);
    expect(messages).toHaveLength(0);
  });

  it("returns remainder for incomplete lines", () => {
    const messages: Message[] = [];
    const remainder = parseJsonlBuffer('{"type":"mess', messages);
    expect(remainder).toBe('{"type":"mess');
    expect(messages).toHaveLength(0);
  });

  it("handles multiple events in one buffer", () => {
    const messages: Message[] = [];
    const msg1: Message = { role: "assistant", content: [{ type: "toolCall" }] };
    const msg2: Message = { role: "assistant", content: [{ type: "text", text: "done" }] };
    const buffer = [
      JSON.stringify({ type: "message_end", message: msg1 }),
      JSON.stringify({ type: "tool_result", result: "ok" }),
      JSON.stringify({ type: "message_end", message: msg2 }),
      "",
    ].join("\n");
    parseJsonlBuffer(buffer, messages);
    expect(messages).toHaveLength(2);
  });

  it("skips empty lines", () => {
    const messages: Message[] = [];
    parseJsonlBuffer("\n\n\n", messages);
    expect(messages).toHaveLength(0);
  });

  it("skips invalid JSON lines", () => {
    const messages: Message[] = [];
    parseJsonlBuffer("not json\n{also bad}\n", messages);
    expect(messages).toHaveLength(0);
  });
});

describe("buildArgs", () => {
  it("builds default args", () => {
    const params: SubprocessParams = { task: "investigate logs" };
    const args = buildArgs(params, "/tmp/session", "/tmp/system.md", null);
    expect(args).toContain("--mode");
    expect(args).toContain("json");
    expect(args).toContain("-p");
    expect(args).toContain("--session-dir");
    expect(args).toContain("/tmp/session");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("/tmp/system.md");
    expect(args).toContain("--tools");
    expect(args).toContain(DEFAULT_TOOLS);
    expect(args[args.length - 1]).toBe("investigate logs");
    expect(args).not.toContain("--thinking");
  });

  it("includes append system prompt when provided", () => {
    const params: SubprocessParams = { task: "do work" };
    const args = buildArgs(params, "/tmp/s", "/tmp/sys.md", "/tmp/append.md");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("/tmp/append.md");
  });

  it("uses custom tools when provided", () => {
    const params: SubprocessParams = { task: "read only", tools: "read" };
    const args = buildArgs(params, "/tmp/s", "/tmp/sys.md", null);
    expect(args).toContain("read");
    expect(args).not.toContain(DEFAULT_TOOLS);
  });

  it("places session dir directly in args (no placeholder)", () => {
    const params: SubprocessParams = { task: "work" };
    const args = buildArgs(params, "/my/session/dir", "/tmp/sys.md", null);
    const idx = args.indexOf("--session-dir");
    expect(args[idx + 1]).toBe("/my/session/dir");
    expect(args).not.toContain("");
  });

  it("adds --thinking flag for effort: fast", () => {
    const params: SubprocessParams = { task: "quick check", effort: "fast" };
    const args = buildArgs(params, "/tmp/s", "/tmp/sys.md", null);
    const idx = args.indexOf("--thinking");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("low");
  });

  it("adds --thinking flag for effort: thorough", () => {
    const params: SubprocessParams = { task: "deep analysis", effort: "thorough" };
    const args = buildArgs(params, "/tmp/s", "/tmp/sys.md", null);
    const idx = args.indexOf("--thinking");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("high");
  });

  it("adds --thinking flag for effort: balanced", () => {
    const params: SubprocessParams = { task: "normal work", effort: "balanced" };
    const args = buildArgs(params, "/tmp/s", "/tmp/sys.md", null);
    const idx = args.indexOf("--thinking");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("medium");
  });
});

describe("saveFullOutput", () => {
  it("writes full output to file and returns path", () => {
    const dir = makeTempDir("sp-fullout-");
    const content = "line1\nline2\nline3\nline4\nline5";
    const path = saveFullOutput(content, dir);
    expect(path).toContain("full-output.md");
    expect(readFileSync(path, "utf-8")).toBe(content);
  });
});

describe("EFFORT_TO_THINKING", () => {
  it("maps fast to low", () => {
    expect(EFFORT_TO_THINKING.fast).toBe("low");
  });

  it("maps balanced to medium", () => {
    expect(EFFORT_TO_THINKING.balanced).toBe("medium");
  });

  it("maps thorough to high", () => {
    expect(EFFORT_TO_THINKING.thorough).toBe("high");
  });
});

describe("constants", () => {
  it("DEFAULT_SYSTEM_PROMPT is a non-empty string", () => {
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(50);
    expect(DEFAULT_SYSTEM_PROMPT).toContain("focused worker agent");
  });

  it("DEFAULT_TOOLS is a comma-separated tool list", () => {
    expect(DEFAULT_TOOLS).toBe("read,bash,grep,find,ls");
  });

  it("MAX_OUTPUT_LINES defaults to 100", () => {
    expect(MAX_OUTPUT_LINES).toBe(100);
  });

  it("DEFAULT_TIMEOUT_MS is 15 minutes", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });

  it("RECURSION_ENV_VAR is the expected value", () => {
    expect(RECURSION_ENV_VAR).toBe("PI_SUBPROCESS_CHILD");
  });
});
