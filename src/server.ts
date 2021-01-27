import * as fs from 'fs';
import uri from 'vscode-uri';
import * as path from 'path';
import * as glslx from 'glslx';
import * as server from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

let buildResults: () => Record<string, glslx.CompileResultIDE | undefined> = () => ({});
let openDocuments: server.TextDocuments<TextDocument>;
let connection: server.Connection;
let timeout: NodeJS.Timeout;

function reportErrors(callback: () => void): void {
  try {
    callback();
  } catch (e) {
    let message = e && e.stack || e;
    connection.console.error('glslx: ' + message);
    connection.window.showErrorMessage('glslx: ' + message);
  }
}

function convertRange(range: glslx.Range): server.Range {
  return {
    start: {
      line: range.start.line,
      character: range.start.column,
    },
    end: {
      line: range.end.line,
      character: range.end.column,
    },
  };
}

function uriToPath(value: string): string | null {
  let parsed = uri.parse(value);
  return parsed.scheme === 'file' ? path.normalize(parsed.fsPath) : null;
}

function pathToURI(value: string): string {
  return uri.file(value).toString();
}

function sendDiagnostics(diagnostics: glslx.Diagnostic[], unusedSymbols: glslx.UnusedSymbol[]): void {
  let map: Record<string, server.Diagnostic[]> = {};

  for (let diagnostic of diagnostics) {
    if (!diagnostic.range) continue;
    let key = diagnostic.range.source;
    let group = map[key] || (map[key] = []);
    group.push({
      severity: diagnostic.kind === 'error' ? server.DiagnosticSeverity.Error : server.DiagnosticSeverity.Warning,
      range: convertRange(diagnostic.range),
      message: diagnostic.text,
    });
  }

  for (let symbol of unusedSymbols) {
    let key = symbol.range!.source;
    let group = map[key] || (map[key] = []);
    group.push({
      severity: server.DiagnosticSeverity.Hint,
      range: convertRange(symbol.range!),
      message: `${JSON.stringify(symbol.name)} is never used in this file`,
      tags: [server.DiagnosticTag.Unnecessary],
    });
  }

  for (let doc of openDocuments.all()) {
    connection.sendDiagnostics({
      uri: doc.uri,
      diagnostics: map[doc.uri] || [],
    });
  }
}

function buildOnce(): Record<string, glslx.CompileResultIDE> {
  let results: Record<string, glslx.CompileResultIDE> = {};
  reportErrors(() => {
    let unusedSymbols: glslx.UnusedSymbol[] = [];
    let diagnostics: glslx.Diagnostic[] = [];
    let docs: Record<string, string> = {};

    for (let doc of openDocuments.all()) {
      docs[doc.uri] = doc.getText();
    }

    function fileAccess(includeText: string, relativeURI: string) {
      let relativePath = uriToPath(relativeURI);
      let absolutePath = relativePath ? path.resolve(path.dirname(path.resolve(relativePath)), includeText) : path.resolve(includeText);

      // In-memory files take precedence
      let absoluteURI = pathToURI(absolutePath);
      if (absoluteURI in docs) {
        return {
          name: absoluteURI,
          contents: docs[absoluteURI],
        };
      }

      // Then try to read from disk
      try {
        return {
          name: absoluteURI,
          contents: fs.readFileSync(absolutePath, 'utf8'),
        };
      } catch (e) {
        return null;
      }
    }

    for (let doc of openDocuments.all()) {
      let result = glslx.compileIDE({
        name: doc.uri,
        contents: docs[doc.uri],
      }, {
        fileAccess,
      });
      results[doc.uri] = result;
      unusedSymbols.push.apply(unusedSymbols, result.unusedSymbols);
      diagnostics.push.apply(diagnostics, result.diagnostics);
    }

    sendDiagnostics(diagnostics, unusedSymbols);
  });
  return results;
}

function buildLater(): void {
  buildResults = () => {
    let result = buildOnce();
    buildResults = () => result;
    return result;
  };
  clearTimeout(timeout);
  timeout = setTimeout(buildResults, 100);
}

function computeTooltip(request: server.TextDocumentPositionParams): server.Hover | undefined {
  let result = buildResults()[request.textDocument.uri];

  if (result) {
    let response = result.tooltipQuery({
      source: request.textDocument.uri,
      line: request.position.line,
      column: request.position.character,

      // Visual Studio Code already includes diagnostics and including
      // them in the results causes each diagnostic to be shown twice
      ignoreDiagnostics: true,
    });

    if (response.tooltip !== null && response.range !== null) {
      return {
        contents: {
          kind: 'markdown',
          value: '```glslx\n' + response.tooltip + '\n```\n' + response.documentation,
        },
        range: convertRange(response.range),
      }
    }
  }
}

function computeDefinitionLocation(request: server.TextDocumentPositionParams): server.Definition | undefined {
  let result = buildResults()[request.textDocument.uri];

  if (result) {
    let response = result.definitionQuery({
      source: request.textDocument.uri,
      line: request.position.line,
      column: request.position.character,
    });

    if (response.definition !== null) {
      return {
        uri: response.definition.source,
        range: convertRange(response.definition),
      };
    }
  }
}

function computeDocumentSymbols(request: server.DocumentSymbolParams): server.SymbolInformation[] | undefined {
  let result = buildResults()[request.textDocument.uri];

  if (result) {
    let response = result.symbolsQuery({
      source: request.textDocument.uri,
    });

    if (response.symbols !== null) {
      return response.symbols.map(symbol => {
        return {
          name: symbol.name,
          kind:
            symbol.kind === 'struct' ? server.SymbolKind.Class :
              symbol.kind === 'function' ? server.SymbolKind.Function :
                server.SymbolKind.Variable,
          location: {
            uri: symbol.range.source,
            range: convertRange(symbol.range),
          },
        };
      });
    }
  }
}

function computeRenameEdits(request: server.RenameParams): server.WorkspaceEdit | undefined {
  let result = buildResults()[request.textDocument.uri];

  if (result) {
    let response = result.renameQuery({
      source: request.textDocument.uri,
      line: request.position.line,
      column: request.position.character,
    });

    if (response.ranges !== null) {
      let documentChanges: server.TextDocumentEdit[] = [];
      let map: Record<string, server.TextEdit[]> = {};

      for (let range of response.ranges) {
        let edits = map[range.source];
        if (!edits) {
          let doc = openDocuments.get(range.source);
          edits = map[range.source] = [];
          if (doc) {
            documentChanges.push({
              textDocument: { uri: range.source, version: doc.version },
              edits,
            });
          }
        }
        edits.push({
          range: convertRange(range),
          newText: request.newName,
        });
      }

      return {
        documentChanges,
      };
    }
  }
}

function formatDocument(request: server.DocumentFormattingParams): server.TextEdit[] {
  let doc = openDocuments.get(request.textDocument.uri)
  if (!doc) {
    return [];
  }

  let options = request.options || {};
  let input = doc.getText();
  let output = glslx.format(input, {
    indent: options.insertSpaces ? ' '.repeat(options.tabSize || 2) : '\t',
    newline: '\n',

    // It seems like it's impossible to get the trailing newline settings from
    // VSCode here? They are always undefined for some reason even though they
    // are present in the type definitions. It says they are present as of
    // version 3.15.0 but the published version of "vscode-languageserver" only
    // goes up to 3.5.0 before 4.0.0. This seems like a bug in VSCode itself:
    // https://github.com/microsoft/vscode-languageserver-node/issues/617
    //
    //   trailingNewline:
    //     options.insertFinalNewline ? 'insert' :
    //       options.trimFinalNewlines ? 'remove' :
    //         'preserve',
    //
    trailingNewline: 'insert',
  });

  // Early-out if nothing changed
  if (input === output) {
    return [];
  }

  // Just return one big edit. VSCode seems to be smart enough to keep the
  // cursor in the right place if whitespace between tokens shifts around.
  return [{
    range: {
      start: {
        line: 0,
        character: 0,
      },
      end: doc.positionAt(input.length),
    },
    newText: output,
  }];
}

function computeCompletion(request: server.CompletionParams): server.CompletionItem[] | undefined {
  let result = buildResults()[request.textDocument.uri];

  if (result) {
    let response = result.completionQuery({
      source: request.textDocument.uri,
      line: request.position.line,
      column: request.position.character,
    });

    return response.completions.map(completion => ({
      kind:
        completion.kind === 'struct' ? server.CompletionItemKind.Class :
          completion.kind === 'function' ? server.CompletionItemKind.Function :
            completion.kind === 'variable' ? server.CompletionItemKind.Variable :
              server.CompletionItemKind.Keyword,
      label: completion.name,
      documentation: completion.detail === '' ? void 0 : {
        kind: 'markdown',
        value: '```glslx\n' + completion.detail + '\n```\n' + completion.documentation,
      },
    }));
  }
}

function computeSignature(request: server.SignatureHelpParams): server.SignatureHelp | undefined {
  let result = buildResults()[request.textDocument.uri];

  if (result) {
    let response = result.signatureQuery({
      source: request.textDocument.uri,
      line: request.position.line,
      column: request.position.character,
    });

    return {
      activeSignature: response.activeSignature !== -1 ? response.activeSignature : null,
      activeParameter: response.activeArgument !== -1 ? response.activeArgument : null,
      signatures: response.signatures.map(signature => ({
        label: signature.text,
        documentation: signature.documentation === '' ? void 0 : {
          kind: 'markdown',
          value: signature.documentation,
        },
        parameters: signature.arguments.map(arg => ({
          label: arg,
        })),
      })),
    };
  }
}

function main(): void {
  connection = server.createConnection(
    new server.IPCMessageReader(process),
    new server.IPCMessageWriter(process));

  reportErrors(() => {
    // Listen to open documents
    openDocuments = new server.TextDocuments(TextDocument);
    openDocuments.listen(connection);
    openDocuments.onDidChangeContent(buildLater);

    // Grab the workspace when the connection opens
    connection.onInitialize(() => {
      buildLater();
      return {
        capabilities: {
          textDocumentSync: server.TextDocumentSyncKind.Incremental,
          hoverProvider: true,
          renameProvider: true,
          definitionProvider: true,
          documentSymbolProvider: true,
          documentFormattingProvider: true,
          signatureHelpProvider: {
            triggerCharacters: ['(', ','],
          },
          completionProvider: {
            triggerCharacters: ['.'],
          },
        },
      };
    });

    // Show tooltips on hover
    connection.onHover(request => {
      let tooltip: server.Hover | undefined;
      reportErrors(() => {
        tooltip = computeTooltip(request);
      });
      return tooltip!;
    });

    // Support the "go to definition" feature
    connection.onDefinition(request => {
      let location: server.Definition | undefined;
      reportErrors(() => {
        location = computeDefinitionLocation(request);
      })
      return location!;
    });

    // Support the go to symbol feature
    connection.onDocumentSymbol(request => {
      let info: server.SymbolInformation[] | undefined;
      reportErrors(() => {
        info = computeDocumentSymbols(request);
      });
      return info!;
    });

    // Support the "rename symbol" feature
    connection.onRenameRequest(request => {
      let edits: server.WorkspaceEdit | undefined;
      reportErrors(() => {
        edits = computeRenameEdits(request);
      });
      return edits!;
    });

    // Support whole-document formatting
    connection.onDocumentFormatting(request => {
      let edits: server.TextEdit[] | undefined;
      reportErrors(() => {
        edits = formatDocument(request);
      });
      return edits!;
    });

    // Support symbol completions
    connection.onCompletion(request => {
      let result: server.CompletionItem[] | undefined;
      reportErrors(() => {
        result = computeCompletion(request);
      });
      return result;
    });

    // Support function signature resolution
    connection.onSignatureHelp(request => {
      let result: server.SignatureHelp | undefined;
      reportErrors(() => {
        result = computeSignature(request);
      });
      return result;
    });

    // Listen to file system changes for *.glslx files
    connection.onDidChangeWatchedFiles(buildLater);
  });

  connection.listen();
}

main();
