import * as vscode from 'vscode';
import axios, { AxiosError } from 'axios';
import { basename, extname } from 'path';
import { Uri } from 'vscode';
import sanitizeHtml from 'sanitize-html';
import { minimatch } from 'minimatch';




const outputChannel = vscode.window.createOutputChannel('LLMCoderAgent');

interface WebviewMessage {
  command: string;
  text: string;
  fileUri?: string;
}

interface ChatMessage {
  text: string;
  from: 'user' | 'bot' | 'error';
  timestamp: number;
}

interface FileReview {
  uri: vscode.Uri;
  content: string;
  review: string;
  suggestedChanges?: string;
}

function shouldIncludeFile(uri: vscode.Uri, config: vscode.WorkspaceConfiguration): boolean {
  const includePatterns = config.get<string[]>('includePatterns', ['**/*']);
  const excludePatterns = config.get<string[]>('excludePatterns', [
    '**/node_modules/**',
    '**/.git/**',
    '**/*.log',
    '**/*.lock',
  ]);
  const relativePath = vscode.workspace.asRelativePath(uri);
  const included = includePatterns.some(pattern => minimatch(relativePath, pattern));
  const excluded = excludePatterns.some(pattern => minimatch(relativePath, pattern));
  return included && !excluded;
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
    throw new Error(`Failed to create backup for ${uri.fsPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function applyFileChanges(uri: vscode.Uri, newContent: string): Promise<boolean> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const currentContent = document.getText();
    if (currentContent === newContent) return false;

    const original = uri;
    const modified = vscode.Uri.parse(`untitled:${uri.fsPath}.suggested`);
    await vscode.workspace.openTextDocument(modified).then(doc => {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(modified, new vscode.Position(0, 0), newContent);
      return vscode.workspace.applyEdit(edit);
    });

    await vscode.commands.executeCommand('vscode.diff', original, modified, `${basename(uri.fsPath)}: Original vs Suggested`);

    const apply = await vscode.window.showInformationMessage(
      `Apply changes to ${basename(uri.fsPath)}?`,
      'Apply',
      'Cancel'
    );

    if (apply !== 'Apply') return false;

    await backupFile(uri);
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(currentContent.length)
    );
    edit.replace(uri, fullRange, newContent);
    await vscode.workspace.applyEdit(edit);
    await document.save();
    outputChannel.appendLine(`Applied changes to ${uri.fsPath}`);
    return true;
  } catch (error) {
    throw new Error(`Failed to apply changes to ${uri.fsPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function getLLMResponse(prompt: string, config: vscode.WorkspaceConfiguration): Promise<string> {
  try {
    const response = await axios.post<{ text: string }>(
      config.get('flowiseUrl', 'http://localhost:3000/api/v1/prediction/ccbfcde1-d3f3-40b2-9436-c3ba6b8a95a2'),
      { question: prompt },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(config.get('apiToken') ? { Authorization: `Bearer ${config.get('apiToken')}` } : {}),
        },
        timeout: config.get('apiTimeout', 30000),
      }
    );

    const sanitized = sanitizeHtml(response.data.text, {
      allowedTags: [],
      allowedAttributes: {},
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
      review: `File too large to review (size: ${content.length} bytes, max: ${maxFileSize} bytes)`,
    };
  }

  const prompt = `Review the following file content and suggest improvements:\n\n**File**: ${basename(uri.fsPath)}\n**Content**:\n\`\`\`${extname(uri.fsPath).slice(1)}\n${content}\n\`\`\`\n\nProvide a review and, if applicable, include a "Suggested changes:" section with the full modified content.`;

  try {
    const review = await getLLMResponse(prompt, config);
    const suggestedChangesMatch = review.match(/Suggested changes:\n([\s\S]*)/);
    return {
      uri,
      content,
      review,
      suggestedChanges: suggestedChangesMatch ? suggestedChangesMatch[1].trim() : undefined,
    };
  } catch (error) {
    return {
      uri,
      content,
      review: `Error reviewing file: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Reviewing Project Files',
      cancellable: true,
    },
    async (progress, token) => {
      try {
        const files = await vscode.workspace.findFiles(
          '**/*',
          `{${config.get<string[]>('excludePatterns', ['**/node_modules/**', '**/.git/**']).join(',')}}`
        );

        if (files.length > maxFiles) {
          return `Too many files (${files.length}). Max allowed: ${maxFiles}. Adjust 'llmcoderagent.maxFiles' in settings.`;
        }

        const totalFiles = files.length;
        let processedFiles = 0;

        progress.report({ message: `Found ${totalFiles} files to review` });

        for (let i = 0; i < files.length && !token.isCancellationRequested; i += batchSize) {
          const batch = files.slice(i, i + batchSize).filter(uri => shouldIncludeFile(uri, config));
          const batchReviews = await Promise.all(batch.map(uri => reviewFile(uri, config)));
          reviews.push(...batchReviews);

          processedFiles += batch.length;
          progress.report({
            message: `Processed ${processedFiles}/${totalFiles} files`,
            increment: (batch.length / totalFiles) * 100,
          });
        }

        if (token.isCancellationRequested) {
          return 'Project review cancelled.';
        }

        let summary = `Project Review Completed\n\nReviewed ${reviews.length} files:\n`;
        for (const review of reviews) {
          summary += `\n**${vscode.workspace.asRelativePath(review.uri)}**:\n${review.review}\n`;
          if (review.suggestedChanges) {
            const applied = await applyFileChanges(review.uri, review.suggestedChanges);
            if (applied) {
              summary += `Changes applied to ${vscode.workspace.asRelativePath(review.uri)}\n`;
            }
          }
        }

        outputChannel.appendLine(`Project review completed with ${reviews.length} files processed.`);
        return summary;
      } catch (error) {
        const message = `Project review failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        outputChannel.appendLine(message);
        handleError(error, panel);
        return message;
      }
    }
  );
}

function handleError(error: unknown, panel: vscode.WebviewPanel) {
  const message = error instanceof AxiosError
    ? `API Error: ${error.response?.statusText || error.message}`
    : error instanceof Error
      ? error.message
      : 'An unexpected error occurred';

  vscode.window.showErrorMessage(message);
  panel.webview.postMessage({
    type: 'response',
    text: `Error: ${sanitizeHtml(message, { allowedTags: [], allowedAttributes: {} })}`,
  });
}

export function deactivate() {
  outputChannel.appendLine('LLMCoderAgent deactivated');
  outputChannel.dispose();
}
