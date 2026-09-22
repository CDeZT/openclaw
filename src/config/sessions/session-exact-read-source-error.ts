export type SessionExactReadSourceChange = "replaced" | "missing";

/** An observed refusal from the exact physical-read owner, not an inferred transport fault. */
export class SessionExactReadSourceChangedError extends Error {
  constructor(
    readonly reason: SessionExactReadSourceChange,
    message = reason === "replaced"
      ? "Exact session entry physical source was replaced"
      : "Exact session entry physical database is no longer available",
  ) {
    super(message);
    this.name = "SessionExactReadSourceChangedError";
  }
}

/** Cleanup preserves its primary cause even when native disposal also fails. */
export function sessionExactReadSourceChange(
  error: unknown,
): SessionExactReadSourceChange | undefined {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof SessionExactReadSourceChangedError) return current.reason;
    seen.add(current);
    current =
      current instanceof AggregateError
        ? Array.isArray(current.errors)
          ? current.errors[0]
          : undefined
        : current.cause;
  }
  return undefined;
}
