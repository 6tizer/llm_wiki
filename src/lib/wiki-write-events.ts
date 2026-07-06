/** Wiki file mutation metadata used by Agent app-tool rewind snapshots. */
export interface WikiWriteChange {
  path: string
  operation: "update" | "create" | "delete"
  existedBefore: boolean
  beforeText: string
}

/** Callback invoked only after the corresponding wiki write succeeded. */
export type WikiWriteChangeCallback = (change: WikiWriteChange) => void
