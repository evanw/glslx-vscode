import * as path from 'path';
import * as vscode from 'vscode';
import * as client from 'vscode-languageclient/node';

export function activate(context: vscode.ExtensionContext) {
  let serverModule = path.join(__dirname, 'server.js');

  let serverOptions: client.ServerOptions = {
    run: { module: serverModule, transport: client.TransportKind.ipc },
    debug: { module: serverModule, transport: client.TransportKind.ipc },
  };

  let clientOptions: client.LanguageClientOptions = {
    documentSelector: ['glslx'],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.glslx'),
    },
  };

  let server = new client.LanguageClient('GLSLX', serverOptions, clientOptions);
  context.subscriptions.push(server.start());
}
