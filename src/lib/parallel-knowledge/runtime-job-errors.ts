interface DuplicateRuntimeJobErrorOptions {
  readonly requireRuntimeJobIdConstraint?: boolean
}

/** Detects duplicate runtime job creation errors from backend-specific messages. */
export function isDuplicateRuntimeJobError(
  message: string,
  options: DuplicateRuntimeJobErrorOptions = {},
): boolean {
  const normalized = message.toLowerCase()
  const isConstraintFailure = normalized.includes("unique constraint")
    || normalized.includes("duplicate")
    || (!options.requireRuntimeJobIdConstraint && normalized.includes("already exists"))
  if (!options.requireRuntimeJobIdConstraint) return isConstraintFailure

  const isJobIdConstraint = normalized.includes("runtime_jobs.job_id")
    || normalized.includes("runtime_jobs_job_id")
    || normalized.includes("runtime_jobs_pkey")
    || normalized.includes("runtime_jobs.primary")
    || normalized.includes("for key 'primary'")
  return isJobIdConstraint && isConstraintFailure
}
