// --- VSCode Extension: LLMCoderAgent ---

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
    const doc = await vscode.workspace.openTextDocument(modified);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(modified, new vscode.Position(0, 0), newContent);
    await vscode.workspace.applyEdit(edit);

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

async function getLLMResponse(prompt: string, config: vscode.WorkspaceConfiguration): Promise<string> {
  try {
    const response = await axios.post<{ text: string }>(
      config.get('flowiseUrl', ''),
      { question: prompt },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(config.get('apiToken') ? { Authorization: `Bearer ${config.get('apiToken')}` } : {})
        },
        timeout: config.get('apiTimeout', 30000)
      }
    );

    const sanitized = sanitizeHtml(response.data.text, {
      allowedTags: [],
      allowedAttributes: {}
    });
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
    return 'No workspace folder open. Please open a project to review.';
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
        `{${config.get<string[]>('excludePatterns', ['**/node_modules/**', '**/.git/**']).join(',')}}`
      );

      if (files.length > maxFiles) {
        return `Too many files (${files.length}). Max allowed: ${maxFiles}. Adjust settings.`;
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
        return 'Project review cancelled.';
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

export function activate(context: vscode.ExtensionContext) {
  outputChannel.appendLine('LLMCoderAgent activated ✅');

  // Command: Open Chat / Full Project Review
  const openChatCommand = vscode.commands.registerCommand('llmcoderagent.openChat', async () => {
    try {
      const panel = vscode.window.createWebviewPanel('llmcoderagent', 'LLMCoder Chat', vscode.ViewColumn.Beside, { enableScripts: true });
      const config = vscode.workspace.getConfiguration('llmcoderagent');
      const summary = await reviewProject(panel, config);
      panel.webview.html = getWebviewHtml(summary);
    } catch (error) {
      const msg = `Activation failed: ${error instanceof Error ? error.message : String(error)}`;
      outputChannel.appendLine(msg);
      vscode.window.showErrorMessage(msg);
    }
  });

  // Command: Review Entire Project (Duplicate of openChat, but separate command ID)
  const reviewProjectCommand = vscode.commands.registerCommand('llmcoderagent.reviewProject', async () => {
    const panel = vscode.window.createWebviewPanel('llmcoderagent', 'Project Review', vscode.ViewColumn.Beside, { enableScripts: true });
    const config = vscode.workspace.getConfiguration('llmcoderagent');
    const summary = await reviewProject(panel, config);
    panel.webview.html = getWebviewHtml(summary);
  });

  // Command: Review Only the Active File
  const reviewFileCommand = vscode.commands.registerCommand('llmcoderagent.reviewFile', async () => {
    const config = vscode.workspace.getConfiguration('llmcoderagent');
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active file to review.');
      return;
    }

    const uri = editor.document.uri;
    const review = await reviewFile(uri, config);

    const panel = vscode.window.createWebviewPanel('llmcoderagent', 'File Review', vscode.ViewColumn.Beside, { enableScripts: true });
    panel.webview.html = getWebviewHtml(`**${vscode.workspace.asRelativePath(review.uri)}**:\n${review.review}`);
  });

  // Register all commands
  context.subscriptions.push(openChatCommand, reviewProjectCommand, reviewFileCommand);
}


export function deactivate() {
  outputChannel.appendLine('LLMCoderAgent deactivated');
  outputChannel.dispose();
}
