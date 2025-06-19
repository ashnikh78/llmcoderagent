import * as vscode from 'vscode';
import axios, { AxiosError } from 'axios';
import { basename, extname } from 'path';
import { Uri } from 'vscode';
import sanitizeHtml from 'sanitize-html';
import { minimatch } from 'minimatch';

const outputChannel = vscode.window.createOutputChannel('LLMCoderAgent');

interface FileReview {
  uri: vscode.Uri;
  content: string;
  review: string;
  suggestedChanges?: string;
}

function shouldIncludeFile(uri: vscode.Uri, config: vscode.WorkspaceConfiguration): boolean {
  try {
    const includePatterns = config.get<string[]>('includePatterns', ['**/*']);
    const excludePatterns = config.get<string[]>('excludePatterns', [
      '**/node_modules/**',
      '**/.git/**',
      '**/*.log',
      '**/*.lock'
    ]);
    const relativePath = vscode.workspace.asRelativePath(uri);
    const included = includePatterns.some(pattern => minimatch(relativePath, pattern));
    const excluded = excludePatterns.some(pattern => minimatch(relativePath, pattern));
    return included && !excluded;
  } catch (error) {
    outputChannel.appendLine(`Error filtering file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }
}

async function readFileContent(uri: vscode.Uri): Promise<string> {
  try {
    const content = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(content);
  } catch (error) {
    const message = `Error reading file ${uri.fsPath}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    outputChannel.appendLine(message);
    return message;
  }
}

async function backupFile(uri: vscode.Uri): Promise<vscode.Uri> {
  const backupUri = Uri.file(`${uri.fsPath}.bak.${Date.now()}`);
  try {
    await vscode.workspace.fs.copy(uri, backupUri);
    outputChannel.appendLine(`Created backup: ${backupUri.fsPath}`);
    return backupUri;
  } catch (error) {
    const msg = `Failed to create backup: ${error instanceof Error ? error.message : 'Unknown error'}`;
    outputChannel.appendLine(msg);
    throw new Error(msg);
  }
}

async function applyFileChanges(uri: vscode.Uri, newContent: string): Promise<boolean> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const currentContent = document.getText();
    if (currentContent === newContent) return false;

    const original = uri;
    const modified = vscode.Uri.parse(`untitled:${uri.fsPath}.suggested`);
    await vscode.workspace.fs.writeFile(modified, new TextEncoder().encode(newContent));

    await vscode.commands.executeCommand('vscode.diff', original, modified, `${basename(uri.fsPath)}: Original vs Suggested`);

    const apply = await vscode.window.showInformationMessage(`Apply changes to ${basename(uri.fsPath)}?`, 'Apply', 'Cancel');
    if (apply !== 'Apply') return false;

    await backupFile(uri);
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(currentContent.length));
    const finalEdit = new vscode.WorkspaceEdit();
    finalEdit.replace(uri, fullRange, newContent);
    await vscode.workspace.applyEdit(finalEdit);
    await document.save();

    outputChannel.appendLine(`Applied changes to ${uri.fsPath}`);
    return true;
  } catch (error) {
    const msg = `Failed to apply changes to ${uri.fsPath}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    outputChannel.appendLine(msg);
    vscode.window.showErrorMessage(msg);
    return false;
  }
}

async function getLLMResponse(prompt: string, config: vscode.WorkspaceConfiguration, chatHistory: { role: string; content: string }[] = []): Promise<string> {
  try {
    const baseUrl = config.get<string>('flowiseUrl', 'http://localhost:3000/api/v1/prediction');
    const apiToken = config.get<string>('apiToken', '');
    if (!apiToken) {
      throw new Error('Flowise API token (flow ID) is required');
    }
    const url = `${baseUrl}/${apiToken}`;
    outputChannel.appendLine(`Sending LLM request to: ${url}`);

    // Combine chat history and current prompt into a single question
    const conversation = chatHistory
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n') + `\nUser: ${prompt}`;

    const response = await axios.post<{ text: string }>(
      url,
      {
        question: conversation
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: config.get('apiTimeout', 30000)
      }
    );

    const sanitized = sanitizeHtml(response.data.text, {
      allowedTags: [],
      allowedAttributes: {}
    });
    outputChannel.appendLine(`LLM response received: ${sanitized.slice(0, 100)}...`);
    return sanitized || 'No response received from LLM';
  } catch (error) {
    const message = `Failed to fetch LLM response: ${error instanceof Error ? error.message : 'Unknown error'}`;
    outputChannel.appendLine(message);
    throw new Error(message);
  }
}

async function reviewFile(uri: vscode.Uri, config: vscode.WorkspaceConfiguration): Promise<FileReview> {
  const content = await readFileContent(uri);
  const maxFileSize = config.get<number>('maxFileSize', 100000);

  if (content.startsWith('Error reading file')) {
    return { uri, content, review: content };
  }

  if (content.length > maxFileSize) {
    return {
      uri,
      content,
      review: `File too large to review (size: ${content.length} bytes, max: ${maxFileSize} bytes)`
    };
  }

  const prompt = `Review the following file content and suggest improvements:

**File**: ${basename(uri.fsPath)}
**Content**:
\`\`\`${extname(uri.fsPath).slice(1)}
${content}
\`\`\`

Provide a review and, if applicable, include a "Suggested changes:" section with the full modified content.`;

  try {
    const review = await getLLMResponse(prompt, config);
    const suggestedChangesMatch = review.match(/Suggested changes:\n([\s\S]*)/);
    return {
      uri,
      content,
      review,
      suggestedChanges: suggestedChangesMatch ? suggestedChangesMatch[1].trim() : undefined
    };
  } catch (error) {
    return {
      uri,
      content,
      review: `Error reviewing file: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

async function reviewProject(panel: vscode.WebviewPanel, config: vscode.WorkspaceConfiguration): Promise<string> {
  if (!vscode.workspace.workspaceFolders) {
    const msg = 'No workspace folder open. Please open a project to review.';
    panel.webview.html = getWebviewHtml(msg);
    return msg;
  }

  const maxFiles = config.get<number>('maxFiles', 1000);
  const batchSize = config.get<number>('reviewBatchSize', 5);
  const reviews: FileReview[] = [];

  return await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Reviewing Project Files',
    cancellable: true
  }, async (progress, token) => {
    try {
      const files = await vscode.workspace.findFiles(
        '**/*',
        `{${config.get<string[]>('excludePatterns', ['**/node_modules/**', '**/.git/**', '**/*.log', '**/*.lock']).join(',')}}`
      );
      outputChannel.appendLine(`Found ${files.length} files: ${files.map(f => vscode.workspace.asRelativePath(f)).join(', ')}`);

      if (files.length > maxFiles) {
        const msg = `Too many files (${files.length}). Max allowed: ${maxFiles}. Adjust settings.`;
        panel.webview.html = getWebviewHtml(msg);
        return msg;
      }

      let processedFiles = 0;
      const totalFiles = files.length;
      progress.report({ message: `Found ${totalFiles} files` });

      for (let i = 0; i < files.length && !token.isCancellationRequested; i += batchSize) {
        const batch = files.slice(i, i + batchSize).filter(uri => shouldIncludeFile(uri, config));
        const batchReviews = await Promise.all(batch.map(uri => reviewFile(uri, config)));
        reviews.push(...batchReviews);
        processedFiles += batch.length;
        progress.report({ message: `Processed ${processedFiles}/${totalFiles}`, increment: (batch.length / totalFiles) * 100 });
      }

      if (token.isCancellationRequested) {
        const msg = 'Project review cancelled.';
        panel.webview.html = getWebviewHtml(msg);
        return msg;
      }

      let summary = `Project Review Completed\n\nReviewed ${reviews.length} files:\n`;
      for (const review of reviews) {
        summary += `\n**${vscode.workspace.asRelativePath(review.uri)}**:\n${review.review}\n`;
        if (review.suggestedChanges) {
          const applied = await applyFileChanges(review.uri, review.suggestedChanges);
          if (applied) summary += `Changes applied to ${vscode.workspace.asRelativePath(review.uri)}\n`;
        }
      }

      outputChannel.appendLine(`Project review completed.`);
      panel.webview.html = getWebviewHtml(summary);
      return summary;
    } catch (error) {
      const msg = `Project review failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      outputChannel.appendLine(msg);
      handleError(error, panel);
      return msg;
    }
  });
}

function handleError(error: unknown, panel: vscode.WebviewPanel) {
  const message = error instanceof AxiosError ? `API Error: ${error.response?.statusText || error.message}` : error instanceof Error ? error.message : 'Unexpected error';
  vscode.window.showErrorMessage(message);
  panel.webview.postMessage({
    type: 'response',
    text: `Error: ${sanitizeHtml(message, { allowedTags: [], allowedAttributes: {} })}`
  });
}

function getWebviewHtml(content: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>body{font-family:'Segoe UI',sans-serif;padding:1rem;background-color:#1e1e1e;color:#d4d4d4;}pre{background-color:#252526;padding:1rem;border-radius:6px;overflow-x:auto;}</style></head><body><h2>🔍 LLMCoderAgent Review Summary</h2><pre>${sanitizeHtml(content)}</pre></body></html>`;
}

function getChatWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>LLMCoder Chat</title>
  <style>
    body {
      font-family: 'Segoe UI', sans-serif;
      padding: 1rem;
      background-color: #1e1e1e;
      color: #d4d4d4;
      margin: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    #chat-container {
      flex: 1;
      overflow-y: auto;
      background-color: #252526;
      padding: 1rem;
      border-radius: 6px;
      margin-bottom: 1rem;
    }
    .message {
      margin-bottom: 1rem;
      padding: 0.5rem;
      border-radius: 4px;
    }
    .user {
      background-color: #007acc;
      align-self: flex-end;
      margin-left: 20%;
    }
    .assistant {
      background-color: #3c3c3c;
      margin-right: 20%;
    }
    #input-container {
      display: flex;
      gap: 0.5rem;
    }
    #message-input {
      flex: 1;
      padding: 0.5rem;
      background-color: #252526;
      color: #d4d4d4;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      resize: none;
    }
    #send-button {
      padding: 0.5rem 1rem;
      background-color: #007acc;
      color: #fff;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    #send-button:hover {
      background-color: #005f99;
    }
  </style>
</head>
<body>
  <div id="chat-container"></div>
  <div id="input-container">
    <textarea id="message-input" rows="2" placeholder="Type your message..."></textarea>
    <button id="send-button">Send</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');

    function addMessage(content, isUser) {
      const messageDiv = document.createElement('div');
      messageDiv.className = 'message ' + (isUser ? 'user' : 'assistant');
      messageDiv.textContent = content;
      chatContainer.appendChild(messageDiv);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    sendButton.addEventListener('click', () => {
      const message = messageInput.value.trim();
      if (message) {
        addMessage(message, true);
        vscode.postMessage({ command: 'sendMessage', text: message });
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
</html>`;
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel.appendLine('LLMCoderAgent activated ✅');
  const config = vscode.workspace.getConfiguration('llmcoderagent');
  if (!config.get('flowiseUrl') || !config.get('apiToken')) {
    vscode.window.showErrorMessage('LLMCoderAgent: Please configure "llmcoderagent.flowiseUrl" and "llmcoderagent.apiToken" in settings.');
    return;
  }

  // Maintain chat history for conversational context
  let chatHistory: { role: string; content: string }[] = [];

  // Command: Open Interactive Chat
  const openChatCommand = vscode.commands.registerCommand('llmcoderagent.openChat', async () => {
    outputChannel.appendLine('Executing llmcoderagent.openChat');
    try {
      const panel = vscode.window.createWebviewPanel(
        'llmcoderagentChat',
        'LLMCoder Chat',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      panel.webview.html = getChatWebviewHtml();

      // Handle messages from the webview
      panel.webview.onDidReceiveMessage(
        async (message) => {
          if (message.command === 'sendMessage') {
            try {
              const userMessage = message.text;
              const response = await getLLMResponse(userMessage, config, chatHistory);
              chatHistory.push({ role: 'user', content: userMessage });
              chatHistory.push({ role: 'assistant', content: response });
              // Limit history to prevent excessive context
              if (chatHistory.length > 20) {
                chatHistory = chatHistory.slice(-20);
              }
              panel.webview.postMessage({ command: 'receiveMessage', text: response });
            } catch (error) {
              const msg = `Chat failed: ${error instanceof Error ? error.message : String(error)}`;
              outputChannel.appendLine(msg);
              panel.webview.postMessage({ command: 'receiveMessage', text: msg });
            }
          }
        },
        undefined,
        context.subscriptions
      );

      // Reset chat history when the panel is closed
      panel.onDidDispose(() => {
        chatHistory = [];
        outputChannel.appendLine('Chat panel disposed, history reset.');
      }, undefined, context.subscriptions);
    } catch (error) {
      const msg = `Open Chat failed: ${error instanceof Error ? error.message : String(error)}`;
      outputChannel.appendLine(msg);
      vscode.window.showErrorMessage(msg);
    }
  });

  // Command: Review Entire Project
  const reviewProjectCommand = vscode.commands.registerCommand('llmcoderagent.reviewProject', async () => {
    outputChannel.appendLine('Executing llmcoderagent.reviewProject');
    try {
      const panel = vscode.window.createWebviewPanel('llmcoderagent', 'Project Review', vscode.ViewColumn.Beside, { enableScripts: true });
      const summary = await reviewProject(panel, config);
      panel.webview.html = getWebviewHtml(summary);
    } catch (error) {
      const msg = `Review Project failed: ${error instanceof Error ? error.message : String(error)}`;
      outputChannel.appendLine(msg);
      vscode.window.showErrorMessage(msg);
    }
  });

  // Command: Review Only the Active File
  const reviewFileCommand = vscode.commands.registerCommand('llmcoderagent.reviewFile', async () => {
    outputChannel.appendLine('Executing llmcoderagent.reviewFile');
    try {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active file to review.');
        return;
      }
      const uri = editor.document.uri;
      const review = await reviewFile(uri, config);
      const panel = vscode.window.createWebviewPanel('llmcoderagent', 'File Review', vscode.ViewColumn.Beside, { enableScripts: true });
      panel.webview.html = getWebviewHtml(`**${vscode.workspace.asRelativePath(review.uri)}**:\n${review.review}`);
    } catch (error) {
      const msg = `Review File failed: ${error instanceof Error ? error.message : String(error)}`;
      outputChannel.appendLine(msg);
      vscode.window.showErrorMessage(msg);
    }
  });

  context.subscriptions.push(openChatCommand, reviewProjectCommand, reviewFileCommand);
}

export function deactivate() {
  outputChannel.appendLine('LLMCoderAgent deactivated');
  outputChannel.dispose();
}