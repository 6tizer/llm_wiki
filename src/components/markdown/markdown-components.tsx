import type { Components } from "react-markdown"

import { MermaidDiagram, unwrapMermaidPre } from "@/components/mermaid-diagram"

export function createMarkdownComponents(options: {
  overrides?: Components
  preClassName?: string
  codeClassNameFallback?: string
} = {}): Components {
  return {
    table: ({ children, ...props }) => (
      <div className="my-2 overflow-x-auto rounded border border-border">
        <table className="w-full border-collapse text-xs" {...props}>{children}</table>
      </div>
    ),
    thead: ({ children, ...props }) => (
      <thead className="bg-muted" {...props}>{children}</thead>
    ),
    th: ({ children, ...props }) => (
      <th className="border border-border/80 px-3 py-1.5 text-start font-semibold bg-muted" {...props}>{children}</th>
    ),
    td: ({ children, ...props }) => (
      <td className="border border-border/60 px-3 py-1.5" {...props}>{children}</td>
    ),
    pre: ({ children, ...props }) => {
      const mermaid = unwrapMermaidPre(children)
      if (mermaid) return <>{mermaid}</>
      return (
        <pre
          dir="ltr"
          className={options.preClassName}
          style={{ textAlign: "left" }}
          {...props}
        >
          {children}
        </pre>
      )
    },
    code: ({ className, children, ...props }) => {
      const lang = className?.replace("language-", "")
      const codeText = String(children).replace(/\n$/, "")
      if (lang === "mermaid") return <MermaidDiagram code={codeText} />
      return (
        <code
          dir="ltr"
          className={className ? className : options.codeClassNameFallback}
          {...props}
        >
          {children}
        </code>
      )
    },
    ...options.overrides,
  }
}
