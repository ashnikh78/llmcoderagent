# LLMCoderAgent

**LLMCoderAgent** is a Visual Studio Code extension that integrates a local LLM (e.g., LLaMA3 via Ollama) through a Flowise workflow.

## 🚀 Features

- 🔍 Right-click any selected text or code in the editor and send it to your local LLM agent
- 🧠 Powered by Ollama + Flowise (runs locally)
- 💬 See results instantly in a popup inside VS Code

## 🛠 Requirements

- [Ollama](https://ollama.com) running locally (`ollama serve`)
- [Flowise](https://flowiseai.com) with a workflow using the Ollama LLM
- The HTTP endpoint of the deployed Flowise flow

## 🧪 How to Use

1. Open any file in VS Code
2. Select text/code
3. Right-click → `🧠 Run with LLMCoder Agent`
4. Get results via Flowise + Ollama in a popup

## 🔗 Configuration

Update `extension.js` to point to your Flowise deployed flow endpoint.

```js
// Replace with your own Flow URL
const flowiseUrl = 'http://localhost:3000/api/v1/prediction/ba0d50a2-736d-46b2-bcbe-ddda794de16e';
"# llmcoderagent" 
