import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {type GhExecResult} from './git.js';
import {clearReviewRequestedCache, fetchReviewRequestedCount} from './review-requested.js';

const nowMs = 1_800_000_000_000;
const minuteMs = 60 * 1000;

const pollingEnabled = () => Promise.resolve(false);

function countRunner(total: number): {
    runner: () => Promise<GhExecResult>;
    calls: () => number;
} {
    const state = {
        calls: 0,
    };
    return {
        calls: () => state.calls,
        runner: () => {
            state.calls++;
            return Promise.resolve({
                exitCode: 0,
                stdout: `${total}\n`,
                stderr: '',
            });
        },
    };
}

describe(fetchReviewRequestedCount.name, () => {
    it('serves the cached count for the rest of the TTL', async () => {
        clearReviewRequestedCache();
        const {runner, calls} = countRunner(3);

        const first = await fetchReviewRequestedCount({
            ghRunner: runner,
            isPollingDisabled: pollingEnabled,
            nowMs,
        });
        const second = await fetchReviewRequestedCount({
            ghRunner: runner,
            isPollingDisabled: pollingEnabled,
            nowMs: nowMs + 4 * minuteMs,
        });

        assert.deepEquals(
            [
                first,
                second,
                calls(),
            ],
            [
                3,
                3,
                1,
            ],
        );
    });

    it('refetches once the TTL has passed', async () => {
        clearReviewRequestedCache();
        const {runner, calls} = countRunner(3);

        await fetchReviewRequestedCount({
            ghRunner: runner,
            isPollingDisabled: pollingEnabled,
            nowMs,
        });
        await fetchReviewRequestedCount({
            ghRunner: runner,
            isPollingDisabled: pollingEnabled,
            nowMs: nowMs + 6 * minuteMs,
        });

        assert.strictEquals(calls(), 2);
    });

    it('shares one GitHub call between concurrent callers', async () => {
        clearReviewRequestedCache();
        const {runner, calls} = countRunner(3);

        const results = await Promise.all([
            fetchReviewRequestedCount({
                ghRunner: runner,
                isPollingDisabled: pollingEnabled,
                nowMs,
            }),
            fetchReviewRequestedCount({
                ghRunner: runner,
                isPollingDisabled: pollingEnabled,
                nowMs,
            }),
        ]);

        assert.deepEquals(
            results,
            [
                3,
                3,
            ],
        );
        assert.strictEquals(calls(), 1);
    });

    it('forces a fresh call inside the TTL, after any in-flight call finishes', async () => {
        clearReviewRequestedCache();
        const {runner, calls} = countRunner(3);

        const background = fetchReviewRequestedCount({
            ghRunner: runner,
            isPollingDisabled: pollingEnabled,
            nowMs,
        });
        const forced = fetchReviewRequestedCount({
            ghRunner: runner,
            isPollingDisabled: pollingEnabled,
            forceRefresh: true,
            nowMs,
        });

        await background;
        await forced;

        /**
         * Two calls, not one: a forced refresh exists to see current state, so sharing the
         * in-flight result would defeat it. It waits for that call rather than racing it.
         */
        assert.strictEquals(calls(), 2);
    });

    it('reports an unknown count rather than zero when gh fails', async () => {
        clearReviewRequestedCache();

        const failed = await fetchReviewRequestedCount({
            ghRunner: () =>
                Promise.resolve({
                    exitCode: 1,
                    stdout: '',
                    stderr: 'HTTP 403',
                }),
            isPollingDisabled: pollingEnabled,
            nowMs,
        });

        assert.isNull(failed);
    });

    it('reports an unknown count when the output is not a number', async () => {
        clearReviewRequestedCache();

        const unparseable = await fetchReviewRequestedCount({
            ghRunner: () =>
                Promise.resolve({
                    exitCode: 0,
                    stdout: 'not a number',
                    stderr: '',
                }),
            isPollingDisabled: pollingEnabled,
            nowMs,
        });

        assert.isNull(unparseable);
    });

    it('never calls gh while GitHub polling is disabled', async () => {
        clearReviewRequestedCache();
        const {runner, calls} = countRunner(3);

        const result = await fetchReviewRequestedCount({
            ghRunner: runner,
            isPollingDisabled: () => Promise.resolve(true),
            nowMs,
        });

        assert.isNull(result);
        assert.strictEquals(calls(), 0);
    });
});
