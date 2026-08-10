import {
    GitHubCheckState,
    GitHubReviewState,
    PaneStatus,
    type FolderInfo,
} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {bucketFolder, bucketFoldersByStatus, StatusBucket} from './sidebar-grouping.js';

const baseFolder: FolderInfo = {
    path: '/repos/root/feature',
    name: 'feature',
    parentRepoPath: '/repos/root',
    createdAtMs: 0,
    isWorktreeRoot: false,
    isParked: false,
    aiHidden: false,
    aiCmd: '',
    resetAiSessionCmd: '',
    branch: 'feature',
    git: {
        dirty: false,
        notPushed: false,
    },
    prUrl: null,
    prMerged: false,
    pr: null,
    localCommitHash: 'commit-1',
    mergeStepValues: {},
    lastReviewedSha: null,
    panes: {
        ai: PaneStatus.Idle,
        shell: PaneStatus.None,
    },
};

function folder(overrides: Readonly<Partial<FolderInfo>>): FolderInfo {
    return {
        ...baseFolder,
        ...overrides,
    };
}

/** A PR whose CI has failed, which puts the CI step into `failed`. */
const failingPr: NonNullable<FolderInfo['pr']> = {
    url: 'https://github.com/owner/name/pull/1',
    isDraft: false,
    merged: false,
    checks: GitHubCheckState.Failure,
    reviewDecision: GitHubReviewState.Pending,
    hasMergeConflicts: false,
};

/** A comparator's two same-type parameters are the whole point of the signature. */
// eslint-disable-next-line @virmator/prefer-params-object
const nameComparator = (a: FolderInfo, b: FolderInfo): number => a.name.localeCompare(b.name);

/** An open PR with green CI and no verdict yet: the reviewer has the ball. */
const healthyPr: NonNullable<FolderInfo['pr']> = {
    url: 'https://github.com/owner/name/pull/1',
    isDraft: false,
    merged: false,
    checks: GitHubCheckState.Success,
    reviewDecision: GitHubReviewState.Pending,
    hasMergeConflicts: false,
};

const busyAi = {
    ai: PaneStatus.Busy,
    shell: PaneStatus.None,
} as const;

describe(bucketFolder.name, () => {
    it('parks a folder regardless of any other signal', () => {
        assert.deepEquals(
            {
                parkedAndBusy: bucketFolder({
                    folder: folder({
                        isParked: true,
                        panes: busyAi,
                    }),
                    needsAttention: true,
                }),
                parkedAndFailing: bucketFolder({
                    folder: folder({
                        isParked: true,
                        pr: failingPr,
                    }),
                    needsAttention: false,
                }),
            },
            {
                parkedAndBusy: StatusBucket.DoLater,
                parkedAndFailing: StatusBucket.DoLater,
            },
        );
    });

    describe('waiting on someone else', () => {
        it('waits while the AI is actively running, even with no PR yet', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: folder({
                        panes: busyAi,
                    }),
                    needsAttention: false,
                }),
                StatusBucket.Waiting,
            );
        });

        it('waits on a healthy open PR even once the AI has gone idle', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: folder({
                        pr: healthyPr,
                    }),
                    needsAttention: false,
                }),
                StatusBucket.Waiting,
            );
        });

        it('waits while CI is still running', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: folder({
                        pr: {
                            ...healthyPr,
                            checks: GitHubCheckState.Pending,
                        },
                    }),
                    needsAttention: false,
                }),
                StatusBucket.Waiting,
            );
        });

        it('waits on an approved PR that has not been merged yet', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: folder({
                        pr: {
                            ...healthyPr,
                            reviewDecision: GitHubReviewState.Approved,
                        },
                    }),
                    needsAttention: false,
                }),
                StatusBucket.Waiting,
            );
        });

        it('waits on a draft PR, since the AI or CI is still shaping it', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: folder({
                        pr: {
                            ...healthyPr,
                            isDraft: true,
                        },
                    }),
                    needsAttention: false,
                }),
                StatusBucket.Waiting,
            );
        });
    });

    describe('stalled until you act', () => {
        it('flags a worktree that has no PR yet and no AI running', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: baseFolder,
                    needsAttention: false,
                }),
                StatusBucket.NeedsAttention,
            );
        });

        it('flags changes requested', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: folder({
                        pr: {
                            ...healthyPr,
                            reviewDecision: GitHubReviewState.ChangesRequested,
                        },
                    }),
                    needsAttention: false,
                }),
                StatusBucket.NeedsAttention,
            );
        });

        it('flags failing CI, which no reviewer can move past', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: folder({
                        pr: failingPr,
                    }),
                    needsAttention: false,
                }),
                StatusBucket.NeedsAttention,
            );
        });

        it('flags merge conflicts', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: folder({
                        pr: {
                            ...healthyPr,
                            hasMergeConflicts: true,
                        },
                    }),
                    needsAttention: false,
                }),
                StatusBucket.NeedsAttention,
            );
        });

        /** Merged means the branch is done; the only remaining move — cleaning it up — is yours. */
        it('flags a merged PR, whose worktree now needs disposing of', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: folder({
                        pr: {
                            ...healthyPr,
                            merged: true,
                        },
                    }),
                    needsAttention: false,
                }),
                StatusBucket.NeedsAttention,
            );
        });

        it('flags an attention-flagged folder even while the AI is running', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: folder({
                        panes: busyAi,
                    }),
                    needsAttention: true,
                }),
                StatusBucket.NeedsAttention,
            );
        });

        /** A blocked PR outranks a busy pane: the AI cannot review its own changes-requested. */
        it('flags changes requested even while the AI is running', () => {
            assert.strictEquals(
                bucketFolder({
                    folder: folder({
                        panes: busyAi,
                        pr: {
                            ...healthyPr,
                            reviewDecision: GitHubReviewState.ChangesRequested,
                        },
                    }),
                    needsAttention: false,
                }),
                StatusBucket.NeedsAttention,
            );
        });
    });
});

describe(bucketFoldersByStatus.name, () => {
    it('sorts each bucket with the given comparator', () => {
        const buckets = bucketFoldersByStatus({
            folders: [
                folder({
                    path: '/repos/root/zeta',
                    name: 'zeta',
                    pr: healthyPr,
                }),
                folder({
                    path: '/repos/root/alpha',
                    name: 'alpha',
                    pr: healthyPr,
                }),
                folder({
                    path: '/repos/root/parked-z',
                    name: 'parked-z',
                    isParked: true,
                }),
                folder({
                    path: '/repos/root/parked-a',
                    name: 'parked-a',
                    isParked: true,
                }),
            ],
            attentionFolders: new Set<string>(),
            comparator: nameComparator,
        });

        assert.deepEquals(
            {
                waiting: buckets[StatusBucket.Waiting].map((entry) => entry.name),
                doLater: buckets[StatusBucket.DoLater].map((entry) => entry.name),
            },
            {
                waiting: [
                    'alpha',
                    'zeta',
                ],
                doLater: [
                    'parked-a',
                    'parked-z',
                ],
            },
        );
    });

    it('floats attention folders above the rest of needs-attention', () => {
        /** All three land in needs-attention via a failed step, so only the float is under test. */
        const buckets = bucketFoldersByStatus({
            folders: [
                folder({
                    path: '/repos/root/alpha',
                    name: 'alpha',
                    pr: failingPr,
                }),
                folder({
                    path: '/repos/root/zeta',
                    name: 'zeta',
                    pr: failingPr,
                }),
                folder({
                    path: '/repos/root/middle',
                    name: 'middle',
                    pr: failingPr,
                }),
            ],
            attentionFolders: new Set(['/repos/root/zeta']),
            comparator: nameComparator,
        });

        assert.deepEquals(
            buckets[StatusBucket.NeedsAttention].map((entry) => entry.name),
            [
                'zeta',
                'alpha',
                'middle',
            ],
        );
    });

    it('returns empty arrays rather than omitting buckets, so callers can render nothing', () => {
        const buckets = bucketFoldersByStatus({
            folders: [],
            attentionFolders: new Set<string>(),
            comparator: nameComparator,
        });

        assert.deepEquals(
            {
                needsAttention: buckets[StatusBucket.NeedsAttention],
                waiting: buckets[StatusBucket.Waiting],
                doLater: buckets[StatusBucket.DoLater],
            },
            {
                needsAttention: [],
                waiting: [],
                doLater: [],
            },
        );
    });

    it('keeps every input folder in exactly one bucket', () => {
        const folders = [
            baseFolder,
            folder({
                path: '/repos/root/busy',
                name: 'busy',
                panes: {
                    ai: PaneStatus.Busy,
                    shell: PaneStatus.None,
                },
            }),
            folder({
                path: '/repos/root/parked',
                name: 'parked',
                isParked: true,
            }),
        ];
        const buckets = bucketFoldersByStatus({
            folders,
            attentionFolders: new Set<string>(),
            comparator: nameComparator,
        });

        assert.strictEquals(
            Object.values(buckets).flat().length,
            folders.length,
            'a folder was dropped or duplicated',
        );
    });
});
