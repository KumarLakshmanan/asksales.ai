interface LogPersistenceSource {
  getDiagnostics(): { pendingWrites: number; droppedWrites: number };
}

let source: LogPersistenceSource | null = null;

/** Register this process's sink without retaining or exposing log records. */
export function registerLogPersistenceDiagnostics(value: LogPersistenceSource) {
  source = value;
}

export function getLogPersistenceDiagnostics() {
  if (!source) return { enabled: false, pendingWrites: 0, droppedWrites: 0 };
  const { pendingWrites, droppedWrites } = source.getDiagnostics();
  return { enabled: true, pendingWrites, droppedWrites };
}
