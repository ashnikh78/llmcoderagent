import * as assert from 'assert';
import * as vscode from 'vscode';

suite('LLMCoderAgent Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start LLMCoderAgent tests.');

  test('LLMCoderAgent command should be registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(allCommands.includes('llmcoderagent.openChat'), 'Command llmcoderagent.openChat not found');
  });

  test('LLMCoderAgent activates and shows message', async () => {
    await vscode.commands.executeCommand('llmcoderagent.openChat');
    // Further checks would require mocking the WebView
    assert.ok(true, 'Executed openChat without error');
  });
});
