import * as fs from 'fs'
import * as path from 'path'
import * as glslx from 'glslx'
import * as vscode from 'vscode'

let buildResults: () => Record<string, glslx.CompileResultIDE | undefined> = () => ({})
let diagnosticCollection: vscode.DiagnosticCollection
let diagnosticUris = new Set<vscode.Uri>()
let timeout: ReturnType<typeof setTimeout>

function allOpenDocuments(): vscode.TextDocument[] {
  return vscode.workspace.textDocuments.filter(doc => doc.languageId === 'glslx')
}

function reportErrors<T>(callback: () => T): T | undefined {
  try {
    return callback()
  } catch (e: any) {
    const message = e && e.stack || e
    console.error('glslx: ' + message)
    vscode.window.showErrorMessage('glslx: ' + message)
  }
}

function convertRange(range: glslx.Range): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.column),
    new vscode.Position(range.end.line, range.end.column),
  )
}

function sendDiagnostics(diagnostics: glslx.Diagnostic[], unusedSymbols: glslx.UnusedSymbol[]): void {
  const map: Record<string, vscode.Diagnostic[]> = {}

  for (const diagnostic of diagnostics) {
    if (diagnostic.range) {
      const key = diagnostic.range.source
      const group = map[key] || (map[key] = [])
      group.push(new vscode.Diagnostic(
        convertRange(diagnostic.range),
        diagnostic.text,
        diagnostic.kind === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      ))
    }
  }

  for (const symbol of unusedSymbols) {
    const key = symbol.range!.source
    const group = map[key] || (map[key] = [])
    const diagnostic = new vscode.Diagnostic(
      convertRange(symbol.range!),
      `${JSON.stringify(symbol.name)} is never used in this file`,
      vscode.DiagnosticSeverity.Hint,
    )
    diagnostic.tags = [vscode.DiagnosticTag.Unnecessary]
    group.push(diagnostic)
  }

  const newDiagnosticUris = new Set<vscode.Uri>()
  for (const doc of allOpenDocuments()) {
    diagnosticUris.add(doc.uri)
  }
  for (const uri of diagnosticUris) {
    const diagnostics = map[uri.toString()] || []
    diagnosticCollection.set(uri, diagnostics)
    if (diagnostics.length > 0) newDiagnosticUris.add(uri)
  }
  diagnosticUris = newDiagnosticUris
}

function buildOnce(): Record<string, glslx.CompileResultIDE> {
  const results: Record<string, glslx.CompileResultIDE> = {}
  const unusedSymbols: glslx.UnusedSymbol[] = []
  const diagnostics: glslx.Diagnostic[] = []
  const docs: Record<string, string> = {}

  const fileAccess: glslx.FileAccess = (includeText, relativePath) => {
    const absolutePath = relativePath ? path.resolve(path.dirname(path.resolve(relativePath)), includeText) : path.resolve(includeText)

    // In-memory files take precedence
    const absoluteURI = vscode.Uri.file(absolutePath).toString()
    if (absoluteURI in docs) {
      return {
        name: absoluteURI,
        contents: docs[absoluteURI],
      }
    }

    // Then try to read from disk
    try {
      return {
        name: absoluteURI,
        contents: fs.readFileSync(absolutePath, 'utf8'),
      }
    } catch (e) {
      return null
    }
  }

  for (const doc of allOpenDocuments()) {
    docs[doc.uri.toString()] = doc.getText()
  }

  for (const doc of allOpenDocuments()) {
    const result = glslx.compileIDE({
      name: doc.uri.toString(),
      contents: docs[doc.uri.toString()],
    }, {
      fileAccess,
    })
    results[doc.uri.toString()] = result
    unusedSymbols.push(...result.unusedSymbols)
    diagnostics.push(...result.diagnostics)
  }

  sendDiagnostics(diagnostics, unusedSymbols)
  return results
}

function buildLater(): void {
  buildResults = () => {
    const result = reportErrors(() => buildOnce()) || {}
    buildResults = () => result
    return result
  }

  clearTimeout(timeout)
  timeout = setTimeout(buildResults, 100)
}

function computeTooltip(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
  const result = buildResults()[document.uri.toString()]

  if (result) {
    const response = result.tooltipQuery({
      source: document.uri.toString(),
      line: position.line,
      column: position.character,

      // Visual Studio Code already includes diagnostics and including
      // them in the results causes each diagnostic to be shown twice
      ignoreDiagnostics: true,
    })

    if (response.tooltip !== null && response.range !== null) {
      return new vscode.Hover(
        new vscode.MarkdownString('```glslx\n' + response.tooltip + '\n```\n' + response.documentation),
        convertRange(response.range),
      )
    }
  }
}

function computeDefinitionLocation(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
  const result = buildResults()[document.uri.toString()]

  if (result) {
    const response = result.definitionQuery({
      source: document.uri.toString(),
      line: position.line,
      column: position.character,
    })

    if (response.definition !== null) {
      return new vscode.Location(
        vscode.Uri.parse(response.definition.source),
        convertRange(response.definition),
      )
    }
  }
}

function computeDocumentSymbols(document: vscode.TextDocument): vscode.SymbolInformation[] | undefined {
  const result = buildResults()[document.uri.toString()]

  if (result) {
    const response = result.symbolsQuery({
      source: document.uri.toString(),
    })

    if (response.symbols !== null) {
      return response.symbols.map(symbol => new vscode.SymbolInformation(
        symbol.name,
        symbol.kind === 'struct' ? vscode.SymbolKind.Class :
          symbol.kind === 'function' ? vscode.SymbolKind.Function :
            vscode.SymbolKind.Variable,
        convertRange(symbol.range),
        vscode.Uri.parse(symbol.range.source),
      ))
    }
  }
}

function computeRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string): vscode.WorkspaceEdit | undefined {
  const result = buildResults()[document.uri.toString()]

  if (result) {
    const response = result.renameQuery({
      source: document.uri.toString(),
      line: position.line,
      column: position.character,
    })

    if (response.ranges !== null) {
      const edit = new vscode.WorkspaceEdit
      for (const range of response.ranges) {
        edit.replace(vscode.Uri.parse(range.source), convertRange(range), newName)
      }
      return edit
    }
  }
}

function computeReferenceLocations(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext): vscode.Location[] | undefined {
  const result = buildResults()[document.uri.toString()]

  if (result) {
    const response = result.renameQuery({
      source: document.uri.toString(),
      line: position.line,
      column: position.character,
    })

    if (response.ranges !== null) {
      let ranges = response.ranges

      // Potentially exclude declarations to immediately jump to a single use
      if (!context.includeDeclaration && response.definitions !== null) {
        const definitions = new Set<string>()
        for (const range of response.definitions) definitions.add(JSON.stringify(range))
        ranges = ranges.filter(range => !definitions.has(JSON.stringify(range)))
      }

      return ranges.map(range => new vscode.Location(
        vscode.Uri.parse(range.source),
        convertRange(range),
      ))
    }
  }
}

function formatDocument(document: vscode.TextDocument, options: vscode.FormattingOptions): vscode.TextEdit[] {
  const input = document.getText()
  const output = glslx.format(input, {
    indent: options.insertSpaces ? ' '.repeat(options.tabSize || 2) : '\t',
    newline: '\n',
    trailingNewline:
      options.insertFinalNewline ? 'insert' :
        options.trimFinalNewlines ? 'remove' :
          'preserve',
  })

  // Early-out if nothing changed
  if (input === output) {
    return []
  }

  // Just return one big edit. VSCode seems to be smart enough to keep the
  // cursor in the right place if whitespace between tokens shifts around.
  return [new vscode.TextEdit(
    new vscode.Range(document.positionAt(0), document.positionAt(input.length)),
    output,
  )]
}

function computeCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
  const result = buildResults()[document.uri.toString()]

  if (result) {
    const response = result.completionQuery({
      source: document.uri.toString(),
      line: position.line,
      column: position.character,
    })

    return response.completions.map(completion => {
      const result = new vscode.CompletionItem(
        completion.name,
        completion.kind === 'struct' ? vscode.CompletionItemKind.Class :
          completion.kind === 'function' ? vscode.CompletionItemKind.Function :
            completion.kind === 'variable' ? vscode.CompletionItemKind.Variable :
              completion.kind === 'method' ? vscode.CompletionItemKind.Method :
                vscode.CompletionItemKind.Keyword,
      )
      if (completion.detail) {
        result.documentation = new vscode.MarkdownString('```glslx\n' + completion.detail + '\n```\n' + completion.documentation)
      }
      if (completion.kind === 'method' && completion.name === 'length') {
        result.insertText = 'length()'
      }
      return result
    })
  }
}

function computeSignature(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
  const result = buildResults()[document.uri.toString()]

  if (result) {
    const response = result.signatureQuery({
      source: document.uri.toString(),
      line: position.line,
      column: position.character,
    })

    const help = new vscode.SignatureHelp
    if (response.activeSignature !== -1) {
      help.activeSignature = response.activeSignature
    }
    if (response.activeArgument !== -1) {
      help.activeParameter = response.activeArgument
    }
    help.signatures = response.signatures.map(signature => {
      const info = new vscode.SignatureInformation(
        signature.text,
        signature.documentation === '' ? void 0 : new vscode.MarkdownString(signature.documentation),
      )
      info.parameters = signature.arguments.map(arg => new vscode.ParameterInformation(arg))
      return info
    })
    return help
  }
}

export function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection('glslx')

  context.subscriptions.push(
    // Show diagnostics as you type
    vscode.workspace.onDidChangeTextDocument(() => {
      buildLater()
    }),

    // Show tooltips on hover
    vscode.languages.registerHoverProvider({ language: 'glslx' }, {
      provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
        return reportErrors(() => computeTooltip(document, position))
      },
    }),

    // Support the "go to definition" feature
    vscode.languages.registerDefinitionProvider({ language: 'glslx' }, {
      provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Definition> {
        return reportErrors(() => computeDefinitionLocation(document, position))
      },
    }),

    vscode.languages.registerDocumentSymbolProvider({ language: 'glslx' }, {
      provideDocumentSymbols(document: vscode.TextDocument): vscode.ProviderResult<vscode.SymbolInformation[]> {
        return reportErrors(() => computeDocumentSymbols(document))
      },
    }),

    // Support the "rename symbol" feature
    vscode.languages.registerRenameProvider({ language: 'glslx' }, {
      provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string): vscode.ProviderResult<vscode.WorkspaceEdit> {
        return reportErrors(() => computeRenameEdits(document, position, newName))
      },
    }),

    // Support finding all references
    vscode.languages.registerReferenceProvider({ language: 'glslx' }, {
      provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext): vscode.ProviderResult<vscode.Location[]> {
        return reportErrors(() => computeReferenceLocations(document, position, context))
      },
    }),

    // Support whole-document formatting
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'glslx' }, {
      provideDocumentFormattingEdits(document: vscode.TextDocument, options: vscode.FormattingOptions): vscode.ProviderResult<vscode.TextEdit[]> {
        return reportErrors(() => formatDocument(document, options))
      },
    }),

    // Support symbol completions
    vscode.languages.registerCompletionItemProvider({ language: 'glslx' }, {
      provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.CompletionItem[]> {
        return reportErrors(() => computeCompletions(document, position))
      },
    }, '.'),

    // Support function signature resolution
    vscode.languages.registerSignatureHelpProvider({ language: 'glslx' }, {
      provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.SignatureHelp> {
        return reportErrors(() => computeSignature(document, position))
      },
    }, '(', ','),
  )

  buildLater()
}
