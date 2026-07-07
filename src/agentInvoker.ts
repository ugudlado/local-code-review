import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { SessionData, SessionThread } from "./sessionStore";
import { describeAnchor } from "./anchor";

interface AgentConfig {
  /** CLI command name */
  command: string;
  /** How to pass a prompt non-interactively */
  buildArgs: (prompt: string) => string[];
}

const AGENTS: Record<string, AgentConfig> = {
  claude: {
    command: "claude",
    buildArgs: (prompt) => ["-p", prompt],
  },
  gemini: {
    command: "gemini",
    buildArgs: (prompt) => ["-p", prompt],
  },
  codex: {
    command: "codex",
    buildArgs: (prompt) => ["exec", prompt],
  },
};

/**
 * Builds the full resolve prompt and writes it to .review/resolve-prompt.md.
 * Returns the file path for reference.
 */
function writeResolvePrompt(
  workspaceRoot: string,
  sessionFilePath: string,
  session: SessionData,
): string {
  const openThreads = session.threads.filter((t) => t.status === "open");
  const threadDetails = openThreads.map(formatThread).join("\n\n");

  const prompt = `# Resolve Review Threads

Resolve the open code review threads for the \`${session.sessionId}\` branch.

## Session File

\`${sessionFilePath}\`

Read this JSON file for the full review state. After resolving threads, write the updated JSON back.

## Instructions

For each open thread below:

1. Read the file referenced in the thread anchor
2. Understand the review comment and the surrounding code
3. **If the fix is clear**: apply the fix to the code, then set thread \`status\` to \`"resolved"\` and add a message explaining what you did
4. **If unclear**: reply to the thread with a question, keep status as \`"open"\`

## Rules

- Set \`authorType: "agent"\` and \`author\` to your model name on messages you create
- Generate UUID v4 for new message IDs
- Update \`lastUpdatedAt\` on each thread you modify
- Update \`metadata.updatedAt\` on the session
- Read → modify → write the full session JSON (don't partially overwrite)

## Open Threads (${openThreads.length})

${threadDetails}
`;

  const reviewDir = path.join(workspaceRoot, ".review");
  fs.mkdirSync(reviewDir, { recursive: true });
  const promptPath = path.join(reviewDir, "resolve-prompt.md");
  fs.writeFileSync(promptPath, prompt);
  return promptPath;
}

function formatThread(thread: SessionThread): string {
  const msgs = thread.messages
    .map(
      (m) =>
        `  ${m.authorType === "agent" ? "🤖" : "👤"} ${m.author}: ${m.text}`,
    )
    .join("\n");

  return `### Thread \`${thread.id.slice(0, 8)}\` — ${thread.severity}
${describeAnchor(thread.anchor)}
- **Messages**:
${msgs}`;
}

/**
 * Send the resolve command to an existing interactive terminal session.
 * Writes the full prompt to .review/resolve-prompt.md, then sends a short
 * trigger message to the terminal pointing at the file.
 */
export async function resolveInExistingTerminal(
  sessionFilePath: string,
  session: SessionData,
  workspaceRoot: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const openCount = session.threads.filter((t) => t.status === "open").length;
  if (openCount === 0) {
    void vscode.window.showInformationMessage("No open threads to resolve.");
    return;
  }

  // Write the full resolve prompt to a file the agent can read
  const promptPath = writeResolvePrompt(
    workspaceRoot,
    sessionFilePath,
    session,
  );

  // Let user pick which terminal to send to
  const terminals = vscode.window.terminals;
  if (terminals.length === 0) {
    void vscode.window.showWarningMessage(
      "No open terminals. Start your coding agent in a terminal first.",
    );
    return;
  }

  let terminal: vscode.Terminal;
  if (terminals.length === 1) {
    terminal = terminals[0];
  } else {
    const picked = await vscode.window.showQuickPick(
      terminals.map((t) => ({ label: t.name, terminal: t })),
      { placeHolder: "Select the terminal running your coding agent" },
    );
    if (!picked) return;
    terminal = picked.terminal;
  }

  terminal.show();

  // Send a short trigger — the agent reads the prompt file for details
  const shortPrompt = `Resolve ${openCount} open review thread(s). Read the instructions at: ${promptPath}`;
  terminal.sendText(shortPrompt);

  outputChannel.appendLine(
    `Sent resolve prompt to terminal "${terminal.name}" (${openCount} threads)`,
  );
}

/**
 * Spawn a new agent process in a dedicated terminal with the resolve prompt.
 */
export function resolveWithNewAgent(
  sessionFilePath: string,
  session: SessionData,
  workspaceRoot: string,
  outputChannel: vscode.OutputChannel,
): void {
  const config = vscode.workspace.getConfiguration("resolvr");
  const agentName = config.get<string>("codingAgent", "claude");
  const agentConfig = AGENTS[agentName];

  if (!agentConfig) {
    void vscode.window.showErrorMessage(
      `Unknown coding agent: "${agentName}". Supported: ${Object.keys(AGENTS).join(", ")}`,
    );
    return;
  }

  const openCount = session.threads.filter((t) => t.status === "open").length;
  if (openCount === 0) {
    void vscode.window.showInformationMessage("No open threads to resolve.");
    return;
  }

  // Write prompt file and pass it to the agent CLI
  const promptPath = writeResolvePrompt(
    workspaceRoot,
    sessionFilePath,
    session,
  );

  outputChannel.appendLine(
    `Resolving ${openCount} thread(s) with ${agentName} (new terminal)`,
  );

  const terminalName = `Resolvr: ${agentName}`;
  const terminal = vscode.window.createTerminal({
    name: terminalName,
    cwd: workspaceRoot,
  });

  terminal.show();

  // Use the prompt file instead of inlining — cleaner and avoids shell escaping issues
  const readPrompt = `Read and follow instructions in ${promptPath}`;
  const args = agentConfig.buildArgs(readPrompt);
  const cmd = `${agentConfig.command} ${args.map(shellEscape).join(" ")}`;

  terminal.sendText(cmd);

  void vscode.window.showInformationMessage(
    `Resolving ${openCount} thread(s) with ${agentName}. Check the terminal.`,
  );
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
