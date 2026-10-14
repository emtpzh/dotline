// One job at a time per key: a session file read from where the last read
// stopped, a session's turns written into the canvas. A job waits for the
// one before it, whatever became of that one.

const queues = new Map<string, Promise<unknown>>();

export function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

/** Run `job` when no other write of this session's turns into the canvas is
 *  going on: the session sync's, or a canvas run's own account of its turn. */
export function underSession<T>(runner: string, sessionId: string, job: () => Promise<T>): Promise<T> {
  return serial(`turns|${runner}:${sessionId}`, job);
}
