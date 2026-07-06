import ts from "typescript"

export type BoundarySourceFile = {
  readonly filePath: string
  readonly sourceText: string
}

export type BoundaryViolation = {
  readonly filePath: string
  readonly specifier: string
  readonly reason: string
}

const FORBIDDEN_IMPORTS = [
  {
    match: (specifier: string) => specifier === "react" || specifier.startsWith("react/"),
    reason: "Core Runtime must not import React shell APIs",
  },
  {
    match: (specifier: string) => specifier === "zustand" || specifier.startsWith("zustand/"),
    reason: "Core Runtime must not import Zustand state APIs",
  },
  {
    match: (specifier: string) => specifier.startsWith("@/stores/"),
    reason: "Core Runtime must not import UI shell stores",
  },
  {
    match: (specifier: string) => specifier.startsWith("@/components/"),
    reason: "Core Runtime must not import React components",
  },
  {
    match: (specifier: string) => specifier.startsWith("@/commands/"),
    reason: "Core Runtime must not import shell command wrappers",
  },
  {
    match: (specifier: string) => specifier.startsWith("@/lib/"),
    reason: "Core Runtime must not import shell library modules",
  },
  {
    match: (specifier: string) => specifier.startsWith("@tauri-apps/"),
    reason: "Core Runtime must not import Tauri plugin APIs",
  },
] as const

export function collectModuleSpecifiers(sourceText: string): readonly string[] {
  const sourceFile = ts.createSourceFile(
    "core-runtime-boundary.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  )
  const specifiers: string[] = []

  function addModuleSpecifier(node: { moduleSpecifier?: ts.Expression }): void {
    if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addModuleSpecifier(node)
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text)
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

export function isForbiddenCoreImport(specifier: string): boolean {
  return FORBIDDEN_IMPORTS.some(({ match }) => match(specifier))
}

export function checkCoreRuntimeBoundary(
  files: readonly BoundarySourceFile[],
): readonly BoundaryViolation[] {
  return files.flatMap(({ filePath, sourceText }) =>
    collectModuleSpecifiers(sourceText).flatMap((specifier) => {
      const rule = FORBIDDEN_IMPORTS.find(({ match }) => match(specifier))
      return rule ? [{ filePath, specifier, reason: rule.reason }] : []
    }),
  )
}
