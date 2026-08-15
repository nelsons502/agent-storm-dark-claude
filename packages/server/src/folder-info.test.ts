import {
    folderInfoShape,
    GitHubCheckState,
    GitHubReviewState,
    PaneKind,
    PaneStatus,
    type FolderInfo,
    type RepoConfig,
} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {checkValidShape} from 'object-shape-tester';
import {
    computeRepoPrRefreshTtlByRepo,
    fillNullableFolderInfoFields,
    folderGitRefreshIntervalMs,
    isFolderGitRefreshDue,
} from './folder-info.js';

const nowMs = 1_800_000_000_000;
const minuteMs = 60 * 1000;
const dayMs = 24 * 60 * minuteMs;

const hotTtlMs = 5 * minuteMs;
const coldTtlMs = 30 * minuteMs;

const repoPath = '/repos/solo';
const rootPath = '/repos/root';
const worktreePath = '/repos/root/branch-a';

/** No pane anywhere, which is the interesting case: every decision falls to config. */
const noLivePanes = () => PaneStatus.None;

const noPrHistory: ReadonlySet<string> = new Set();

const noMergeSteps = {
    doneSteps: [],
    lastReviewedSha: null,
};

function soloRepoTarget() {
    return {
        folder: repoPath,
        parentRepoPath: null,
        createdAtMs: 0,
        isWorktreeRoot: false,
        isParked: false,
        aiHidden: false,
        agentProfileId: 'profile',
        mergeSteps: noMergeSteps,
    };
}

function worktreeTargets() {
    return [
        {
            folder: rootPath,
            parentRepoPath: null,
            createdAtMs: 0,
            isWorktreeRoot: true,
            isParked: false,
            aiHidden: false,
            agentProfileId: 'profile',
            mergeSteps: noMergeSteps,
        },
        {
            folder: worktreePath,
            parentRepoPath: rootPath,
            createdAtMs: 0,
            isWorktreeRoot: false,
            isParked: false,
            aiHidden: false,
            agentProfileId: 'profile',
            mergeSteps: noMergeSteps,
        },
    ];
}

function repoConfig(lastInteractedAtMs: number): RepoConfig {
    return {
        path: repoPath,
        postWorktreeCmd: null,
        lastInteractedAtMs,
    };
}

/** Untouched for two months — inactive by every measure. */
const staleRepoConfig = repoConfig(nowMs - 60 * dayMs);

describe(computeRepoPrRefreshTtlByRepo.name, () => {
    it('skips a plain repo with no worktrees that has never shown a PR', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: [soloRepoTarget()],
            statusLookup: noLivePanes,
            repos: [staleRepoConfig],
            onlyShowRecent: false,
            everHadPrPaths: noPrHistory,
            nowMs,
        });
        assert.isUndefined(ttlByRepo.get(repoPath));
    });

    it('polls that same repo once it has shown a PR before', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: [soloRepoTarget()],
            statusLookup: noLivePanes,
            repos: [staleRepoConfig],
            onlyShowRecent: false,
            everHadPrPaths: new Set([repoPath]),
            nowMs,
        });
        assert.strictEquals(ttlByRepo.get(repoPath), coldTtlMs);
    });

    it('polls a never-PR repo while it is active, so a first PR can be discovered', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: [soloRepoTarget()],
            statusLookup: (folder, kind) =>
                folder === repoPath && kind === PaneKind.Ai ? PaneStatus.Idle : PaneStatus.None,
            repos: [staleRepoConfig],
            onlyShowRecent: false,
            everHadPrPaths: noPrHistory,
            nowMs,
        });
        assert.strictEquals(ttlByRepo.get(repoPath), hotTtlMs);
    });

    it('treats a recent activation as active even with no pane running', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: [soloRepoTarget()],
            statusLookup: noLivePanes,
            repos: [repoConfig(nowMs - 2 * minuteMs)],
            onlyShowRecent: false,
            everHadPrPaths: noPrHistory,
            nowMs,
        });
        assert.strictEquals(ttlByRepo.get(repoPath), hotTtlMs);
    });

    it('polls a worktree group that has never shown a PR', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: worktreeTargets(),
            statusLookup: noLivePanes,
            repos: [],
            onlyShowRecent: true,
            everHadPrPaths: noPrHistory,
            nowMs,
        });
        assert.deepEquals(Array.from(ttlByRepo.entries()), [
            [
                rootPath,
                coldTtlMs,
            ],
        ]);
    });

    it('makes a whole worktree group hot when any one of its folders is live', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: worktreeTargets(),
            statusLookup: (folder) => (folder === worktreePath ? PaneStatus.Busy : PaneStatus.None),
            repos: [],
            onlyShowRecent: false,
            everHadPrPaths: noPrHistory,
            nowMs,
        });
        assert.strictEquals(ttlByRepo.get(rootPath), hotTtlMs);
    });

    it('skips a PR-having repo that the sidebar is hiding', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: [soloRepoTarget()],
            statusLookup: noLivePanes,
            repos: [staleRepoConfig],
            onlyShowRecent: true,
            everHadPrPaths: new Set([repoPath]),
            nowMs,
        });
        assert.isUndefined(ttlByRepo.get(repoPath));
    });
});

/**
 * `loadPersistedCache` validates every entry against the current shape and drops mismatches, which
 * is the entire migration story for a `FolderInfo` field addition. These assert that the guard
 * actually rejects a row written before the `pr` block existed — if `folderInfoShape` ever became
 * permissive about missing fields, old rows would survive and the sidebar would read `undefined`
 * where it expects a PR state.
 */
describe('persisted folder info migration', () => {
    const currentEntry: FolderInfo = {
        path: repoPath,
        name: 'solo',
        parentRepoPath: null,
        createdAtMs: 0,
        isWorktreeRoot: false,
        isParked: false,
        aiHidden: false,
        agentProfileId: 'global-profile',
        branch: 'main',
        git: {
            dirty: false,
            notPushed: false,
        },
        prUrl: null,
        prMerged: false,
        pr: null,
        localCommitHash: null,
        mergeStepValues: {},
        lastReviewedSha: null,
        panes: {
            ai: PaneStatus.None,
            shell: PaneStatus.None,
        },
    };

    it('accepts an entry written by this build', () => {
        assert.isTrue(checkValidShape(currentEntry, folderInfoShape));
    });

    it('requires the resolved agent profile id in current folder cache entries', () => {
        const {agentProfileId: _agentProfileId, ...shared} = currentEntry;
        const commandEntry = {
            ...shared,
            aiCmd: 'legacy command',
            resetAiSessionCmd: 'legacy fresh command',
        } as unknown as FolderInfo;

        assert.deepEquals(
            {
                profileEntry: checkValidShape(currentEntry, folderInfoShape),
                commandEntry: checkValidShape(commandEntry, folderInfoShape),
            },
            {
                profileEntry: true,
                commandEntry: false,
            },
        );
    });

    it('fills in nullable fields an entry written before the PR block is missing', () => {
        const {pr, localCommitHash, ...legacyEntry} = currentEntry;
        /**
         * A `nullableShape` field is satisfied by `undefined`, so shape validation alone does not
         * drop this row — which is exactly why the fill step exists.
         */
        assert.isTrue(checkValidShape(legacyEntry, folderInfoShape));
        assert.deepEquals(fillNullableFolderInfoFields(legacyEntry as FolderInfo), currentEntry);
    });

    it('drops an entry written before the parked flag existed', () => {
        const {isParked, ...legacyEntry} = currentEntry;
        /**
         * Unlike the nullable PR fields above, `isParked` is a plain boolean, so a row from an
         * older build fails validation outright and `loadPersistedCache` discards it. That is the
         * intended migration path: the next sweep refills the row rather than us guessing a parked
         * state.
         */
        assert.isFalse(checkValidShape(legacyEntry, folderInfoShape));
    });

    it('accepts a fully populated PR block', () => {
        assert.isTrue(
            checkValidShape(
                {
                    ...currentEntry,
                    prUrl: 'https://github.com/owner/name/pull/1',
                    pr: {
                        url: 'https://github.com/owner/name/pull/1',
                        isDraft: false,
                        merged: false,
                        checks: GitHubCheckState.Pending,
                        reviewDecision: GitHubReviewState.ChangesRequested,
                        hasMergeConflicts: false,
                    },
                    localCommitHash: 'abc123',
                },
                folderInfoShape,
            ),
        );
    });
});

describe(folderGitRefreshIntervalMs.name, () => {
    it('refreshes a folder with a live pane most often', () => {
        assert.isBelow(
            folderGitRefreshIntervalMs({
                isParked: false,
                hasLivePane: true,
            }),
            folderGitRefreshIntervalMs({
                isParked: false,
                hasLivePane: false,
            }),
        );
    });

    it('backs off hardest on parked folders', () => {
        assert.isAbove(
            folderGitRefreshIntervalMs({
                isParked: true,
                hasLivePane: false,
            }),
            folderGitRefreshIntervalMs({
                isParked: false,
                hasLivePane: false,
            }),
        );
    });

    it('treats a parked folder with a live pane as active', () => {
        /**
         * Parking hides a folder from the sidebar, but a live pane means the user is driving it
         * from the terminal regardless, so its git state still needs to keep up.
         */
        assert.strictEquals(
            folderGitRefreshIntervalMs({
                isParked: true,
                hasLivePane: true,
            }),
            folderGitRefreshIntervalMs({
                isParked: false,
                hasLivePane: true,
            }),
        );
    });
});

describe(isFolderGitRefreshDue.name, () => {
    it('is due when never refreshed', () => {
        assert.isTrue(
            isFolderGitRefreshDue({
                isParked: false,
                hasLivePane: false,
                lastRefreshedAtMs: undefined,
                nowMs,
            }),
        );
    });

    it('is not due immediately after a refresh', () => {
        assert.isFalse(
            isFolderGitRefreshDue({
                isParked: false,
                hasLivePane: false,
                lastRefreshedAtMs: nowMs,
                nowMs,
            }),
        );
    });

    it('is due once the folder-specific interval has elapsed', () => {
        const interval = folderGitRefreshIntervalMs({
            isParked: false,
            hasLivePane: false,
        });
        assert.isTrue(
            isFolderGitRefreshDue({
                isParked: false,
                hasLivePane: false,
                lastRefreshedAtMs: nowMs - interval,
                nowMs,
            }),
        );
    });

    it('holds a parked folder back well past an idle folder deadline', () => {
        const idleInterval = folderGitRefreshIntervalMs({
            isParked: false,
            hasLivePane: false,
        });
        const shared = {
            hasLivePane: false,
            lastRefreshedAtMs: nowMs - idleInterval,
            nowMs,
        } as const;
        assert.isTrue(
            isFolderGitRefreshDue({
                ...shared,
                isParked: false,
            }),
        );
        assert.isFalse(
            isFolderGitRefreshDue({
                ...shared,
                isParked: true,
            }),
        );
    });
});
