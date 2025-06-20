import * as assert from "assert";
import * as vscode from "vscode";

suite("LLMCoderAgent Extension Test Suite", () => {
  test("Extension should be present", () => {
    const extension = vscode.extensions.getExtension(
      "Dharnidhar.llmcoderagent"
    );
    assert.ok(
      extension,
      "Extension Dharnidhar.llmcoderagent should be installed"
    );
  });

  test("Commands should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("llmcoderagent.openChat"),
      "openChat command should be registered"
    );
    assert.ok(
      commands.includes("llmcoderagent.reviewProject"),
      "reviewProject command should be registered"
    );
    assert.ok(
      commands.includes("llmcoderagent.reviewFile"),
      "reviewFile command should be registered"
    );
  });

  test("Configuration settings should have defaults", () => {
    const config = vscode.workspace.getConfiguration("llmcoderagent");
    assert.strictEqual(
      config.get("flowiseUrl"),
      "http://localhost:3000/api/v1/prediction/flow_id",
      "flowiseUrl should have default value"
    );
    assert.strictEqual(
      config.get("messageHistoryLimit"),
      100,
      "messageHistoryLimit should be 100"
    );
    assert.strictEqual(
      config.get("autoScroll"),
      true,
      "autoScroll should be true"
    );
  });
});
