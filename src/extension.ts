import * as vscode from 'vscode';
import { WebviewProvider } from './webview/webview-provider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new WebviewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(WebviewProvider.viewType, provider)
    );
}

export function deactivate() {}
