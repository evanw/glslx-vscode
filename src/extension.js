var path = require('path');
var vscode = require('vscode');
var client = require('vscode-languageclient');

exports.activate = function(context) {
  var serverModule = path.join(__dirname, 'server.js');

  var serverOptions = {
    run: { module: serverModule, transport: client.TransportKind.ipc },
    debug: { module: serverModule, transport: client.TransportKind.ipc },
  };

  var clientOptions = {
    documentSelector: ['glslx'],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.glslx'),
    },
  };

  var server = new client.LanguageClient('GLSLX', serverOptions, clientOptions);
  context.subscriptions.push(server.start());
};
