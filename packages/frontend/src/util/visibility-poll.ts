/**
 * Run the given callback now, then repeatedly — but only while the document is visible.
 *
 * A backgrounded or minimized window has nobody looking at it, so polling it spends backend work
 * and garbage on data that will be re-fetched the moment it comes back anyway. On becoming visible
 * the callback fires immediately rather than waiting out a fresh interval, since whatever is on
 * screen is as stale as the time the tab spent hidden.
 *
 * @returns A teardown that stops the interval and detaches the visibility listener.
 */
export function startVisibilityAwarePoll(
    options: Readonly<{
        intervalMs: number;
        callback: () => void;
        /**
         * Injectable for tests. Defaults to the real document; anything with the visibility bits of
         * the `Document` interface works.
         */
        target?: VisibilityPollTarget;
    }>,
): () => void {
    const target = options.target ?? document;
    /** Held on an object so the handle can be reassigned without a module-level `let`. */
    const handle: {current: ReturnType<typeof setInterval> | undefined} = {
        current: undefined,
    };

    function stop(): void {
        if (handle.current !== undefined) {
            clearInterval(handle.current);
            handle.current = undefined;
        }
    }

    function start(): void {
        if (handle.current === undefined) {
            handle.current = setInterval(options.callback, options.intervalMs);
        }
    }

    function onVisibilityChange(): void {
        if (target.hidden) {
            stop();
        } else {
            options.callback();
            start();
        }
    }

    options.callback();
    if (!target.hidden) {
        start();
    }
    target.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
        target.removeEventListener('visibilitychange', onVisibilityChange);
        stop();
    };
}

/** The slice of `Document` that {@link startVisibilityAwarePoll} needs. */
export type VisibilityPollTarget = {
    hidden: boolean;
    addEventListener: (type: 'visibilitychange', listener: () => void) => void;
    removeEventListener: (type: 'visibilitychange', listener: () => void) => void;
};
