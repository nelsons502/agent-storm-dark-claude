import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {startVisibilityAwarePoll, type VisibilityPollTarget} from './visibility-poll.js';

/** A stand-in for `document` whose visibility can be driven from a test. */
function fakeTarget(startHidden = false) {
    const listeners = new Set<() => void>();
    const target = {
        hidden: startHidden,
        addEventListener(_type: 'visibilitychange', listener: () => void) {
            listeners.add(listener);
        },
        removeEventListener(_type: 'visibilitychange', listener: () => void) {
            listeners.delete(listener);
        },
    };
    return {
        target: target satisfies VisibilityPollTarget,
        listenerCount: () => listeners.size,
        setHidden(hidden: boolean) {
            target.hidden = hidden;
            listeners.forEach((listener) => listener());
        },
    };
}

describe(startVisibilityAwarePoll.name, () => {
    it('runs the callback once up front', () => {
        const fake = fakeTarget();
        const calls: number[] = [];
        const stop = startVisibilityAwarePoll({
            intervalMs: 10_000,
            callback: () => calls.push(1),
            target: fake.target,
        });
        assert.strictEquals(calls.length, 1);
        stop();
    });

    it('does not start an interval while hidden', async () => {
        const fake = fakeTarget(true);
        const calls: number[] = [];
        const stop = startVisibilityAwarePoll({
            intervalMs: 1,
            callback: () => calls.push(1),
            target: fake.target,
        });
        /**
         * The up-front call still happens — the point is that no repeating interval was armed, so
         * waiting out many interval periods adds nothing.
         */
        assert.strictEquals(calls.length, 1);
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEquals(calls.length, 1);
        stop();
    });

    it('polls repeatedly while visible', async () => {
        const fake = fakeTarget();
        const calls: number[] = [];
        const stop = startVisibilityAwarePoll({
            intervalMs: 1,
            callback: () => calls.push(1),
            target: fake.target,
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.isAbove(calls.length, 1);
        stop();
    });

    it('stops polling when the page becomes hidden', async () => {
        const fake = fakeTarget();
        const calls: number[] = [];
        const stop = startVisibilityAwarePoll({
            intervalMs: 1,
            callback: () => calls.push(1),
            target: fake.target,
        });
        await new Promise((resolve) => setTimeout(resolve, 15));
        fake.setHidden(true);
        const afterHiding = calls.length;
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEquals(calls.length, afterHiding);
        stop();
    });

    it('catches up immediately when the page becomes visible again', () => {
        const fake = fakeTarget();
        const calls: number[] = [];
        const stop = startVisibilityAwarePoll({
            intervalMs: 10_000,
            callback: () => calls.push(1),
            target: fake.target,
        });
        fake.setHidden(true);
        const afterHiding = calls.length;
        fake.setHidden(false);
        /**
         * Without the catch-up call the user would stare at data as old as the time the tab spent
         * hidden until a full interval elapsed.
         */
        assert.strictEquals(calls.length, afterHiding + 1);
        stop();
    });

    it('detaches its listener on teardown', () => {
        const fake = fakeTarget();
        const stop = startVisibilityAwarePoll({
            intervalMs: 10_000,
            callback: () => undefined,
            target: fake.target,
        });
        assert.strictEquals(fake.listenerCount(), 1);
        stop();
        assert.strictEquals(fake.listenerCount(), 0);
    });

    it('stops polling after teardown', async () => {
        const fake = fakeTarget();
        const calls: number[] = [];
        const stop = startVisibilityAwarePoll({
            intervalMs: 1,
            callback: () => calls.push(1),
            target: fake.target,
        });
        await new Promise((resolve) => setTimeout(resolve, 15));
        stop();
        const afterStop = calls.length;
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.strictEquals(calls.length, afterStop);
    });
});
