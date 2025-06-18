LLMCoderAgent
LLMCoderAgent is a Visual Studio Code extension that enables developers to interact with a local Flowise + Ollama LLM (Large Language Model) agent directly from the VS Code editor. It provides a chat interface within a webview panel, allowing users to send queries or selected code to the LLM and receive responses, enhancing coding productivity with AI assistance.
Features

Interactive Chat Interface: Open a webview panel to chat with a local Flowise + Ollama LLM agent.
Context Menu Integration: Access the chat panel from the editor's context menu when code is selected.
Configurable Settings: Customize the Flowise API endpoint, timeouts, UI elements, and more via VS Code settings.
Theme Integration: Seamlessly adapts to your VS Code theme for a consistent look and feel.
Persistent Chat History: Retains conversation history (up to a configurable limit) during a session.
Error Handling: Provides clear error messages for API failures or network issues.

Installation

Install from VS Code Marketplace (if published):

Open VS Code.
Go to the Extensions view (Ctrl+Shift+X or Cmd+Shift+X on macOS).
Search for LLMCoderAgent.
Click Install.


Manual Installation (for development or local use):

Clone the repository:git clone https://github.com/ashnikh78/llmcoderagent.git


Navigate to the project directory:cd llmcoderagent


Install dependencies:npm install


Compile the extension:npm run compile


Open the project in VS Code:code .


Press F5 to run the extension in a development instance of VS Code.


Package and Install (optional):

Package the extension:vsce package


Install the generated .vsix file:
In VS Code, go to Extensions view, click the ... menu, and select Install from VSIX.
Choose the generated .vsix file.





Requirements

VS Code Version: 1.100.2 or higher.
Flowise Server: A local or remote Flowise server running with the correct prediction endpoint (default: http://localhost:3000/api/v1/prediction/ccbfcde1-d3f3-40b2-9436-c3ba6b8a95a2).
Node.js: Required for development and compilation (version compatible with package.json dependencies).
Media Files: Ensure media/icon-light.png and media/icon-dark.png are present in the media folder for webview icons.

Usage

Open the Chat Panel:

Use the Command Palette (Ctrl+Shift+P or Cmd+Shift+P on macOS) and run the command 💬 DU Open LLMCoder Chat.
Alternatively, right-click on selected code in the editor and select 💬 DU Open LLMCoder Chat from the context menu.


Interact with the LLM:

A webview panel will open with a chat interface.
Type your query or paste code in the input box and press Enter or click Send.
The extension sends the input to the configured Flowise API and displays the response in the chat.


Tips:

Select code in the editor before opening the chat to include it in your query.
Use the configuration settings to customize the API endpoint, chat history limit, or UI appearance.
The chat history persists until the panel is closed, with a default limit of 100 messages.



Configuration
Customize the extension via VS Code settings. Open the Settings UI (Preferences: Open Settings (UI)) or edit settings.json directly. The available settings are:



Setting
Type
Default Value
Description



llmcoderagent.flowiseUrl
string
http://localhost:3000/api/v1/prediction/ccbfcde1-d3f3-40b2-9436-c3ba6b8a95a2
URL of the Flowise API prediction endpoint.


llmcoderagent.apiTimeout
number
30000
Timeout for Flowise API requests in milliseconds (5000–60000).


llmcoderagent.messageHistoryLimit
number
100
Maximum number of messages to retain in chat history (10–500).


llmcoderagent.webviewTitle
string
LLMCoder Chat
Title of the chat webview panel (max 50 characters).


llmcoderagent.statusBarTimeout
number
2000
Duration of status bar messages in milliseconds (1000–5000).


llmcoderagent.inputPlaceholder
string
Ask the LLM something...
Placeholder text for the chat input field (max 100 characters).


llmcoderagent.autoScroll
boolean
true
Automatically scroll to the latest message in the chat.


llmcoderagent.useVsCodeTheme
boolean
true
Use VS Code theme colors for the webview UI.


Example settings.json
{
  "llmcoderagent.flowiseUrl": "http://my-server:3000/api/v1/prediction/1234",
  "llmcoderagent.apiTimeout": 20000,
  "llmcoderagent.messageHistoryLimit": 50,
  "llmcoderagent.webviewTitle": "My AI Chat",
  "llmcoderagent.statusBarTimeout": 3000,
  "llmcoderagent.inputPlaceholder": "Type your code query...",
  "llmcoderagent.autoScroll": false,
  "llmcoderagent.useVsCodeTheme": false
}

Troubleshooting

"Cannot connect to Flowise API":

Ensure the Flowise server is running and accessible at the configured flowiseUrl.
Verify the endpoint ID in the URL matches your Flowise setup.
Check network connectivity and firewall settings.
Try increasing apiTimeout if the server is slow to respond.


Chat panel not opening:

Ensure the extension is activated (check if onCommand:llmcoderagent.openChat is registered).
Verify that media/icon-light.png and media/icon-dark.png exist in the media folder.


Settings not applied:

Reload VS Code after changing settings (Developer: Reload Window).
Check for errors in the VS Code Developer Tools console (Help: Toggle Developer Tools).


No response from LLM:

Ensure the Flowise API returns a response in the expected format ({ text: string }).
Check the VS Code Output panel for error messages (select LLMCoderAgent in the dropdown).



For additional help, open an issue on the GitHub repository.
Development
Prerequisites

Node.js (version compatible with package.json dependencies).
TypeScript (npm install -g typescript).
VS Code Extension CLI (npm install -g vsce).

Setup

Clone the repository:git clone https://github.com/ashnikh78/llmcoderagent.git


Install dependencies:npm install


Compile the TypeScript code:npm run compile



Running in Development

Open the project in VS Code.
Press F5 to launch a development instance with the extension loaded.
Test the 💬 DU Open LLMCoder Chat command via the Command Palette or context menu.

Building and Packaging

Compile the extension:npm run compile


Package for distribution:vsce package



Linting

Run ESLint to check for code issues:npm run lint



Contributing
Contributions are welcome! To contribute:

Fork the repository.
Create a feature branch (git checkout -b feature/my-feature).
Commit your changes (git commit -m "Add my feature").
Push to the branch (git push origin feature/my-feature).
Open a pull request on GitHub.

Please include tests and update documentation as needed.
License
This project is licensed under the MIT License. See the LICENSE file for details.
Acknowledgments

Built with VS Code Extension API.
Powered by Flowise and Ollama.
Uses Axios for API requests.

Contact
For questions or feedback, contact the maintainer at the GitHub repository or open an issue.

Last updated: June 18, 2025
