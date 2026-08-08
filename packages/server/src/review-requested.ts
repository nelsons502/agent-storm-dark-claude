import {loadConfig} from './config.js';
import {isGitHubPollingSuspended} from './folder-info.js';
import {runGh, type GhExecResult} from './git.js';

type GhRunner = (args: ReadonlyArray<string>) => Promise<GhExecResult>;

/**
 * How long one count is served back without asking GitHub again. The sidebar polls every couple of
 * seconds, so without a TTL this would spend the entire search-API budget (30 requests/minute) many
 * times over. Five minutes keeps us at ~12 requests/hour while still noticing a new review request
 * well inside the time it takes to act on one.
 */
const cacheTtlMs = 5 * 60 * 1000;

/**
 * The one search query behind the count. `review-requested:@me` is resolved by GitHub from the
 * token, so this works without knowing the user's login. `archived:false` keeps dead repos from
 * inflating a number the user can't act on. `--jq` reduces the response to the bare total, since
 * the matching issues themselves are never rendered — clicking the button opens github.com.
 */
const searchArgs: ReadonlyArray<string> = [
    'api',
    '-X',
    'GET',
    'search/issues',
    '-f',
    'q=is:open is:pr review-requested:@me archived:false',
    '--jq',
    '.total_count',
];

/**
 * `count: undefined` means "never fetched"; `null` means "fetched and failed", which is cached like
 * any other answer so a broken `gh` doesn't turn every sidebar poll into a subprocess spawn.
 * `inFlight` is what lets concurrent callers (several browser tabs polling at once) share one
 * call.
 */
const cache: {
    count: number | null | undefined;
    fetchedAt: number;
    inFlight: Promise<number | null> | undefined;
} = {
    count: undefined,
    fetchedAt: 0,
    inFlight: undefined,
};

/** Test-only. The cache is module state, so cases would otherwise leak counts into each other. */
export function clearReviewRequestedCache(): void {
    cache.count = undefined;
    cache.fetchedAt = 0;
    cache.inFlight = undefined;
}

/**
 * Both GitHub kill-switches, in the cheap order: the in-memory auto-disable state first, the config
 * file only if that passes.
 */
async function isPollingDisabledByDefault(): Promise<boolean> {
    if (isGitHubPollingSuspended()) {
        return true;
    }
    const config = await loadConfig().catch(() => undefined);
    return !!config?.disabledGitHubPolling;
}

/**
 * How many open PRs across all of GitHub have you as a requested reviewer, or null when that can't
 * be known right now — `gh` missing, unauthenticated, rate-limited, polling disabled, or an
 * unexpected response. Null is deliberately distinct from `0`: the sidebar hides the button on null
 * and would otherwise assert "nothing needs your review" on no evidence.
 *
 * `nowMs`, `ghRunner`, and `isPollingDisabled` are injectable for tests; production callers pass
 * only `forceRefresh`.
 */
export function fetchReviewRequestedCount(
    options: Readonly<{
        forceRefresh?: boolean | undefined;
        ghRunner?: GhRunner | undefined;
        nowMs?: number | undefined;
        isPollingDisabled?: (() => Promise<boolean>) | undefined;
    }> = {},
): Promise<number | null> {
    const now = options.nowMs ?? Date.now();
    if (!options.forceRefresh) {
        if (cache.inFlight) {
            return cache.inFlight;
        } else if (cache.count !== undefined && now - cache.fetchedAt < cacheTtlMs) {
            return Promise.resolve(cache.count);
        }
    }
    /**
     * Captured before the reassignment below so a forced refresh can wait on the call it's
     * superseding instead of overlapping with it.
     */
    const prior = cache.inFlight;
    const pending = runFetch({
        prior,
        now,
        ghRunner: options.ghRunner || runGh,
        isPollingDisabled: options.isPollingDisabled || isPollingDisabledByDefault,
    });
    cache.inFlight = pending;
    /**
     * Only clear the slot if it still holds this call. A forced refresh started while this one was
     * running already replaced it, and clearing then would strand that newer call unshared.
     * `runFetch` never rejects, so this can't leave an unhandled rejection behind.
     */
    void pending.finally(() => {
        if (cache.inFlight === pending) {
            cache.inFlight = undefined;
        }
    });
    return pending;
}

async function runFetch({
    prior,
    now,
    ghRunner,
    isPollingDisabled,
}: Readonly<{
    prior: Promise<number | null> | undefined;
    now: number;
    ghRunner: GhRunner;
    isPollingDisabled: () => Promise<boolean>;
}>): Promise<number | null> {
    try {
        if (prior) {
            await prior.catch(() => undefined);
        }
        if (await isPollingDisabled()) {
            /** Not cached: the switch can flip back on at any time, and null isn't an answer. */
            return null;
        }
        const count = await queryCount(ghRunner);
        cache.count = count;
        cache.fetchedAt = now;
        return count;
    } catch {
        return null;
    }
}

async function queryCount(ghRunner: GhRunner): Promise<number | null> {
    const result = await ghRunner(searchArgs);
    if (result.exitCode !== 0) {
        return null;
    }
    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
