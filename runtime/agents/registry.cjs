// The host's record of its runs: what a page asks when it did not see a
// run's events (it was reloaded, closed, on another canvas, or a page of
// another window started the run). A run outlives the page that started it,
// so only the host can say whether it is still going, which turn of its
// session file it is, and whether that file held the whole turn when it
// ended. Every host keeps one (the desktop shell, the HTTP surface the
// harness plugin and the local server share) and relays every run's events
// through it.
//
// `bootId` names this host process: a run a page knows from another boot is
// over, whatever its last word was — the host that ran it is gone.
'use strict';
const { randomUUID } = require('node:crypto');

/** Ended runs kept for pages that come back late; the oldest go first. */
const KEEP_ENDED = 500;

function createRunRegistry() {
  const bootId = randomUUID();
  const runs = new Map(); // runId → record

  const record = (runtime, runId) => {
    let r = runs.get(runId);
    if (!r) {
      r = { runId, runtime, status: 'running', startedAt: new Date().toISOString() };
      runs.set(runId, r);
    }
    return r;
  };
  const trim = () => {
    let ended = [...runs.values()].filter((r) => r.status === 'ended');
    while (ended.length > KEEP_ENDED) { runs.delete(ended[0].runId); ended = ended.slice(1); }
  };

  /** What a run's event says about the run. */
  function observe(runtime, payload) {
    const runId = payload && typeof payload.runId === 'string' ? payload.runId : null;
    const event = payload && payload.event;
    if (!runId || !event || typeof event.type !== 'string') return;
    const r = record(runtime, runId);
    switch (event.type) {
      case 'session':
        if (typeof event.sessionId === 'string' && event.sessionId) r.sessionId = event.sessionId;
        if (typeof event.sessionFile === 'string' && event.sessionFile) r.sessionFile = event.sessionFile;
        break;
      case 'turn':
        if (typeof event.turnId === 'string' && event.turnId) r.turnId = event.turnId;
        break;
      case 'run_end':
        r.status = 'ended';
        r.how = typeof event.how === 'string' ? event.how : 'end';
        r.endedAt = new Date().toISOString();
        if (typeof event.turnId === 'string' && event.turnId) r.turnId = event.turnId;
        r.held = event.held === true;
        trim();
        break;
      default:
        break;
    }
  }

  return {
    bootId,
    /** A run the host started: on record before its first event. */
    started: (runtime, runId) => { record(runtime, runId); },
    /** The sink a runtime emits into: recorded, then passed on. */
    relay: (runtime, sink) => (payload) => { observe(runtime, payload); sink(payload); },
    /** Every run on record, with the boot they belong to. */
    list: () => ({ bootId, runs: [...runs.values()].map((r) => ({ ...r })) }),
  };
}

module.exports = { createRunRegistry };
