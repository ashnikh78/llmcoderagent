import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('llmcoderagent.openChat', () => {
    const panel = vscode.window.createWebviewPanel(
      'llmcoderagentChat',
      '💬 LLMCoder Chat',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    // ✅ Set iconPath separately
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-light.png'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-dark.png')
    };

    panel.webview.html = getWebviewContent();

    panel.webview.onDidReceiveMessage(
      async message => {
        if (message.command === 'sendMessage') {
          const userText = message.text.trim();
          if (userText) {
            vscode.window.setStatusBarMessage(`Sending to LLM...`, 2000);

            // 🔁 Replace this with your Flowise/Ollama API call
            const llmResponse = await getLLMResponse(userText);

            panel.webview.postMessage({
              type: 'response',
              text: llmResponse
            });
          }
        }
      },
      undefined,
      context.subscriptions
    );
  });

  context.subscriptions.push(disposable);
}

async function getLLMResponse(prompt: string): Promise<string> {
  // 🧠 Simulate delay & return mock response for now
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(`Mock LLM response for: "${prompt}"`);
    }, 1000);
  });

  // 🔗 Future usage example:
  // const response = await fetch('http://localhost:3000/api/flowise', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ prompt })
  // });
  // const data = await response.json();
  // return data.reply;
}

function getWebviewContent(): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <style>
      body {
        font-family: "Segoe UI", sans-serif;
        margin: 0;
        padding: 1rem;
        background-color: #1e1e1e;
        color: #ddd;
      }
      #messages {
        height: 60vh;
        overflow-y: auto;
        padding: 0.5rem;
        border: 1px solid #444;
        border-radius: 4px;
        margin-bottom: 0.5rem;
        background-color: #252526;
      }
      #input-area {
        display: flex;
        gap: 0.5rem;
      }
      input {
        flex: 1;
        padding: 0.5rem;
        border: 1px solid #444;
        border-radius: 4px;
        background: #333;
        color: #eee;
      }
      button {
        padding: 0.5rem 1rem;
        background: #0e639c;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }
      button:hover {
        background: #1177bb;
      }
      .msg { margin-bottom: 0.4rem; }
      .user { color: #8be9fd; }
      .bot { color: #50fa7b; }
    </style>
  </head>
  <body>
    <div id="messages"></div>
    <div id="input-area">
      <input id="input" type="text" placeholder="Ask the LLM something..." />
      <button id="send">Send</button>
    </div>

    <script>
      const vscode = acquireVsCodeApi();
      const messagesDiv = document.getElementById('messages');
      const inputBox = document.getElementById('input');

      const savedState = vscode.getState();
      if (savedState?.messages) {
        savedState.messages.forEach(m => renderMessage(m.text, m.from));
      }

      document.getElementById('send').addEventListener('click', sendMessage);
      inputBox.addEventListener('keydown', e => {
        if (e.key === 'Enter') sendMessage();
      });

      function sendMessage() {
        const text = inputBox.value.trim();
        if (!text) return;

        renderMessage(text, 'user');
        renderMessage('Typing...', 'bot', true);
        vscode.postMessage({ command: 'sendMessage', text });
        inputBox.value = '';
      }

      function renderMessage(text, from, isTemp = false) {
        const div = document.createElement('div');
        div.className = 'msg';
        div.dataset.temp = isTemp;
        div.innerHTML = \`<span class="\${from}"><b>\${from === 'user' ? 'You' : 'LLM'}:</b></span> \${text}\`;
        messagesDiv.appendChild(div);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;

        const currentMessages = vscode.getState()?.messages || [];
        if (!isTemp) {
          vscode.setState({ messages: [...currentMessages, { text, from }] });
        }
      }

      window.addEventListener('message', event => {
        const { type, text } = event.data;
        if (type === 'response') {
          const temp = messagesDiv.querySelector('[data-temp="true"]');
          if (temp) temp.remove();
          renderMessage(text, 'bot');
        }
      });
    </script>
  </body>
  </html>`;
}

export function deactivate() {}
