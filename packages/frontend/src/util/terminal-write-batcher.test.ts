import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {createTerminalWriteBatcher} from './terminal-write-batcher.js';

/** A stand-in for `requestAnimationFrame` whose frames the test drives explicitly. */
function manualScheduler() {
    const queued: (() => void)[] = [];
    return {
        schedule: (callback: () => void) => queued.push(callback),
        runFrame() {
            const toRun = queued.splice(0, queued.length);
            toRun.forEach((callback) => callback());
        },
        pendingFrames: () => queued.length,
    };
}

describe(createTerminalWriteBatcher.name, () => {
    it('writes nothing before a frame runs', () => {
        const scheduler = manualScheduler();
        const writes: string[] = [];
        const batcher = createTerminalWriteBatcher({
            write: (data) => writes.push(data),
            schedule: scheduler.schedule,
        });
        batcher.push('a');
        assert.deepEquals(writes, []);
    });

    it('collapses many pushes in one frame into a single write', () => {
        const scheduler = manualScheduler();
        const writes: string[] = [];
        const batcher = createTerminalWriteBatcher({
            write: (data) => writes.push(data),
            schedule: scheduler.schedule,
        });
        batcher.push('one ');
        batcher.push('two ');
        batcher.push('three');
        scheduler.runFrame();
        assert.deepEquals(writes, ['one two three']);
    });

    it('schedules only one frame per burst', () => {
        const scheduler = manualScheduler();
        const batcher = createTerminalWriteBatcher({
            write: () => undefined,
            schedule: scheduler.schedule,
        });
        batcher.push('a');
        batcher.push('b');
        batcher.push('c');
        assert.strictEquals(scheduler.pendingFrames(), 1);
    });

    it('preserves byte order across frames', () => {
        const scheduler = manualScheduler();
        const writes: string[] = [];
        const batcher = createTerminalWriteBatcher({
            write: (data) => writes.push(data),
            schedule: scheduler.schedule,
        });
        batcher.push('first');
        scheduler.runFrame();
        batcher.push('second');
        scheduler.runFrame();
        assert.strictEquals(writes.join(''), 'firstsecond');
    });

    it('does not write when nothing was queued', () => {
        const scheduler = manualScheduler();
        const writes: string[] = [];
        const batcher = createTerminalWriteBatcher({
            write: (data) => writes.push(data),
            schedule: scheduler.schedule,
        });
        batcher.push('a');
        scheduler.runFrame();
        scheduler.runFrame();
        assert.deepEquals(writes, ['a']);
    });

    it('flushes synchronously on demand', () => {
        const scheduler = manualScheduler();
        const writes: string[] = [];
        const batcher = createTerminalWriteBatcher({
            write: (data) => writes.push(data),
            schedule: scheduler.schedule,
        });
        batcher.push('urgent');
        batcher.flush();
        assert.deepEquals(writes, ['urgent']);
    });

    it('drops queued data and ignores later pushes once disposed', () => {
        const scheduler = manualScheduler();
        const writes: string[] = [];
        const batcher = createTerminalWriteBatcher({
            write: (data) => writes.push(data),
            schedule: scheduler.schedule,
        });
        batcher.push('queued');
        batcher.dispose();
        scheduler.runFrame();
        batcher.push('after');
        scheduler.runFrame();
        /**
         * Writing into a disposed terminal is the bug this guards: the flush callback can outlive
         * the element that owns the xterm instance.
         */
        assert.deepEquals(writes, []);
    });
});
