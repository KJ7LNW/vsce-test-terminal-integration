import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TerminalHandler } from '../terminal/terminal-handler';

export class WebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'terminalCommands';
    private _view?: vscode.WebviewView;
    private terminalHandler: TerminalHandler;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.terminalHandler = new TerminalHandler(
            (text) => this.postMessage({ type: 'output', text }),
            (text) => this.postMessage({ type: 'debug', text })
        );
    }

    private postMessage(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getWebviewContent();

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'runCommand':
                    await this.terminalHandler.executeCommand(message.text, {
                        autoCloseTerminal: message.autoCloseTerminal,
                        useShellIntegration: message.useShellIntegration
                    });
                    break;
                case 'resetCounts':
                    this.terminalHandler.resetStats();
                    break;
            }
        });
    }

    private getWebviewContent(): string {
        const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'webview.html');
        const cssPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'webview.css');

        let htmlContent = fs.readFileSync(htmlPath, 'utf8');
        const cssContent = fs.readFileSync(cssPath, 'utf8');

        // Insert CSS into HTML
        htmlContent = htmlContent.replace('</head>', `<style>${cssContent}</style></head>`);
        
        return htmlContent;
    }
}
