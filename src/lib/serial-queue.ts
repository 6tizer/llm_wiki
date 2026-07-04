export type SerialQueue = (task: () => Promise<void>) => Promise<void>

/**
 * Builds a FIFO serializer: each enqueued task only starts once every
 * task enqueued before it has fully settled (resolved OR rejected). A
 * rejected task does not "poison" the queue — the next task still runs
 * on schedule — but the rejection IS still delivered to whoever called
 * `enqueue` for that specific task, via the promise it returns.
 *
 * Extracted out of App.tsx's handleProjectOpened, where two overlapping
 * opens' side effects (most notably resetProjectState's unconditional
 * store-clearing) could otherwise interleave: a slow/stale open's
 * resetProjectState() could finish AFTER a newer open had already
 * loaded real data, silently wiping it. Serializing the entire
 * pipeline behind one of these queues means that can't happen — only
 * one task's body ever executes at a time, regardless of how many are
 * enqueued while it's running.
 */
export function createSerialQueue(): SerialQueue {
  let chain: Promise<void> = Promise.resolve()

  return (task: () => Promise<void>): Promise<void> => {
    const scheduled = chain.then(task, task)
    // Normalize so a rejection doesn't propagate into `chain` itself —
    // otherwise every task enqueued after a failing one would need its
    // own rejection handler just to avoid an unhandled-rejection
    // warning on a promise nothing else observes.
    chain = scheduled.then(
      () => undefined,
      () => undefined,
    )
    return scheduled
  }
}
