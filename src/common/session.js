/**
 * The session model: a list of timed subsections plus the timing state.
 *
 * Elapsed time is derived from a wall-clock stamp rather than accumulated by a
 * tick handler, so a throttled tab, a sleeping laptop or a slow frame never
 * makes the countdown drift.
 */
(function (root) {
  const CAT = (root.CAT = root.CAT || {});
  const { STATUS } = CAT;

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  function makeSegment(name, seconds) {
    return {
      id: uid(),
      name: String(name || 'Subsection').trim().slice(0, 160),
      seconds: Math.max(1, Math.round(seconds || 0))
    };
  }

  function createSession(activity, segments, meta) {
    const clean = (segments || [])
      .map((s) => makeSegment(s.name, s.seconds))
      .filter((s) => s.seconds > 0);
    return Object.assign(
      {
        id: uid(),
        activity: String(activity || 'Activity').trim().slice(0, 200),
        segments: clean,
        status: STATUS.IDLE,
        elapsed: 0,
        startedAt: null,
        createdAt: Date.now(),
        finishedAt: null,
        url: null,
        tabId: null
      },
      meta || {}
    );
  }

  function totalSeconds(session) {
    if (!session || !session.segments) return 0;
    return session.segments.reduce((sum, s) => sum + s.seconds, 0);
  }

  /** Cumulative start offset of each segment, plus the grand total. */
  function boundaries(session) {
    const out = [];
    let acc = 0;
    for (const segment of session.segments) {
      out.push({ start: acc, end: acc + segment.seconds });
      acc += segment.seconds;
    }
    return out;
  }

  /**
   * Everything a renderer needs for one frame, derived from `now` so all
   * surfaces (overlay, popup, badge) agree without passing ticks around.
   */
  function progress(session, now) {
    const nowMs = now || Date.now();
    const total = totalSeconds(session);
    const running = session.status === STATUS.RUNNING && session.startedAt;
    const raw = session.elapsed + (running ? (nowMs - session.startedAt) / 1000 : 0);
    const elapsed = Math.min(Math.max(raw, 0), total);
    const remaining = Math.max(0, total - elapsed);

    const bounds = boundaries(session);
    let index = bounds.findIndex((b) => elapsed < b.end);
    if (index === -1) index = Math.max(0, session.segments.length - 1);

    const bound = bounds[index] || { start: 0, end: 0 };
    const segment = session.segments[index] || null;
    const segmentElapsed = Math.min(Math.max(elapsed - bound.start, 0), segment ? segment.seconds : 0);
    const segmentRemaining = segment ? Math.max(0, segment.seconds - segmentElapsed) : 0;

    return {
      total,
      elapsed,
      remaining,
      index,
      segment,
      segmentElapsed,
      segmentRemaining,
      segmentFraction: segment && segment.seconds ? segmentElapsed / segment.seconds : 0,
      fraction: total ? elapsed / total : 0,
      overdue: total > 0 && raw >= total,
      isRunning: session.status === STATUS.RUNNING,
      isFinished: session.status === STATUS.FINISHED || (total > 0 && raw >= total)
    };
  }

  /** Freezes elapsed into the record — called before any state change. */
  function settle(session, now) {
    const nowMs = now || Date.now();
    if (session.status === STATUS.RUNNING && session.startedAt) {
      const total = totalSeconds(session);
      session.elapsed = Math.min(session.elapsed + (nowMs - session.startedAt) / 1000, total);
      session.startedAt = nowMs;
    }
    return session;
  }

  function start(session, now) {
    const nowMs = now || Date.now();
    session.status = STATUS.RUNNING;
    session.startedAt = nowMs;
    session.finishedAt = null;
    return session;
  }

  function pause(session, now) {
    settle(session, now);
    session.status = STATUS.PAUSED;
    session.startedAt = null;
    return session;
  }

  function resume(session, now) {
    if (session.status === STATUS.RUNNING) return session;
    const nowMs = now || Date.now();
    if (session.status === STATUS.FINISHED && session.elapsed >= totalSeconds(session)) {
      session.elapsed = 0;
    }
    session.status = STATUS.RUNNING;
    session.startedAt = nowMs;
    session.finishedAt = null;
    return session;
  }

  function reset(session) {
    session.status = STATUS.IDLE;
    session.elapsed = 0;
    session.startedAt = null;
    session.finishedAt = null;
    return session;
  }

  function finish(session, now) {
    settle(session, now);
    session.elapsed = totalSeconds(session);
    session.status = STATUS.FINISHED;
    session.startedAt = null;
    session.finishedAt = now || Date.now();
    return session;
  }

  /**
   * Adds (or removes) time on the subsection now running. Removing more than
   * the subsection has left simply ends it; the rest of the plan is untouched,
   * so the total shifts by exactly what was applied.
   */
  function nudge(session, deltaSeconds, now) {
    settle(session, now);
    const state = progress(session, now);
    const segment = session.segments[state.index];
    if (!segment) return { session, applied: 0 };

    const floor = Math.max(1, Math.ceil(state.segmentElapsed));
    const next = Math.max(floor, segment.seconds + Math.round(deltaSeconds));
    const applied = next - segment.seconds;
    segment.seconds = next;

    // Re-opening a finished timer by adding time should let it run again.
    if (applied > 0 && session.status === STATUS.FINISHED) {
      session.status = STATUS.PAUSED;
      session.finishedAt = null;
    }
    return { session, applied };
  }

  /** Moves the playhead to the start of a subsection. */
  function jumpTo(session, index, now) {
    settle(session, now);
    const bounds = boundaries(session);
    const clamped = Math.min(Math.max(index, 0), Math.max(0, bounds.length - 1));
    session.elapsed = bounds.length ? bounds[clamped].start : 0;
    if (session.status === STATUS.FINISHED) {
      session.status = STATUS.PAUSED;
      session.finishedAt = null;
    }
    if (session.status === STATUS.RUNNING) session.startedAt = now || Date.now();
    return session;
  }

  /** Ends the current subsection early and moves to the next one. */
  function skip(session, now) {
    const state = progress(session, now);
    if (state.index >= session.segments.length - 1) return finish(session, now);
    return jumpTo(session, state.index + 1, now);
  }

  function previous(session, now) {
    const state = progress(session, now);
    // Within the first few seconds of a subsection, go to the one before it.
    const target = state.segmentElapsed > 3 ? state.index : state.index - 1;
    return jumpTo(session, Math.max(0, target), now);
  }

  /** Epoch ms at which the running timer hits zero, or null when not running. */
  function endsAt(session, now) {
    if (session.status !== STATUS.RUNNING) return null;
    const state = progress(session, now);
    return (now || Date.now()) + state.remaining * 1000;
  }

  CAT.session = {
    uid,
    makeSegment,
    createSession,
    totalSeconds,
    boundaries,
    progress,
    settle,
    start,
    pause,
    resume,
    reset,
    finish,
    nudge,
    jumpTo,
    skip,
    previous,
    endsAt
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
