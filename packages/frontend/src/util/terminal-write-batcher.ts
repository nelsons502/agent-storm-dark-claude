/**
 * Coalesce many small terminal writes into at most one write per scheduled frame.
 *
 * A busy Claude turn arrives as a long stream of small PTY chunks, and the socket handler used to
 * call `terminal.write` once per chunk. Each call carries its own parse and render-schedule
 * overhead, so a fast-scrolling turn spent far more time in xterm's pipeline than the same bytes
 * delivered in one piece — the classic per-chunk-write jank pattern. Concatenating whatever arrived
 * within a frame and writing it once keeps the byte stream identical while collapsing that
 * overhead.
 *
 * Order is preserved, which is why every write for a terminal must go through the batcher rather
 * than some paths calling `terminal.write` directly.
 */
export function createTerminalWriteBatcher(
    options: Readonly<{
        write: (data: string) => void;
        /**
         * Injectable for tests. Defaults to `requestAnimationFrame`, which paces flushes to the
         * display and naturally stops while the tab is backgrounded.
         */
        schedule?: (callback: () => void) => void;
    }>,
): TerminalWriteBatcher {
    const schedule =
        options.schedule ?? ((callback: () => void) => requestAnimationFrame(callback));
    /** Held on an object so these can be reassigned without module-level `let`. */
    const pending: {chunks: string[]; scheduled: boolean; disposed: boolean} = {
        chunks: [],
        scheduled: false,
        disposed: false,
    };

    function flush(): void {
        pending.scheduled = false;
        if (!pending.chunks.length || pending.disposed) {
            return;
        }
        const data = pending.chunks.join('');
        pending.chunks = [];
        options.write(data);
    }

    return {
        push(data: string): void {
            if (pending.disposed) {
                return;
            }
            pending.chunks.push(data);
            if (!pending.scheduled) {
                pending.scheduled = true;
                schedule(flush);
            }
        },
        flush,
        dispose(): void {
            pending.disposed = true;
            pending.chunks = [];
        },
    };
}

export type TerminalWriteBatcher = {
    /** Queue data for the next flush. */
    push: (data: string) => void;
    /** Write everything queued right now. */
    flush: () => void;
    /** Drop anything queued and ignore further pushes. */
    dispose: () => void;
};
