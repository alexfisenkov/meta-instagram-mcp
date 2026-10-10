/** Advisory context for a bounded read; signal support is provider-specific, not a guarantee that every request is canceled. */
export interface SourceReadContext {
  signal?: AbortSignal;
  /** Epoch-millisecond cutoff for starting or continuing provider work. */
  deadlineAt?: number;
}
