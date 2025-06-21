import * as vscode from "vscode";
import axios, { AxiosError } from "axios";
import { basename, join } from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import sanitizeHtml from "sanitize-html";
import { minimatch } from "minimatch";

// Constants
const OUTPUT_CHANNEL = vscode.window.createOutputChannel("LLMCoderAgent", "log");
const DIAGNOSTIC_COLLECTION = vscode.languages.createDiagnosticCollection("LLMCoderAgent");

// Interfaces
interface FileReview {
    uri: vscode.Uri;
    content: string;
    review: string;
    suggestedChanges?: string;
    issues?: Array<{ line: number; message: string; severity: string }>;
    relatedFiles?: string[];
}

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
    timestamp: number;
}

interface ReviewMetrics {
    filesProcessed: number;
    timeTaken: number;
    errors: number;
}

interface Issue {
    line: number;
    message: string;
    severity: string;
}

interface Config {
    llmProvider: string;
    flowiseUrl: string;
    flowiseToken?: string;
    openaiModel: string;
    ollamaModel: string;
    apiTimeout: number;
    apiMaxRetries: number;
    apiRetryDelay: number;
    maxFiles: number;
    reviewBatchSize: number;
    maxFileSize: number;
    autoApplyChanges: boolean;
    statusBarTimeout: number;
    includePatterns: string[];
    excludePatterns: string[];
    reviewPrompt: string;
    explainPrompt: string;
    generatePrompt: string;
    webviewTitle: string;
    inputPlaceholder: string;
    autoScroll: boolean;
    useVsCodeTheme: boolean;
    messageHistoryLimit: number;
    realTimeDiagnostics: boolean;
    realTimeDebounceMs: number;
}

interface LLMProvider {
    getName(): string;
    getResponse(prompt: string, history: ChatMessage[]): Promise<string>;
    testConnection(): Promise<boolean>;
}

// LLM Providers
class FlowiseProvider implements LLMProvider {
    private url: string;
    private token: string;
    private config: Config;

    constructor(url: string, token: string, config: Config) {
        this.url = url;
        this.token = this.validateToken(token);
        this.config = config;
    }

    getName(): string {
        return "Flowise";
    }

    async getResponse(prompt: string, history: ChatMessage[]): Promise<string> {
        if (!this.token) throw this.handleError("Flowise API token is invalid or missing");
        const conversation = [...history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`), `User: ${prompt}`].join("\n");
        try {
            const response = await axios.post(`${this.url}/${this.token}`, { question: conversation }, {
                headers: { "Content-Type": "application/json" },
                timeout: this.config.apiTimeout,
            });
            return response.data?.text || response.data?.response || JSON.stringify(response.data) || "";
        } catch (error) {
            const err = error as AxiosError;
            if (err.response?.status === 401) {
                throw this.handleError("Invalid Flowise API token. Please update your token in settings.");
            } else if (err.code === "ECONNREFUSED") {
                throw this.handleError(`Flowise server unreachable at ${this.url}. Check the URL and server status.`);
            }
            throw this.handleError(`Flowise API error: ${err.message}`);
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            const response = await axios.post(`${this.url}/${this.token}`, { question: "Ping" }, {
                headers: { "Content-Type": "application/json" },
                timeout: this.config.apiTimeout,
            });
            return response.status === 200;
        } catch {
            return false;
        }
    }

    private validateToken(token: string): string {
        if (!token || token.length < 10) {
            throw this.handleError("Flowise API token must be at least 10 characters long.");
        }
        return token;
    }

    private handleError(msg: string): Error {
        log(msg, "ERROR");
        return new Error(msg);
    }
}

class OpenAIProvider implements LLMProvider {
    private apiKey: string;
    private model: string;
    private config: Config;

    constructor(apiKey: string, model: string, config: Config) {
        this.apiKey = this.validateApiKey(apiKey);
        this.model = model;
        this.config = config;
    }

    getName(): string {
        return "OpenAI";
    }

    async getResponse(prompt: string, history: ChatMessage[]): Promise<string> {
        const messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: prompt }];
        try {
            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: this.model,
                messages: messages,
            }, {
                headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
                timeout: this.config.apiTimeout,
            });
            return response.data.choices[0].message.content || "";
        } catch (error) {
            const err = error as AxiosError;
            if (err.response?.status === 401) {
                throw this.handleError("Invalid OpenAI API key. Please update your key in settings.");
            }
            throw this.handleError(`OpenAI API error: ${err.message}`);
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: this.model,
                messages: [{ role: "user", content: "Ping" }],
            }, {
                headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
                timeout: this.config.apiTimeout,
            });
            return response.status === 200;
        } catch {
            return false;
        }
    }

    private validateApiKey(apiKey: string): string {
        if (!apiKey || !apiKey.startsWith("sk-")) {
            throw this.handleError("OpenAI API key must start with 'sk-' and be non-empty.");
        }
        return apiKey;
    }

    private handleError(msg: string): Error {
        log(msg, "ERROR");
        return new Error(msg);
    }
}

class OllamaProvider implements LLMProvider {
    private readonly config: Config;

    constructor(config: Config) {
        this.config = config;
    }

    getName(): string {
        return "Ollama";
    }

    async getResponse(prompt: string, history: ChatMessage[]): Promise<string> {
        const conversation = [...history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`), `User: ${prompt}`].join("\n");
        const url = 'http://localhost:11434/api/generate';
        const payload = {
            model: this.config.ollamaModel,
            prompt: conversation,
            stream: false,
        };
        try {
            const response = await axios.post(url, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: this.config.apiTimeout,
            });
            return response.data.response || '';
        } catch (error) {
            throw this.handleError(`Ollama API error: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            const response = await axios.get('http://localhost:11434/api/tags', {
                timeout: this.config.apiTimeout,
            });
            return response.status === 200;
        } catch {
            return false;
        }
    }

    private handleError(msg: string): Error {
        log(msg, "ERROR");
        return new Error(msg);
    }
}

// Utility Functions
const log = (message: string, level: "INFO" | "ERROR" | "DEBUG" = "INFO"): void =>
    OUTPUT_CHANNEL.appendLine(`[${new Date().toISOString()}] [${level}] ${message}`);

const handleError = (msg: string, showMsg = true): Error => {
    log(msg, "ERROR");
    if (showMsg) vscode.window.showErrorMessage(msg);
    return new Error(msg);
};

const getConfig = (): Config => {
    const cfg = vscode.workspace.getConfiguration("llmcoderagent");
    return {
        llmProvider: cfg.get<string>("llmProvider", "ollama"),
        flowiseUrl: cfg.get<string>("flowiseUrl", "http://localhost:3000/api/v1/prediction"),
        flowiseToken: cfg.get<string>("flowiseToken"),
        openaiModel: cfg.get<string>("openaiModel", "gpt-3.5-turbo"),
        ollamaModel: cfg.get<string>("ollamaModel", "deepseek-coder:6.7b-base"),
        apiTimeout: cfg.get<number>("apiTimeout", 30000),
        apiMaxRetries: cfg.get<number>("apiMaxRetries", 3),
        apiRetryDelay: cfg.get<number>("apiRetryDelay", 1000),
        maxFiles: cfg.get<number>("maxFiles", 1000),
        reviewBatchSize: cfg.get<number>("reviewBatchSize", 5),
        maxFileSize: cfg.get<number>("maxFileSize", 100000),
        autoApplyChanges: cfg.get<boolean>("autoApplyChanges", false),
        statusBarTimeout: cfg.get<number>("statusBarTimeout", 2000),
        includePatterns: cfg.get<string[]>("includePatterns", ["**/*.{ts,js,py,md}"]),
        excludePatterns: cfg.get<string[]>("excludePatterns", [
            "**/node_modules/**",
            "**/.git/**",
            "**/dist/**",
            "**/build/**",
            "**/*.log",
            "**/*.lock",
            "**/*.bak.*",
        ]),
        reviewPrompt: cfg.get<string>("reviewPrompt", ""),
        explainPrompt: cfg.get<string>("explainPrompt", ""),
        generatePrompt: cfg.get<string>("generatePrompt", ""),
        webviewTitle: cfg.get<string>("webviewTitle", "LLMCoder Chat"),
        inputPlaceholder: cfg.get<string>("inputPlaceholder", "Ask the LLM something, type 'review project', 'review file', or 'help'..."),
        autoScroll: cfg.get<boolean>("autoScroll", true),
        useVsCodeTheme: cfg.get<boolean>("useVsCodeTheme", true),
        messageHistoryLimit: cfg.get<number>("messageHistoryLimit", 100),
        realTimeDiagnostics: cfg.get<boolean>("realTimeDiagnostics", false),
        realTimeDebounceMs: cfg.get<number>("realTimeDebounceMs", 500),
    };
};

const shouldIncludeFile = (uri: vscode.Uri, config: Config): boolean => {
    const relativePath = vscode.workspace.asRelativePath(uri);
    return (
        config.includePatterns.some((pattern) => minimatch(relativePath, pattern)) &&
        !config.excludePatterns.some((pattern) => minimatch(relativePath, pattern))
    );
};

const readFileContent = async (uri: vscode.Uri, config: Config, cache?: Map<string, string>): Promise<string> => {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > config.maxFileSize) {
            throw handleError(`File size (${stat.size} bytes) exceeds limit of ${config.maxFileSize}`);
        }
        const cacheKey = uri.fsPath;
        if (cache && cache.has(cacheKey)) {
            return cache.get(cacheKey)!;
        }
        const content = await vscode.workspace.fs.readFile(uri);
        const decoded = new TextDecoder().decode(content);
        cache?.set(cacheKey, decoded);
        return decoded;
    } catch (error) {
        throw handleError(`Failed to read file ${uri.fsPath}: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
};

const backupFile = async (uri: vscode.Uri): Promise<void> => {
    const timestamp = new Date().getTime();
    const backupUri = vscode.Uri.file(`${uri.fsPath}.bak${timestamp}`);
    await vscode.workspace.fs.copy(uri, backupUri);
    log(`Backup created: ${backupUri.fsPath}`);
};

const applyFileContent = async (uri: vscode.Uri, newContent: string, config: Config): Promise<boolean> => {
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.getText() === newContent) {
        log(`No changes needed for ${uri.fsPath}`);
        return false;
    }

    if (!config.autoApplyChanges) {
        const tempFile = join(tmpdir(), `${basename(uri.fsPath)}.suggested.${Date.now()}`);
        const modifiedUri = vscode.Uri.file(tempFile);
        await fs.writeFile(tempFile, newContent, "utf8");

        await vscode.commands.executeCommand("vscode.diff", uri, modifiedUri, `${basename(uri.fsPath)}: Original vs Suggested`, { preview: true });
        const apply = await vscode.window.showInformationMessage(`Apply changes to ${basename(uri.fsPath)}?`, "Apply", "Cancel");
        await fs.unlink(tempFile).catch(() => { });
        if (apply !== "Apply") return false;
    }

    await backupFile(uri);
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(0, 0, document.lineCount || 1, 0);
    edit.replace(uri, fullRange, newContent);
    await vscode.workspace.applyEdit(edit);
    await document.save();
    log(`Applied changes to ${uri.fsPath}`);
    vscode.window.showInformationMessage(`Changes applied to ${basename(uri.fsPath)}`);
    return true;
};

const getLLMResponse = async (prompt: string, config: Config, chatHistory: ChatMessage[] = [], provider: LLMProvider): Promise<string> => {
    for (let attempt = 0; attempt < config.apiMaxRetries; attempt++) {
        try {
            log(`Sending ${provider.getName()} request (Attempt ${attempt + 1})`, "DEBUG");
            const response = await provider.getResponse(prompt, chatHistory);
            const sanitized = sanitizeHtml(response, { allowedTags: ["pre", "code", "b", "i"], allowedAttributes: {} });
            log(`Response received: ${sanitized.slice(0, 100)}...`, "DEBUG");
            return sanitized || "No response received from LLM";
        } catch (error) {
            const message = `Failed to fetch ${provider.getName()} response: ${error instanceof Error ? error.message : "Unknown error"}`;
            log(message, "ERROR");
            if (attempt < config.apiMaxRetries - 1) {
                const delay = config.apiRetryDelay * Math.pow(2, attempt);
                log(`Retrying in ${delay}ms...`, "INFO");
                await new Promise((resolve) => setTimeout(resolve, delay));
            } else {
                const errorMsg = `${message} (All ${config.apiMaxRetries} retries failed)`;
                vscode.window.showErrorMessage(errorMsg, "Check Settings", "Retry").then((selection) => {
                    if (selection === "Check Settings") vscode.commands.executeCommand("workbench.action.openSettings", "llmcoderagent");
                    else if (selection === "Retry") vscode.commands.executeCommand("llmcoderagent.openChat");
                });
                throw handleError(errorMsg, false);
            }
        }
    }
    throw handleError("Unexpected error in getLLMResponse");
};

const getRelatedFiles = async (uri: vscode.Uri, config: Config): Promise<string[]> => {
    const content = await readFileContent(uri, config);
    const importRegex = /(?:import|require)\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
    const relatedFiles: string[] = [];
    let match;
    while ((match = importRegex.exec(content)) !== null) {
        const resolvedPath = join(uri.fsPath, "..", match[1]);
        const resolvedUri = vscode.Uri.file(resolvedPath);
        if (await fileExists(resolvedUri) && shouldIncludeFile(resolvedUri, config)) {
            relatedFiles.push(vscode.workspace.asRelativePath(resolvedUri));
        }
    }
    return relatedFiles;
};

const fileExists = async (uri: vscode.Uri): Promise<boolean> => {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
};

const getGitDiff = async (config: Config): Promise<{ file: string; diff: string }[]> => {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return [];

        const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
        if (!gitExtension) return [];

        const git = gitExtension.getAPI(1);
        const repository = git.getRepository(workspaceFolder.uri);
        if (!repository) return [];

        const changes = await repository.diffWithHEAD();
        return changes
            .filter((change: any) => shouldIncludeFile(change.uri, config))
            .map((change: any) => ({
                file: vscode.workspace.asRelativePath(change.uri),
                diff: change.diff,
            }));
    } catch (error) {
        log(`Error fetching Git diff: ${error instanceof Error ? error.message : "Unknown error"}`, "ERROR");
        return [];
    }
};

const reviewFile = async (uri: vscode.Uri, config: Config, projectContext?: Map<string, string>, provider?: LLMProvider): Promise<FileReview> => {
    if (!provider) throw handleError("No LLM provider configured");
    const content = await readFileContent(uri, config);
    const relatedFiles = await getRelatedFiles(uri, config);
    const relatedContent = await Promise.all(
        relatedFiles.map(async (file) => {
            const fileUri = vscode.Uri.file(join(vscode.workspace.workspaceFolders![0].uri.fsPath, file));
            return `**Related File: ${file}**\n\`\`\`\n${await readFileContent(fileUri, config)}\n\`\`\``;
        })
    );

    const projectContextSummary = projectContext
        ? Array.from(projectContext.entries())
            .filter(([path]) => path !== vscode.workspace.asRelativePath(uri))
            .map(([path, summary]) => `**${path}**: ${summary}`)
            .join("\n")
        : "";

    const defaultReviewPrompt = `You are an expert code reviewer. Review the following code from ${vscode.workspace.asRelativePath(uri)}:\n\`\`\`\n${content}\n\`\`\`\n${relatedContent.join("\n")}\n\n**Project Context**:\n${projectContextSummary || "No additional context available."}\nProvide a detailed review in markdown format with the following sections:\n1. **Code Quality**: Assess readability, maintainability, and adherence to best practices.\n2. **Potential Issues**: Identify bugs or logical errors with specific line numbers.\n3. **Performance**: Suggest optimizations for efficiency.\n4. **Security**: Highlight potential vulnerabilities.\n5. **Suggested Changes**: Provide a code block with recommended changes.\n6. **Issues List**: Summarize issues in a bullet list with line numbers and severity (High/Medium/Low).\nEnsure the review is concise, actionable, and includes specific examples.`;
    const prompt = config.reviewPrompt || defaultReviewPrompt;
    const review = await getLLMResponse(prompt, config, [], provider);

    let suggestedChanges: string | undefined;
    const issues: Array<{ line: number; message: string; severity: string }> = [];
    const changeMatch = review.match(/```[\s\S]*?```/);
    if (changeMatch) suggestedChanges = changeMatch[0].replace(/```/g, "").trim();

    const issueMatches = review.matchAll(/Line (\d+): (\w+ severity) - ([^\n]+)/g);
    for (const match of issueMatches) {
        issues.push({ line: parseInt(match[1]), severity: match[2], message: match[3] });
    }

    const document = await vscode.workspace.openTextDocument(uri);
    DIAGNOSTIC_COLLECTION.set(
        uri,
        issues.map((issue) => {
            const severity = issue.severity.toLowerCase().includes("high")
                ? vscode.DiagnosticSeverity.Error
                : issue.severity.toLowerCase().includes("medium")
                    ? vscode.DiagnosticSeverity.Warning
                    : vscode.DiagnosticSeverity.Information;
            return new vscode.Diagnostic(
                new vscode.Range(issue.line - 1, 0, issue.line - 1, document.lineAt(issue.line - 1).text.length),
                issue.message,
                severity
            );
        })
    );

    return { uri, content, review, suggestedChanges, issues, relatedFiles };
};

async function* findFiles(folders: readonly vscode.WorkspaceFolder[], config: Config): AsyncGenerator<vscode.Uri> {
    let fileCount = 0;
    for (const folder of folders) {
        const stack = [folder.uri];
        while (stack.length && fileCount < config.maxFiles) {
            const dir = stack.pop()!;
            try {
                for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
                    const path = join(dir.fsPath, name);
                    const uri = vscode.Uri.file(path);
                    if (type === vscode.FileType.File && shouldIncludeFile(uri, config)) {
                        if (++fileCount > config.maxFiles) {
                            log(`Reached maximum file limit of ${config.maxFiles}`);
                            return;
                        }
                        yield uri;
                    } else if (type === vscode.FileType.Directory) {
                        stack.push(uri);
                    }
                }
            } catch (error) {
                log(`Error reading directory ${dir.fsPath}: ${error instanceof Error ? error.message : "Unknown error"}`);
            }
        }
    }
}

const processFilesConcurrently = async <T>(
    uris: vscode.Uri[],
    processor: (uri: vscode.Uri, config: Config, context?: Map<string, string>, provider?: LLMProvider) => Promise<T>,
    config: Config,
    panel?: vscode.WebviewPanel,
    projectContext?: Map<string, string>,
    provider?: LLMProvider
): Promise<T[]> => {
    const results: T[] = [];
    const queue = uris.slice();
    let processed = 0;
    let errors = 0;
    const startTime = Date.now();

    await Promise.all(
        Array(Math.min(config.reviewBatchSize, uris.length))
            .fill(0)
            .map(async () => {
                while (queue.length) {
                    const uri = queue.shift()!;
                    try {
                        results.push(await processor(uri, config, projectContext, provider));
                        processed++;
                        if (panel) panel.webview.html = getReviewWebviewHtml(`Reviewing... ${processed}/${uris.length} files processed (${errors} errors)`);
                    } catch (error) {
                        errors++;
                        log(`Error processing ${uri.fsPath}: ${error instanceof Error ? error.message : "Unknown error"}`, "ERROR");
                    }
                }
            })
    );

    return results;
};

// Webview Utilities
const getThemeStyles = (config: Config): string =>
    config.useVsCodeTheme
        ? `
      --background: ${vscode.workspace.getConfiguration("").get("workbench.colorCustomizations.editor.background", "#1e1e1e")};
      --foreground: ${vscode.workspace.getConfiguration("").get("workbench.colorCustomizations.editor.foreground", "#d4d4d4")};
      --input-bg: ${vscode.workspace.getConfiguration("").get("workbench.colorCustomizations.input.background", "#3c3c3c")};
      --button-bg: ${vscode.workspace.getConfiguration("").get("workbench.colorCustomizations.button.background", "#007acc")};
      --button-hover: ${vscode.workspace.getConfiguration("").get("workbench.colorCustomizations.button.hoverBackground", "#005f99")};
    `
        : `
      --background: #1e1e1e;
      --foreground: #d4d4d4;
      --input-bg: #3c3c3c;
      --button-bg: #007acc;
      --button-hover: #005f99;
    `;

const getChatWebviewHtml = (config: Config): string => {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; script-src 'unsafe-inline' https://cdnjs.cloudflare.com;">
  <title>${sanitizeHtml(config.webviewTitle)}</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism.min.css">
  <style>
    :root { ${getThemeStyles(config)} }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 1rem; background-color: var(--background); color: var(--foreground); height: 100vh; display: flex; flex-direction: column; }
    #chat-container { flex: 1; overflow-y: auto; padding: 1rem; background-color: var(--input-bg); border-radius: 6px; margin-bottom: 1rem; }
    .message { margin: 0.5rem 0; padding: 0.75rem; border-radius: 4px; max-width: 80%; word-wrap: break-word; }
    .user { background-color: var(--button-bg); margin-left: auto; }
    .assistant { background-color: var(--input-bg); filter: brightness(1.2); }
    #input-container { display: flex; gap: 0.5rem; align-items: center; }
    #message-input { flex: 1; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; background-color: var(--input-bg); color: var(--foreground); font-size: 1rem; }
    #send-button { padding: 0.5rem 1rem; background-color: var(--button-bg); color: var(--foreground); border: none; border-radius: 4px; cursor: pointer; }
    #send-button:hover { background-color: var(--button-hover); }
    .suggestions { position: absolute; background-color: var(--input-bg); border: 1px solid #foreground; border-radius: 4px; max-height: 150px; overflow-y: auto; width: calc(100% - 80px); z-index: 100; }
    .suggestion-item { padding: 0.5rem; cursor: pointer; }
    .suggestion-item:hover { background-color: var(--button-bg); }
    pre { background-color: #252526; padding: 0.5rem; border-radius: 4px; }
    code { font-family: 'Source Code Pro', monospace; }
  </style>
</head>
<body>
  <h2>🗨️ ${sanitizeHtml(config.webviewTitle)}</h2>
  <p style="color: var(--foreground);">Welcome to LLMCoderAgent! Type commands like 'help', 'review project', 'review file', or 'text' to get started.</p>
  <div id="chat-container"></div>
  <div id="input-container">
    <input id="message-input" type="text" placeholder="${sanitizeHtml(config.inputPlaceholder)}">
    <button id="send-button">Send</button>
    <div id="suggestions" class="suggestions" style="display: none;"></div>
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-python.min.js"></script>
  <script>
    const vscode = acquireVsCodeApi();
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const suggestions = document.getElementById('suggestions');
    const autoScrollEnabled = ${config.autoScroll};
    const commands = [
      'help',
      'review project',
      'review file',
      'refactor file',
      'review selection',
      'explain code',
      'generate code',
      'apply quick fix',
      'toggle realtime',
      'review git diff',
      'configure llm',
      'clear history'
    ];

    function addMessage(text, isUser) {
      const div = document.createElement('div');
      div.className = 'message ' + (isUser ? 'user' : 'assistant');
      const sanitizedText = text.includes('<pre>') ? text : '<pre><code>' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code></pre>';
      div.innerHTML = sanitizedText;
      chatContainer.appendChild(div);
      Prism.highlightAll();
      if (autoScrollEnabled) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }

    function showSuggestions() {
      suggestions.innerHTML = '';
      const input = messageInput.value.trim().toLowerCase();
      const filtered = commands.filter(cmd => cmd.toLowerCase().includes(input));
      if (filtered.length) {
        filtered.forEach((cmd) => {
          const div = document.createElement('div');
          div.className = 'suggestion-item';
          div.textContent = cmd;
          div.onclick = function() {
            messageInput.value = cmd;
            suggestions.style.display = 'none';
          };
          suggestions.appendChild(div);
        });
        suggestions.style.display = 'block';
      } else {
        suggestions.style.display = 'none';
      }
    }

    sendButton.addEventListener('click', function() {
      const text = messageInput.value.trim();
      if (text) {
        addMessage(text, true);
        vscode.postMessage({ command: 'sendMessage', text: text });
        messageInput.value = '';
        suggestions.style.display = 'none';
      }
    });

    messageInput.addEventListener('input', showSuggestions);

    messageInput.addEventListener('keypress', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendButton.click();
      }
    });

    window.addEventListener('message', function(event) {
      const message = event.data;
      if (message.command === 'receiveMessage') {
        addMessage(message.text, false);
      }
    });
  </script>
</body>
</html>
`;
};

const getReviewWebviewHtml = (content: string, metrics?: ReviewMetrics): string => {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; script-src 'unsafe-inline' https://cdnjs.cloudflare.com;">
  <title>LLMCoderAgent Review</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism.min.css">
  <style>
    :root { ${getThemeStyles(getConfig())} }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 1rem; background-color: var(--background); color: var(--foreground); line-height: 1.6; }
    .container { max-width: 1200px; margin: auto; }
    pre { background-color: #252526; padding: 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
    code { font-family: 'Source Code Pro', monospace; }
    h2 { color: #007acc; margin-bottom: 1rem; }
    .button { padding: 0.5rem 1rem; background-color: var(--button-bg); color: var(--foreground); border: none; border-radius: 4px; cursor: pointer; margin-right: 0.5rem; transition: background-color: 0.2s; }
    .button:hover { background-color: var(--button-hover); }
    .metrics { margin-top: 1rem; padding: 1rem; background-color: #252526; border-radius: 6px; }
    .metrics p { margin: 0.5rem 0; }
  </style>
</head>
<body>
  <div class="container">
    <h2>🔍 Code Review</h2>
    <pre><code>${sanitizeHtml(content, { allowedTags: ['pre', 'code', 'b', 'i'], allowedAttributes: {} })}</code></pre>
    ${metrics
            ? `
          <div class="metrics">
            <p><strong>Review Metrics:</strong></p>
            <p>Files Processed: ${metrics.filesProcessed}</p>
            <p>Time Taken: ${(metrics.timeTaken / 1000).toFixed(2)} seconds</p>
            <p>Errors: ${metrics.errors}</p>
          </div>`
            : ""
        }
    <div class="button-container" style="margin-top: 1rem;">
      <button class="button apply-all-btn" onclick="vscode.postMessage({ command: 'applyAll' })">Apply All Changes</button>
      <button class="button jump-to-issues-btn" onclick="vscode.postMessage({ command: 'jumpToIssues' })">Jump to Issues</button>
      <button class="button copy-suggestions-btn" onclick="vscode.postMessage({ command: 'copySuggestions' })">Copy Suggestions</button>
    </div>
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-python.min.js"></script>
  <script>
    const vscode = acquireVsCodeApi();
    Prism.highlightAll();
  </script>
</body>
</html>
`;
};

// Providers
class LLMCoderCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
        const codeLens: vscode.CodeLens[] = [];
        if (!shouldIncludeFile(document.uri, getConfig())) {
            return codeLens;
        }
        const range = new vscode.Range(0, 0, 0, 0);
        codeLens.push(
            new vscode.CodeLens(range, {
                title: "Review with LLMCoder",
                command: "llmcoderagent.reviewFile",
                arguments: [document.uri],
            }),
            new vscode.CodeLens(range, {
                title: "Refactor with LLMCoder",
                command: "llmcoderagent.refactorFile",
                arguments: [document.uri],
            }),
            new vscode.CodeLens(range, {
                title: "Generate Code",
                command: "llmcoderagent.generateCode",
                arguments: [document.uri],
            })
        );
        return codeLens;
    }
}

class LLMCoderCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CodeAction[]> {
        const actions: vscode.CodeAction[] = context.diagnostics
            .filter((d) => d.source === "LLMCoderAgent")
            .map((diagnostic, index) => {
                const action = new vscode.CodeAction(`Fix: ${diagnostic.message}`, vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.command = {
                    title: "Apply LLM Suggested Fix",
                    command: "llmcoderagent.applyQuickFix",
                    arguments: [document.uri, index],
                };
                return action;
            });

        if (!range.isEmpty) {
            const action = new vscode.CodeAction("Review Selection", vscode.CodeActionKind.QuickFix);
            action.command = {
                title: "Review Selection",
                command: "llmcoderagent.reviewSelection",
                arguments: [document.uri, range],
            };
            actions.push(action);
        }

        return actions;
    }
}

// Real-Time Code Access
class RealTimeCodeAccessManager {
    private watcher: vscode.FileSystemWatcher | null = null;
    public isRealTimeEnabled: boolean = false;
    public projectContext: Map<string, string> = new Map();
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private fileCache: Map<string, string> = new Map();
    private config: Config;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext, config: Config) {
        this.context = context;
        this.config = config;
        this.initializeProjectContext();
        this.toggleRealTime(config.realTimeDiagnostics);
    }

    private async initializeProjectContext() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        for await (const uri of findFiles(workspaceFolders, this.config)) {
            try {
                const content = await readFileContent(uri, this.config, this.fileCache);
                this.projectContext.set(vscode.workspace.asRelativePath(uri), content);
            } catch (error) {
                log(`Error initializing context for ${uri.fsPath}: ${error instanceof Error ? error.message : "unknown error"}`);
            }
        }
    }

    public toggleRealTime(enable: boolean) {
        if (this.isRealTimeEnabled === enable) {
            vscode.window.showInformationMessage(`Real-time code access is already ${enable ? "enabled" : "disabled"}`);
            return;
        }

        this.isRealTimeEnabled = enable;
        if (enable) {
            this.watcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,js,py,md}");
            this.watcher.onDidCreate(this.handleFileEvent.bind(this, "create"));
            this.watcher.onDidChange(this.handleFileEvent.bind(this, "change"));
            this.watcher.onDidDelete(this.handleFileDelete.bind(this));
            vscode.window.showInformationMessage("Real-time code access enabled.");
        } else {
            this.watcher?.dispose();
            this.watcher = null;
            this.debounceTimers.forEach((timer) => clearTimeout(timer));
            this.debounceTimers.clear();
            vscode.window.showInformationMessage("Real-time code access disabled.");
        }

        this.context.subscriptions.push({
            dispose: () => this.watcher?.dispose()
        });

        vscode.commands.executeCommand("setContext", "llmcoderagent.realTimeEnabled", enable);
        log(`Real-time code toggled: ${enable ? "enabled" : "disabled"}`);
    }

    public debounce(func: (uri: vscode.Uri) => Promise<void>, uri: vscode.Uri, wait: number) {
        const key = uri.fsPath.toString();
        if (this.debounceTimers.has(key)) {
            clearTimeout(this.debounceTimers.get(key)!);
        }
        this.debounceTimers.set(
            key,
            setTimeout(async () => {
                try {
                    await func(uri);
                    this.debounceTimers.delete(key);
                } catch (error) {
                    log(`Debounce error for ${uri.fsPath}: ${error instanceof Error ? error.message : "unknown"}`, "ERROR");
                }
            }, wait)
        );
    }

    private async handleFileEvent(type: "create" | "change", uri: vscode.Uri): Promise<void> {
        if (!shouldIncludeFile(uri, this.config)) {
            return;
        }

        const stats = await vscode.workspace.fs.stat(uri);
        if (stats.size > this.config.maxFileSize) {
            log(`Skipping ${uri.fsPath}: File size (${stats.size}) exceeds limit (${this.config.maxFileSize})`, "INFO");
            return;
        }

        this.debounce(async (uri: vscode.Uri) => {
            try {
                const content = await readFileContent(uri, this.config, this.fileCache);
                this.projectContext.set(vscode.workspace.asRelativePath(uri), content);

                if (this.config.realTimeDiagnostics) {
                    const provider = await getLLMProvider(this.config, this.context);
                    const review = await reviewFile(uri, this.config, this.projectContext, provider);

                    const severityMap: { [key: string]: vscode.DiagnosticSeverity } = {
                        high: vscode.DiagnosticSeverity.Error,
                        medium: vscode.DiagnosticSeverity.Warning,
                        low: vscode.DiagnosticSeverity.Information,
                        information: vscode.DiagnosticSeverity.Information,
                        default: vscode.DiagnosticSeverity.Information
                    };

                    const diagnostics = await Promise.all((review.issues || []).map(async (issue: Issue) => {
                        const lines = content.split('\n');
                        const lineIndex = Math.max(0, Math.min(issue.line - 1, lines.length - 1));
                        const endColumn = lines[lineIndex]?.length ?? 1000;
                        const severity = severityMap[issue.severity.toLowerCase()] ?? vscode.DiagnosticSeverity.Information;
                        return new vscode.Diagnostic(
                            new vscode.Range(lineIndex, 0, lineIndex, endColumn),
                            issue.message,
                            severity
                        );
                    }));

                    DIAGNOSTIC_COLLECTION.set(uri, diagnostics);
                    vscode.window.showInformationMessage(`Real-time review updated for ${basename(uri.fsPath)}.`);
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                log(`Error handling ${type} for ${uri.fsPath}: ${errorMessage}`, "ERROR");
                vscode.window.showErrorMessage(`Failed to review ${basename(uri.fsPath)}: ${errorMessage}`);
            }
        }, uri, this.config.realTimeDebounceMs);
    }

    private handleFileDelete(uri: vscode.Uri): void {
        if (!shouldIncludeFile(uri, this.config)) {
            return;
        }

        const relativePath = vscode.workspace.asRelativePath(uri);
        this.projectContext.delete(relativePath);
        this.fileCache.delete(uri.fsPath);
        DIAGNOSTIC_COLLECTION.delete(uri);
        log(`Removed context for deleted file: ${uri.fsPath}`, "INFO");
    }

    public dispose(): void {
        this.watcher?.dispose();
        this.debounceTimers.forEach((timer) => clearTimeout(timer));
        this.debounceTimers.clear();
        this.projectContext.clear();
        this.fileCache.clear();
    }
}

async function getLLMProvider(config: Config, context: vscode.ExtensionContext, maxRetries: number = 2): Promise<LLMProvider> {
    const secrets = context.secrets;
    let attempts = 0;

    while (attempts < maxRetries) {
        try {
            if (config.llmProvider === "openai") {
                let apiKey = await secrets.get("openaiApiKey");
                if (!apiKey) {
                    apiKey = await vscode.window.showInputBox({
                        prompt: "Enter OpenAI API Key (starts with 'sk-')",
                        password: true,
                        placeHolder: "sk-XXXXXXXXXXXXXXXXXXXX",
                    });
                    if (!apiKey) {
                        throw handleError("OpenAI API key required", false);
                    }
                    await secrets.store("openaiApiKey", apiKey);
                }
                const provider = new OpenAIProvider(apiKey, config.openaiModel, config);
                if (await provider.testConnection()) {
                    return provider;
                }
                throw handleError("OpenAI connection test failed");
            } else if (config.llmProvider === "ollama") {
                const provider = new OllamaProvider(config);
                if (await provider.testConnection()) {
                    return provider;
                }
                throw handleError("Ollama connection test failed. Ensure Ollama server is running at http://localhost:11434.");
            } else {
                let apiToken = await secrets.get("flowiseApiToken");
                if (!apiToken) {
                    apiToken = await vscode.window.showInputBox({
                        prompt: "Enter Flowise API Token (minimum 10 characters)",
                        password: true,
                        placeHolder: "Enter your Flowise token",
                    });
                    if (!apiToken) {
                        throw handleError("Flowise API token required", false);
                    }
                    await secrets.store("flowiseApiToken", apiToken);
                }
                const provider = new FlowiseProvider(config.flowiseUrl, apiToken, config);
                if (await provider.testConnection()) {
                    return provider;
                }
                throw handleError("Flowise connection test failed");
            }
        } catch (error) {
            attempts++;
            const errorMsg = error instanceof Error ? error.message : "Unknown error";
            log(`LLM provider setup failed (attempt ${attempts}/${maxRetries}): ${errorMsg}`, "ERROR");

            if (attempts >= maxRetries) {
                const action = await vscode.window.showWarningMessage(
                    `Failed to configure ${config.llmProvider} provider: ${errorMsg}`,
                    "Switch Provider",
                    "Open Settings",
                    "Retry"
                );
                if (action === "Switch Provider") {
                    const provider = await vscode.window.showQuickPick(["flowise", "openai", "ollama"], { placeHolder: "Select an LLM provider" });
                    if (provider) {
                        await vscode.workspace.getConfiguration("llmcoderagent").update("llmProvider", provider, vscode.ConfigurationTarget.Global);
                        config.llmProvider = provider;
                        attempts = 0;
                        continue;
                    }
                } else if (action === "Open Settings") {
                    await vscode.commands.executeCommand("workbench.action.openSettings", "llmcoderagent");
                } else if (action === "Retry") {
                    continue;
                }
                throw handleError(`Cannot proceed without a valid LLM provider. Configure in settings.`, true);
            }
        }
    }
    throw handleError("Unexpected error in getLLMProvider");
}

// Extension Activation
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    log("LLMCoderAgent activating...");
    let config = getConfig();
    let chatHistory: ChatMessage[] = [];
    let realTimeManager: RealTimeCodeAccessManager | null = null;

    try {
        const provider = await getLLMProvider(config, context);
        realTimeManager = new RealTimeCodeAccessManager(context, config);

        const subscriptions = [
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration("llmcoderagent")) {
                    config = getConfig();
                    realTimeManager?.toggleRealTime(config.realTimeDiagnostics);
                    log("Configuration updated");
                }
            }),
            vscode.workspace.onDidChangeTextDocument(async (e) => {
                if (!config.realTimeDiagnostics || !shouldIncludeFile(e.document.uri, config)) return;
                realTimeManager?.debounce(async (uri) => {
                    try {
                        const provider = await getLLMProvider(config, context);
                        const review = await reviewFile(uri, config, realTimeManager?.projectContext, provider);
                        const document = await vscode.workspace.openTextDocument(uri);
                        const diagnostics = await Promise.all(
                            (review.issues || []).map(async (issue) => {
                                const severity = issue.severity.toLowerCase().includes("high")
                                    ? vscode.DiagnosticSeverity.Error
                                    : issue.severity.toLowerCase().includes("medium")
                                        ? vscode.DiagnosticSeverity.Warning
                                        : vscode.DiagnosticSeverity.Information;
                                return new vscode.Diagnostic(
                                    new vscode.Range(issue.line - 1, 0, issue.line - 1, document.lineAt(issue.line - 1).text.length),
                                    issue.message,
                                    severity
                                );
                            })
                        );
                        DIAGNOSTIC_COLLECTION.set(uri, diagnostics);
                    } catch (error) {
                        log(`Error updating diagnostics: ${error instanceof Error ? error.message : "Unknown error"}`, "ERROR");
                    }
                }, e.document.uri, config.realTimeDebounceMs);
            }),
            vscode.languages.registerCodeLensProvider({ scheme: "file" }, new LLMCoderCodeLensProvider()),
            vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new LLMCoderCodeActionProvider()),
            vscode.commands.registerCommand("llmcoderagent.applyQuickFix", async (uri: vscode.Uri, diagnosticIndex: number) => {
                try {
                    const provider = await getLLMProvider(config, context);
                    const review = await reviewFile(uri, config, realTimeManager?.projectContext, provider);
                    if (review.suggestedChanges) await applyFileContent(uri, review.suggestedChanges, config);
                } catch (error) {
                    handleError(`Quick fix failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }),
            vscode.commands.registerCommand("llmcoderagent.refactorFile", async (uri: vscode.Uri) => {
                try {
                    const provider = await getLLMProvider(config, context);
                    const review = await reviewFile(uri, config, realTimeManager?.projectContext, provider);
                    if (review.suggestedChanges) {
                        await applyFileContent(uri, review.suggestedChanges, config);
                        vscode.window.showInformationMessage(`Refactored ${basename(uri.fsPath)}`);
                    } else {
                        vscode.window.showInformationMessage(`No refactoring suggestions for ${basename(uri.fsPath)}`);
                    }
                } catch (error) {
                    handleError(`Refactor failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }),
            vscode.commands.registerCommand("llmcoderagent.reviewSelection", async (uri: vscode.Uri, range: vscode.Range) => {
                try {
                    const provider = await getLLMProvider(config, context);
                    const document = await vscode.workspace.openTextDocument(uri);
                    const selection = document.getText(range);
                    const prompt = `Review the following code selection from ${vscode.workspace.asRelativePath(uri)} (lines ${range.start.line + 1}-${range.end.line + 1}):\n\`\`\`\n${selection}\n\`\`\`\nProvide a concise review in markdown format, including suggestions for improvement.`;
                    const review = await getLLMResponse(prompt, config, chatHistory, provider);
                    const panel = vscode.window.createWebviewPanel("llmcoderagent", "Selection Review", vscode.ViewColumn.Beside, { enableScripts: true });
                    panel.webview.html = getReviewWebviewHtml(review);
                } catch (error) {
                    handleError(`Selection review failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }),
            vscode.commands.registerCommand("llmcoderagent.explainCode", async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage("No active editor.");
                    return;
                }
                try {
                    const provider = await getLLMProvider(config, context);
                    const selection = editor.document.getText(editor.selection) || editor.document.getText();
                    const defaultExplainPrompt = config.explainPrompt || `Explain the following code from ${vscode.workspace.asRelativePath(editor.document.uri)}:\n\`\`\`\n${selection}\n\`\`\`\nProvide a clear and concise explanation in markdown format.`;
                    const explanation = await getLLMResponse(defaultExplainPrompt, config, chatHistory, provider);
                    const panel = vscode.window.createWebviewPanel("llmcoderagent", "Code Explanation", vscode.ViewColumn.Beside, { enableScripts: true });
                    panel.webview.html = getReviewWebviewHtml(explanation);
                } catch (error) {
                    handleError(`Code explanation failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }),
            vscode.commands.registerCommand("llmcoderagent.toggleRealTime", async () => {
                log("Executing toggleRealTime");
                realTimeManager?.toggleRealTime(!realTimeManager.isRealTimeEnabled);
            }),
            vscode.commands.registerCommand("llmcoderagent.generateCode", async (uri?: vscode.Uri) => {
                try {
                    const provider = await getLLMProvider(config, context);
                    const input = await vscode.window.showInputBox({ prompt: "Describe the code to generate (e.g., 'Create a TypeScript function to sort an array')", placeHolder: "Type your code description here..." });
                    if (!input) return;

                    const defaultGeneratePrompt = config.generatePrompt || `Generate code based on the following description:\n${input}\n\nProvide the code in markdown format with a \`\`\` code block. Include comments for clarity.`;
                    const generatedCode = await getLLMResponse(defaultGeneratePrompt, config, chatHistory, provider);
                    const codeMatch = generatedCode.match(/```[\s\S]*?```/);
                    const code = codeMatch ? codeMatch[0].replace(/```/g, '').trim() : generatedCode;

                    const options = ["Insert into Current File", "Create New File", "Copy to Clipboard"];
                    const choice = await vscode.window.showQuickPick(options, { placeHolder: "Choose where to place the generated code" });
                    if (!choice) return;

                    if (choice === "Insert into Current File" && uri) {
                        const editor = await vscode.window.showTextDocument(uri);
                        const edit = new vscode.WorkspaceEdit();
                        edit.insert(uri, editor.selection.active, `\n${code}\n`);
                        await vscode.workspace.applyEdit(edit);
                        vscode.window.showInformationMessage("Code inserted into current file.");
                    } else if (choice === "Create New File") {
                        const fileName = await vscode.window.showInputBox({ prompt: "Enter filename (e.g., newfile.ts)", placeHolder: "newfile.ts" });
                        if (fileName) {
                            const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri;
                            if (workspaceFolder) {
                                const newUri = vscode.Uri.joinPath(workspaceFolder, fileName);
                                await vscode.workspace.fs.writeFile(newUri, new TextEncoder().encode(code));
                                await vscode.window.showTextDocument(newUri);
                                vscode.window.showInformationMessage(`Created and opened ${fileName}`);
                            }
                        }
                    } else if (choice === "Copy to Clipboard") {
                        await vscode.env.clipboard.writeText(code);
                        vscode.window.showInformationMessage("Code copied to clipboard.");
                    }
                } catch (error) {
                    handleError(`Code generation failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }),
            vscode.commands.registerCommand("llmcoderagent.reviewGitDiff", async () => {
                try {
                    const provider = await getLLMProvider(config, context);
                    const diffs = await getGitDiff(config);
                    if (!diffs.length) {
                        vscode.window.showInformationMessage("No Git changes found for review.");
                        return;
                    }

                    const panel = vscode.window.createWebviewPanel("llmcoderagent", "Git Diff Review", vscode.ViewColumn.Beside, { enableScripts: true });
                    panel.webview.html = getReviewWebviewHtml("Reviewing diff...");
                    const reviews: string[] = [];
                    for (const diff of diffs) {
                        const prompt = `Review the following Git diff from ${diff.file}:\n\`\`\`diff\n${diff.diff}\n\`\`\`\nProvide a concise review in markdown format, highlighting potential issues and suggestions for improvement.`;
                        const review = await getLLMResponse(prompt, config, [], provider);
                        reviews.push(`**${diff.file}**:\n${review}\n`);
                    }

                    const summary = reviews.join("\n\n---\n\n");
                    panel.webview.html = getReviewWebviewHtml(summary);
                    vscode.window.showInformationMessage(`Reviewed ${diffs.length} changed files.`);

                    panel.webview.onDidReceiveMessage(async (message) => {
                        if (message.command === "copySuggestions") {
                            await vscode.env.clipboard.writeText(summary);
                            vscode.window.showInformationMessage("Copied review summary to clipboard");
                        } else {
                            handleError(`Webview action unsupported: ${message.command}`);
                        }
                    });
                } catch (error) {
                    handleError(`Git diff review failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }),
            vscode.commands.registerCommand("llmcoderagent.configureLLM", async () => {
                try {
                    const secrets = context.secrets;
                    const providerChoice = await vscode.window.showQuickPick(["flowise", "openai", "ollama"], {
                        placeHolder: "Select an LLM provider to configure",
                    });
                    if (!providerChoice) return;

                    await vscode.workspace.getConfiguration("llmcoderagent").update("llmProvider", providerChoice, vscode.ConfigurationTarget.Global);
                    config.llmProvider = providerChoice;

                    if (providerChoice === "flowise") {
                        const url = await vscode.window.showInputBox({
                            prompt: "Enter Flowise API URL",
                            placeHolder: config.flowiseUrl,
                            value: config.flowiseUrl,
                        });
                        if (url) {
                            await vscode.workspace.getConfiguration("llmcoderagent").update("flowiseUrl", url, vscode.ConfigurationTarget.Global);
                            config.flowiseUrl = url;
                        }
                        await secrets.delete("flowiseApiToken");
                        const token = await vscode.window.showInputBox({
                            prompt: "Enter Flowise API Token (minimum 10 characters)",
                            password: true,
                        });
                        if (token) {
                            await secrets.store("flowiseApiToken", token);
                            vscode.window.showInformationMessage("Flowise configuration updated. Testing connection...");
                            const provider = new FlowiseProvider(config.flowiseUrl, token, config);
                            if (await provider.testConnection()) {
                                vscode.window.showInformationMessage("Flowise configuration successful!");
                            } else {
                                throw handleError("Flowise connection test failed");
                            }
                        }
                    } else if (providerChoice === "openai") {
                        await secrets.delete("openaiApiKey");
                        const apiKey = await vscode.window.showInputBox({
                            prompt: "Enter OpenAI API Key (starts with 'sk-')",
                            password: true,
                        });
                        if (apiKey) {
                            await secrets.store("openaiApiKey", apiKey);
                            vscode.window.showInformationMessage("OpenAI configuration updated. Testing connection...");
                            const provider = new OpenAIProvider(apiKey, config.openaiModel, config);
                            if (await provider.testConnection()) {
                                vscode.window.showInformationMessage("OpenAI configuration successful!");
                            } else {
                                throw handleError("OpenAI connection test failed");
                            }
                        }
                    } else if (providerChoice === "ollama") {
                        const model = await vscode.window.showInputBox({
                            prompt: "Enter Ollama model name (e.g., deepseek-coder:6.7b-base)",
                            placeHolder: config.ollamaModel,
                            value: config.ollamaModel,
                        });
                        if (model) {
                            await vscode.workspace.getConfiguration("llmcoderagent").update("ollamaModel", model, vscode.ConfigurationTarget.Global);
                            config.ollamaModel = model;
                            vscode.window.showInformationMessage("Ollama configuration updated. Testing connection...");
                            const provider = new OllamaProvider(config);
                            if (await provider.testConnection()) {
                                vscode.window.showInformationMessage("Ollama configuration successful!");
                            } else {
                                throw handleError("Ollama connection test failed. Ensure Ollama server is running.");
                            }
                        }
                    }
                } catch (error) {
                    handleError(`LLM configuration failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }),
            vscode.commands.registerCommand("llmcoderagent.openChat", async () => {
                log("Executing openChat");
                const panel = vscode.window.createWebviewPanel("llmcoderagentChat", config.webviewTitle, vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
                panel.webview.html = getChatWebviewHtml(config);

                panel.webview.onDidReceiveMessage(async (message) => {
                    if (message.command !== "sendMessage") return;
                    const userMessage = message.text.trim().toLowerCase();
                    try {
                        const commands: Record<string, string | null> = {
                            "help": null,
                            "review project": "llmcoderagent.reviewProject",
                            "review file": null,
                            "refactor file": "llmcoderagent.refactorFile",
                            "review selection": "llmcoderagent.reviewSelection",
                            "explain code": "llmcoderagent.explainCode",
                            "apply quick fix": "llmcoderagent.applyQuickFix",
                            "generate code": "llmcoderagent.generateCode",
                            "toggle realtime": "llmcoderagent.toggleRealTime",
                            "review git diff": "llmcoderagent.reviewGitDiff",
                            "configure llm": "llmcoderagent.configureLLM",
                            "clear history": null
                        };

                        const validCommands = Object.keys(commands);

                        if (userMessage in commands) {
                            if (userMessage === "help") {
                                const helpText = `Available commands:\n${validCommands.map(cmd => `- ${cmd}`).join('\n')}\n\n**Tips**:\n- Use 'configure llm' to set up Flowise, OpenAI, or Ollama.\n- Open settings with Ctrl+, and search 'llmcoderagent' to adjust provider, URL, or other options.`;
                                panel.webview.postMessage({ command: "receiveMessage", text: helpText });
                            } else if (userMessage === "clear history") {
                                chatHistory = [];
                                panel.webview.postMessage({ command: "receiveMessage", text: "Chat history cleared." });
                            } else if (userMessage === "review file") {
                                let targetUri = vscode.window.activeTextEditor?.document.uri;
                                if (!targetUri) {
                                    const files = await vscode.window.showOpenDialog({
                                        canSelectMany: false,
                                        filters: { 'Code Files': ['ts', 'js', 'py', 'md'] }
                                    });
                                    if (!files || !files.length) {
                                        panel.webview.postMessage({ command: "receiveMessage", text: "No file selected for review." });
                                        return;
                                    }
                                    targetUri = files[0];
                                }
                                if (!shouldIncludeFile(targetUri, config)) {
                                    panel.webview.postMessage({ command: "receiveMessage", text: `File ${basename(targetUri.fsPath)} is excluded by include/exclude patterns.` });
                                    return;
                                }
                                panel.webview.postMessage({ command: "receiveMessage", text: `Reviewing: ${basename(targetUri.fsPath)}` });
                                const provider = await getLLMProvider(config, context);
                                const review = await reviewFile(targetUri, config, realTimeManager?.projectContext, provider);
                                let content = `
**${vscode.workspace.asRelativePath(review.uri)}**:\n${review.review}\n
${review.suggestedChanges ? `**Suggested Changes**:\n\`\`\`\n${review.suggestedChanges}\n\`\`\`\n` : ""}
${review.relatedFiles?.length ? `**Related Files**:\n${review.relatedFiles.join(", ")}\n` : ""}
                                `;
                                if (review.suggestedChanges && await applyFileContent(targetUri, review.suggestedChanges, config)) {
                                    content += `\n**Status**: Changes applied successfully.\n`;
                                }
                                panel.webview.postMessage({ command: "receiveMessage", text: content });
                            } else {
                                await vscode.commands.executeCommand(commands[userMessage]!);
                                panel.webview.postMessage({ command: "receiveMessage", text: `Initiated ${userMessage}` });
                            }
                            return;
                        }

                        const similarCommands = validCommands.filter(cmd => cmd.toLowerCase().includes(userMessage));
                        if (similarCommands.length > 0) {
                            const suggestionText = `Command "${userMessage}" not found. Did you mean:\n${similarCommands.map(cmd => `- ${cmd}`).join('\n')}`;
                            panel.webview.postMessage({ command: "receiveMessage", text: suggestionText });
                            return;
                        }

                        const editor = vscode.window.activeTextEditor;
                        let prompt = message.text;
                        if (editor) {
                            const content = editor.document.getText();
                            prompt = `User query: ${message.text}\n\nContext (file: ${basename(editor.document.uri.fsPath)}):\n\`\`\`\n${content}\n\`\`\`\nProvide a relevant response, including code examples if applicable.`;
                        }
                        const provider = await getLLMProvider(config, context);
                        const response = await getLLMResponse(prompt, config, chatHistory, provider);
                        chatHistory.push(
                            { role: "user", content: message.text, timestamp: Date.now() },
                            { role: "assistant", content: response, timestamp: Date.now() }
                        );
                        if (chatHistory.length > config.messageHistoryLimit) {
                            chatHistory = chatHistory.slice(-config.messageHistoryLimit);
                        }
                        panel.webview.postMessage({ command: "receiveMessage", text: response });
                    } catch (error) {
                        const msg = `Chat failed: ${error instanceof Error ? error.message : "Unknown error"}`;
                        log(msg, "ERROR");
                        panel.webview.postMessage({ command: "receiveMessage", text: msg });
                    }
                });

                panel.onDidDispose(() => {
                    chatHistory = [];
                    log("Chat panel disposed, history reset");
                });
            }),
            vscode.commands.registerCommand("llmcoderagent.reviewFile", async (uri?: vscode.Uri) => {
                log("Executing reviewFile");
                let targetUri = uri || vscode.window.activeTextEditor?.document.uri;
                if (!targetUri) {
                    const files = await vscode.window.showOpenDialog({
                        canSelectMany: false,
                        filters: { 'Code Files': ['ts', 'js', 'py', 'md'] }
                    });
                    if (!files || !files.length) {
                        vscode.window.showErrorMessage("No file selected for review.");
                        return;
                    }
                    targetUri = files[0];
                }

                if (!shouldIncludeFile(targetUri, config)) {
                    vscode.window.showErrorMessage(`File ${basename(targetUri.fsPath)} is excluded by include/exclude patterns.`);
                    return;
                }

                try {
                    const provider = await getLLMProvider(config, context);
                    const review = await reviewFile(targetUri, config, realTimeManager?.projectContext, provider);
                    const panel = vscode.window.createWebviewPanel("llmcoderagent", `Review: ${basename(targetUri.fsPath)}`, vscode.ViewColumn.Beside, { enableScripts: true });
                    let content = `
**${vscode.workspace.asRelativePath(review.uri)}**:\n${review.review}\n
${review.suggestedChanges ? `**Suggested Changes**:\n\`\`\`\n${review.suggestedChanges}\n\`\`\`\n` : ""}
${review.relatedFiles?.length ? `**Related Files**:\n${review.relatedFiles.join(", ")}\n` : ""}
                    `;
                    if (review.suggestedChanges && await applyFileContent(targetUri, review.suggestedChanges, config)) {
                        content += `\n**Status**: Changes applied successfully.\n`;
                    }
                    panel.webview.html = getReviewWebviewHtml(content);

                    panel.webview.onDidReceiveMessage(async (message) => {
                        try {
                            if (message.command === "applyAll") {
                                if (review.suggestedChanges) {
                                    await applyFileContent(review.uri, review.suggestedChanges, config);
                                    panel.webview.html = getReviewWebviewHtml(`${content}\n**Status**: Changes applied successfully.`);
                                }
                            } else if (message.command === "jumpToIssues") {
                                if (review.issues?.length) {
                                    const editor = await vscode.window.showTextDocument(review.uri);
                                    editor.revealRange(new vscode.Range(review.issues[0].line - 1, 0, review.issues[0].line - 1, 0));
                                }
                            } else if (message.command === "copySuggestions") {
                                const suggestions = review.suggestedChanges || "No suggestions available.";
                                await vscode.env.clipboard.writeText(suggestions);
                                vscode.window.showInformationMessage("Copied suggestions to clipboard.");
                            }
                        } catch (error) {
                            handleError(`Webview action failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                        }
                    });

                    vscode.window.showInformationMessage(`Reviewed ${basename(targetUri.fsPath)}`);
                } catch (error) {
                    handleError(`File review failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }),
            vscode.commands.registerCommand("llmcoderagent.reviewProject", async () => {
                log("Executing reviewProject");
                const panel = vscode.window.createWebviewPanel("llmcoderagent", "Project Review", vscode.ViewColumn.Beside, { enableScripts: true });
                panel.webview.html = getReviewWebviewHtml("Reviewing project...");
                try {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        throw handleError("No workspace folders open");
                    }

                    const fileUris: vscode.Uri[] = [];
                    for await (const uri of findFiles(workspaceFolders, config)) {
                        fileUris.push(uri);
                    }

                    if (!fileUris.length) {
                        panel.webview.html = getReviewWebviewHtml("No files found matching include/exclude patterns for review.");
                        vscode.window.showInformationMessage("No files found for review.");
                        return;
                    }

                    let reviews: FileReview[] = [];
                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: "LLMCoderAgent: Reviewing Project", cancellable: true },
                        async (progress, token) => {
                            progress.report({ message: `Found ${fileUris.length} files to review` });
                            const startTime = Date.now();
                            const provider = await getLLMProvider(config, context);
                            reviews = await processFilesConcurrently(fileUris, reviewFile, config, panel, realTimeManager?.projectContext, provider);

                            if (token.isCancellationRequested) {
                                panel.webview.html = getReviewWebviewHtml("Project review canceled.");
                                return;
                            }

                            const summary = reviews
                                .map((review) => `
**${vscode.workspace.asRelativePath(review.uri)}**:\n${review.review}\n
${review.suggestedChanges ? `**Suggested Changes**:\n\`\`\`\n${review.suggestedChanges}\n\`\`\`\n` : ""}
${review.relatedFiles?.length ? `**Related Files**:\n${review.relatedFiles.join(", ")}\n` : ""}
                                `)
                                .join("\n\n---\n\n");

                            const metrics: ReviewMetrics = {
                                filesProcessed: reviews.length,
                                timeTaken: Date.now() - startTime,
                                errors: fileUris.length - reviews.length,
                            };
                            panel.webview.html = getReviewWebviewHtml(summary, metrics);
                            vscode.window.showInformationMessage(`Reviewed ${reviews.length} files.`);
                        }
                    );

                    panel.webview.onDidReceiveMessage(async (message) => {
                        try {
                            if (message.command === "applyAll") {
                                for (const review of reviews) {
                                    if (review.suggestedChanges) {
                                        await applyFileContent(review.uri, review.suggestedChanges, config);
                                    }
                                }
                                vscode.window.showInformationMessage("Applied all suggested changes.");
                            } else if (message.command === "jumpToIssues") {
                                for (const review of reviews) {
                                    if (review.issues?.length) {
                                        const editor = await vscode.window.showTextDocument(review.uri);
                                        editor.revealRange(new vscode.Range(review.issues[0].line - 1, 0, review.issues[0].line - 1, 0));
                                        break;
                                    }
                                }
                            } else if (message.command === "copySuggestions") {
                                const suggestions = reviews
                                    .filter((r) => r.suggestedChanges)
                                    .map((r) => `File: ${vscode.workspace.asRelativePath(r.uri)}\n${r.suggestedChanges}\n`)
                                    .join("\n\n");
                                await vscode.env.clipboard.writeText(suggestions);
                                vscode.window.showInformationMessage("Copied suggestions to clipboard.");
                            }
                        } catch (error) {
                            handleError(`Webview action failed: ${error instanceof Error ? error.message : "Unknown error"}`);
                        }
                    });
                } catch (error) {
                    const msg = `Project review failed: ${error instanceof Error ? error.message : String(error)}`;
                    panel.webview.html = getReviewWebviewHtml(`Error: ${sanitizeHtml(msg)}`);
                    handleError(msg);
                }
            }),
        ];

        context.subscriptions.push(...subscriptions);
        log("LLMCoderAgent activated successfully");
    } catch (error) {
        handleError(`Activation failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}

export function deactivate(): void {
    log("LLMCoderAgent deactivating...");
    DIAGNOSTIC_COLLECTION.clear();
    OUTPUT_CHANNEL.dispose();
    log("LLMCoderAgent deactivated");
}