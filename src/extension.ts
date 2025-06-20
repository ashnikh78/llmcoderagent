import * as vscode from "vscode";
import axios, { AxiosError } from "axios";
import { basename, join } from "path";
import { Uri } from "vscode";
import sanitizeHtml from "sanitize-html";
import { minimatch } from "minimatch";
import { promises as fs } from "fs";
import { tmpdir } from "os";

// Constants
const OUTPUT_CHANNEL = vscode.window.createOutputChannel(
  "LLMCoderAgent",
  "log"
);

// Interfaces
interface FileReview {
  uri: vscode.Uri;
  content: string;
  review: string;
  suggestedChanges?: string;
}

interface LLMResponse {
  text: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

// Utility Functions
function log(
  message: string,
  level: "INFO" | "ERROR" | "DEBUG" = "INFO"
): void {
  OUTPUT_CHANNEL.appendLine(
    `[${new Date().toISOString()}] [${level}] ${message}`
  );
}

function showStatusMessage(
  message: string,
  config: vscode.WorkspaceConfiguration
): void {
  const timeout = config.get<number>("statusBarTimeout", 2000);
  vscode.window
    .showInformationMessage(message, { modal: false })
    .then(undefined, () => {});
  setTimeout(() => {}, timeout); // Ensure message is visible for the specified duration
}

function shouldIncludeFile(
  uri: vscode.Uri,
  config: vscode.WorkspaceConfiguration
): boolean {
  try {
    const includePatterns = config.get<string[]>("includePatterns", [
      "**/*.{ts,js,py,md}",
    ]);
    const excludePatterns = config.get<string[]>("excludePatterns", [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/*.log",
      "**/*.lock",
      "**/*.bak.*",
    ]);
    const relativePath = vscode.workspace.asRelativePath(uri);
    const included = includePatterns.some((pattern) =>
      minimatch(relativePath, pattern)
    );
    const excluded = excludePatterns.some((pattern) =>
      minimatch(relativePath, pattern)
    );
    return included && !excluded;
  } catch (error) {
    log(
      `Error filtering file ${uri.fsPath}: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      "ERROR"
    );
    return false;
  }
}

async function readFileContent(
  uri: vscode.Uri,
  config: vscode.WorkspaceConfiguration
): Promise<string> {
  try {
    const maxFileSize = config.get<number>("maxFileSize", 100000);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > maxFileSize) {
      throw new Error(
        `File size (${stat.size} bytes) exceeds limit of ${maxFileSize} bytes`
      );
    }
    const content = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(content);
  } catch (error) {
    const message = `Error reading file ${uri.fsPath}: ${
      error instanceof Error ? error.message : "Unknown error"
    }`;
    log(message, "ERROR");
    throw new Error(message);
  }
}

async function backupFile(uri: vscode.Uri): Promise<vscode.Uri> {
  const timestamp = Date.now();
  const backupUri = Uri.file(`${uri.fsPath}.bak.${timestamp}`);
  try {
    await vscode.workspace.fs.copy(uri, backupUri);
    log(`Created backup: ${backupUri.fsPath}`);
    return backupUri;
  } catch (error) {
    const msg = `Failed to create backup for ${uri.fsPath}: ${
      error instanceof Error ? error.message : "Unknown error"
    }`;
    log(msg, "ERROR");
    throw new Error(msg);
  }
}

async function applyFileChanges(
  uri: vscode.Uri,
  newContent: string,
  config: vscode.WorkspaceConfiguration
): Promise<boolean> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const currentContent = document.getText();
    if (currentContent === newContent) {
      log(`No changes needed for ${uri.fsPath}`);
      return false;
    }

    const autoApply = config.get<boolean>("autoApplyChanges", false);
    if (!autoApply) {
      // Create a temporary file for diff
      const tempDir = tmpdir();
      const tempFile = join(
        tempDir,
        `${basename(uri.fsPath)}.suggested.${Date.now()}`
      );
      const modifiedUri = Uri.file(tempFile);
      await fs.writeFile(tempFile, newContent, "utf8");

      // Show diff
      await vscode.commands.executeCommand(
        "vscode.diff",
        uri,
        modifiedUri,
        `${basename(uri.fsPath)}: Original vs Suggested`,
        { preview: true }
      );

      const apply = await vscode.window.showInformationMessage(
        `Apply changes to ${basename(uri.fsPath)}?`,
        "Apply",
        "Cancel"
      );
      await fs.unlink(tempFile).catch(() => {}); // Clean up
      if (apply !== "Apply") {
        return false;
      }
    }

    await backupFile(uri);
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(currentContent.length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, newContent);
    await vscode.workspace.applyEdit(edit);
    await document.save();

    log(`Applied changes to ${uri.fsPath}`);
    showStatusMessage(`Changes applied to ${basename(uri.fsPath)}`, config);
    return true;
  } catch (error) {
    const msg = `Failed to apply changes to ${uri.fsPath}: ${
      error instanceof Error ? error.message : "Unknown error"
    }`;
    log(msg, "ERROR");
    vscode.window.showErrorMessage(msg);
    return false;
  }
}

async function getLLMResponse(
  prompt: string,
  config: vscode.WorkspaceConfiguration,
  chatHistory: ChatMessage[] = []
): Promise<string> {
  try {
    const baseUrl = config.get<string>(
      "flowiseUrl",
      "http://localhost:3000/api/v1/prediction"
    );
    const apiToken = config.get<string>("apiToken", "");
    if (!apiToken) {
      throw new Error("Flowise API token (flow ID) is required");
    }
    const url = `${baseUrl}/${apiToken}`;
    log(`Sending LLM request to: ${url}`, "DEBUG");

    const conversation =
      chatHistory
        .map(
          (msg) =>
            `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`
        )
        .join("\n") + `\nUser: ${prompt}`;

    const response = await axios.post<LLMResponse>(
      url,
      { question: conversation },
      {
        headers: { "Content-Type": "application/json" },
        timeout: config.get<number>("apiTimeout", 30000),
      }
    );

    const sanitized = sanitizeHtml(response.data.text || "", {
      allowedTags: [],
      allowedAttributes: {},
    });
    log(`LLM response received: ${sanitized.slice(0, 100)}...`, "DEBUG");
    return sanitized || "No response received from LLM";
  } catch (error) {
    const message = `Failed to fetch LLM response: ${
      error instanceof AxiosError
        ? `API Error: ${error.response?.statusText || error.message}`
        : error instanceof Error
        ? error.message
        : "Unknown error"
    }`;
    log(message, "ERROR");
    throw new Error(message);
  }
}

async function reviewFile(
  uri: vscode.Uri,
  config: vscode.WorkspaceConfiguration
): Promise<FileReview> {
  try {
    const content = await readFileContent(uri, config);
    const prompt = `
Review the following code from ${vscode.workspace.asRelativePath(uri)}:
\`\`\`
${content}
\`\`\`

Provide a detailed review in markdown format, including:
1. Code quality assessment
2. Potential bugs or issues
3. Performance improvements
4. Security concerns
5. Suggested changes (if any, in a \`\`\` code block)

Ensure the review is concise and actionable.
`;
    const review = await getLLMResponse(prompt, config);
    let suggestedChanges: string | undefined;
    const changeMatch = review.match(/```[\s\S]*?```/);
    if (changeMatch) {
      suggestedChanges = changeMatch[0].replace(/```/g, "").trim();
    }
    return { uri, content, review, suggestedChanges };
  } catch (error) {
    const msg = `Failed to review file ${uri.fsPath}: ${
      error instanceof Error ? error.message : "Unknown error"
    }`;
    log(msg, "ERROR");
    throw new Error(msg);
  }
}

async function* findFiles(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  config: vscode.WorkspaceConfiguration
): AsyncGenerator<vscode.Uri> {
  const maxFiles = config.get<number>("maxFiles", 1000);
  let fileCount = 0;

  for (const folder of workspaceFolders) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(folder.uri);
      for (const [name, type] of entries) {
        if (fileCount >= maxFiles) {
          log(`Reached maximum file limit of ${maxFiles}`, "INFO");
          return;
        }
        const filePath = join(folder.uri.fsPath, name);
        const uri = Uri.file(filePath);
        if (type === vscode.FileType.File && shouldIncludeFile(uri, config)) {
          fileCount++;
          yield uri;
        } else if (type === vscode.FileType.Directory) {
          yield* findFiles([{ uri } as vscode.WorkspaceFolder], config);
        }
      }
    } catch (error) {
      log(
        `Error reading directory ${folder.uri.fsPath}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        "ERROR"
      );
    }
  }
}

async function processFilesConcurrently<T>(
  uris: vscode.Uri[],
  processor: (
    uri: vscode.Uri,
    config: vscode.WorkspaceConfiguration
  ) => Promise<T>,
  config: vscode.WorkspaceConfiguration
): Promise<T[]> {
  const batchSize = config.get<number>("reviewBatchSize", 5);
  const results: T[] = [];
  const queue = [...uris];
  const workers: Promise<void>[] = [];

  const runWorker = async () => {
    while (queue.length > 0) {
      const uri = queue.shift()!;
      try {
        const result = await processor(uri, config);
        results.push(result);
      } catch (error) {
        log(
          `Error processing ${uri.fsPath}: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
          "ERROR"
        );
      }
    }
  };

  for (let i = 0; i < Math.min(batchSize, uris.length); i++) {
    workers.push(runWorker());
  }

  await Promise.all(workers);
  return results;
}

// Webview Utilities
function getChatWebviewHtml(config: vscode.WorkspaceConfiguration): string {
  const title = config.get<string>("webviewTitle", "LLMCoder Chat");
  const placeholder = config.get<string>(
    "inputPlaceholder",
    "Ask the LLM something, type 'review project', or 'review file'..."
  );
  const autoScroll = config.get<boolean>("autoScroll", true);
  const useVsCodeTheme = config.get<boolean>("useVsCodeTheme", true);

  // Get VSCode theme colors
  const themeStyles = useVsCodeTheme
    ? `
      --background: ${vscode.workspace
        .getConfiguration("")
        .get("workbench.colorCustomizations.editor.background", "#1e1e1e")};
      --foreground: ${vscode.workspace
        .getConfiguration("")
        .get("workbench.colorCustomizations.editor.foreground", "#d4d4d4")};
      --input-bg: ${vscode.workspace
        .getConfiguration("")
        .get("workbench.colorCustomizations.input.background", "#3c3c3c")};
      --button-bg: ${vscode.workspace
        .getConfiguration("")
        .get("workbench.colorCustomizations.button.background", "#007acc")};
      --button-hover: ${vscode.workspace
        .getConfiguration("")
        .get(
          "workbench.colorCustomizations.button.hoverBackground",
          "#005f99"
        )};
    `
    : `
      --background: #1e1e1e;
      --foreground: #d4d4d4;
      --input-bg: #3c3c3c;
      --button-bg: #007acc;
      --button-hover: #005f99;
    `;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>${sanitizeHtml(title)}</title>
  <style>
    :root {
      ${themeStyles}
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 1rem;
      background-color: var(--background);
      color: var(--foreground);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    #chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      background-color: var(--input-bg);
      border-radius: 6px;
      margin-bottom: 1rem;
    }
    .message {
      margin: 0.5rem 0;
      padding: 0.75rem;
      border-radius: 4px;
      max-width: 80%;
      word-wrap: break-word;
    }
    .user {
      background-color: var(--button-bg);
      margin-left: auto;
    }
    .assistant {
      background-color: var(--input-bg);
      filter: brightness(1.2);
    }
    #input-container {
      display: flex;
      gap: 0.5rem;
    }
    #message-input {
      flex: 1;
      padding: 0.5rem;
      border: none;
      border-radius: 4px;
      background-color: var(--input-bg);
      color: var(--foreground);
      font-size: 1rem;
    }
    #send-button {
      padding: 0.5rem 1rem;
      background-color: var(--button-bg);
      color: var(--foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    #send-button:hover {
      background-color: var(--button-hover);
    }
  </style>
</head>
<body>
  <h2>🗨️ ${sanitizeHtml(title)}</h2>
  <div id="chat-container"></div>
  <div id="input-container">
    <input id="message-input" type="text" placeholder="${sanitizeHtml(
      placeholder
    )}">
    <button id="send-button">Send</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');

    function addMessage(text, isUser) {
      const div = document.createElement('div');
      div.className = \`message \${isUser ? 'user' : 'assistant'}\`;
      div.textContent = text;
      chatContainer.appendChild(div);
      ${
        autoScroll
          ? "chatContainer.scrollTop = chatContainer.scrollHeight;"
          : ""
      }
    }

    sendButton.addEventListener('click', () => {
      const text = messageInput.value.trim();
      if (text) {
        addMessage(text, true);
        vscode.postMessage({ command: 'sendMessage', text });
        messageInput.value = '';
      }
    });

    messageInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendButton.click();
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.command === 'receiveMessage') {
        addMessage(message.text, false);
      }
    });
  </script>
</body>
</html>
`;
}

function getReviewWebviewHtml(content: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>LLMCoderAgent Review</title>
  <style>
    body {
      font-family: monospace;
      padding: 1rem;
      background-color: #1e1e1e;
      color: #d4d4d4;
      line-height: 1.5;
    }
    pre {
      background-color: #252526;
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      white-space: pre-wrap;
    }
    h2 {
      color: #007acc;
    }
  </style>
</head>
<body>
  <h2>🔍 LLMCoderAgent Review Summary</h2>
  <pre>${sanitizeHtml(content, {
    allowedTags: ["b", "i", "code", "pre"],
    allowedAttributes: {},
  })}</pre>
</body>
</html>
`;
}

// Extension Activation
export function activate(context: vscode.ExtensionContext) {
  log("LLMCoderAgent activated ✅");
  let config = vscode.workspace.getConfiguration("llmcoderagent");
  let chatHistory: ChatMessage[] = [];

  // Validate configuration
  if (!config.get("flowiseUrl") || !config.get("apiToken")) {
    vscode.window.showErrorMessage(
      'LLMCoderAgent: Please configure "llmcoderagent.flowiseUrl" and "llmcoderagent.apiToken" in settings.'
    );
    return;
  }

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("llmcoderagent")) {
        config = vscode.workspace.getConfiguration("llmcoderagent");
        log("Configuration updated");
      }
    })
  );

  // Open Chat Command
  const openChatCommand = vscode.commands.registerCommand(
    "llmcoderagent.openChat",
    async () => {
      log("Executing llmcoderagent.openChat");
      const panel = vscode.window.createWebviewPanel(
        "llmcoderagentChat",
        config.get<string>("webviewTitle", "LLMCoder Chat"),
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      panel.webview.html = getChatWebviewHtml(config);

      panel.webview.onDidReceiveMessage(
        async (message) => {
          if (message.command === "sendMessage") {
            try {
              const userMessage = message.text;
              // Handle special commands
              if (userMessage.toLowerCase() === "review project") {
                await vscode.commands.executeCommand(
                  "llmcoderagent.reviewProject"
                );
                panel.webview.postMessage({
                  command: "receiveMessage",
                  text: "Initiated project review.",
                });
                return;
              }
              if (userMessage.toLowerCase() === "review file") {
                await vscode.commands.executeCommand(
                  "llmcoderagent.reviewFile"
                );
                panel.webview.postMessage({
                  command: "receiveMessage",
                  text: "Initiated file review.",
                });
                return;
              }
              const response = await getLLMResponse(
                userMessage,
                config,
                chatHistory
              );
              chatHistory.push({
                role: "user",
                content: userMessage,
                timestamp: Date.now(),
              });
              chatHistory.push({
                role: "assistant",
                content: response,
                timestamp: Date.now(),
              });
              const historyLimit = config.get<number>(
                "messageHistoryLimit",
                100
              );
              if (chatHistory.length > historyLimit) {
                chatHistory = chatHistory.slice(-historyLimit);
              }
              panel.webview.postMessage({
                command: "receiveMessage",
                text: response,
              });
            } catch (error) {
              const msg = `Chat failed: ${
                error instanceof Error ? error.message : String(error)
              }`;
              log(msg, "ERROR");
              panel.webview.postMessage({
                command: "receiveMessage",
                text: msg,
              });
            }
          }
        },
        undefined,
        context.subscriptions
      );

      panel.onDidDispose(() => {
        chatHistory = [];
        log("Chat panel disposed, history reset.");
      });
    }
  );

  // Review Project Command
  const reviewProjectCommand = vscode.commands.registerCommand(
    "llmcoderagent.reviewProject",
    async () => {
      log("Executing llmcoderagent.reviewProject");
      const panel = vscode.window.createWebviewPanel(
        "llmcoderagent",
        "Project Review",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      panel.webview.html = getReviewWebviewHtml("Review running...");

      try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          throw new Error("No workspace folders open");
        }

        const fileUris: vscode.Uri[] = [];
        for await (const uri of findFiles(workspaceFolders, config)) {
          fileUris.push(uri);
        }

        if (fileUris.length === 0) {
          panel.webview.html = getReviewWebviewHtml(
            "No files found matching include/exclude patterns."
          );
          showStatusMessage("No files found for review.", config);
          return;
        }

        const progressOptions: vscode.ProgressOptions = {
          location: vscode.ProgressLocation.Notification,
          title: "LLMCoderAgent: Reviewing Project",
          cancellable: true,
        };

        await vscode.window.withProgress(
          progressOptions,
          async (progress, token) => {
            progress.report({
              message: `Found ${fileUris.length} files to review`,
            });
            const reviews = await processFilesConcurrently(
              fileUris,
              reviewFile,
              config
            );

            if (token.isCancellationRequested) {
              panel.webview.html = getReviewWebviewHtml(
                "Project review cancelled."
              );
              return;
            }

            const summary = reviews
              .map(
                (review: FileReview) => `
**${vscode.workspace.asRelativePath(review.uri)}**:
${review.review}
${
  review.suggestedChanges
    ? `\n**Suggested Changes**:\n\`\`\`\n${review.suggestedChanges}\n\`\`\`\n`
    : ""
}`
              )
              .join("\n\n---\n\n");

            panel.webview.html = getReviewWebviewHtml(summary);
            showStatusMessage(`Reviewed ${reviews.length} files.`, config);

            // Apply changes if autoApplyChanges is enabled
            if (config.get<boolean>("autoApplyChanges", false)) {
              for (const review of reviews) {
                if (review.suggestedChanges) {
                  await applyFileChanges(
                    review.uri,
                    review.suggestedChanges,
                    config
                  );
                }
              }
            }
          }
        );
      } catch (error) {
        const msg = `Review Project failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        log(msg, "ERROR");
        panel.webview.html = getReviewWebviewHtml(
          `Error: ${sanitizeHtml(msg)}`
        );
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  // Review File Command
  const reviewFileCommand = vscode.commands.registerCommand(
    "llmcoderagent.reviewFile",
    async () => {
      log("Executing llmcoderagent.reviewFile");
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active file to review.");
        return;
      }

      const uri = editor.document.uri;
      const panel = vscode.window.createWebviewPanel(
        "llmcoderagent",
        "File Review",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      panel.webview.html = getReviewWebviewHtml("Reviewing file...");

      try {
        const review = await reviewFile(uri, config);
        let content = `**${vscode.workspace.asRelativePath(review.uri)}**:\n${
          review.review
        }`;
        if (review.suggestedChanges) {
          content += `\n\n**Suggested Changes**:\n\`\`\`\n${review.suggestedChanges}\n\`\`\``;
          if (await applyFileChanges(uri, review.suggestedChanges, config)) {
            content += `\n\n**Status**: Changes applied successfully.`;
          }
        }
        panel.webview.html = getReviewWebviewHtml(content);
        showStatusMessage(`Reviewed ${basename(uri.fsPath)}.`, config);
      } catch (error) {
        const msg = `Review File failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        log(msg, "ERROR");
        panel.webview.html = getReviewWebviewHtml(
          `Error: ${sanitizeHtml(msg)}`
        );
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  context.subscriptions.push(
    openChatCommand,
    reviewProjectCommand,
    reviewFileCommand
  );
}

export function deactivate() {
  log("LLMCoderAgent deactivated");
  OUTPUT_CHANNEL.dispose();
}
