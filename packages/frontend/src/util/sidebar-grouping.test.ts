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

describe(bucketFolder.name, () => {
    it('parks a folder regardless of any other signal', () => {
        assert.deepEquals(
            {
                parkedAndBusy: bucketFolder({
                    folder: folder({
                        isParked: true,
                        panes: {
                            ai: PaneStatus.Busy,
                            shell: PaneStatus.None,
                        },
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

    it('puts an attention-flagged folder in needs-attention even while it is working', () => {
        assert.strictEquals(
            bucketFolder({
                folder: folder({
                    panes: {
                        ai: PaneStatus.Busy,
                        shell: PaneStatus.None,
                    },
                }),
                needsAttention: true,
            }),
            StatusBucket.NeedsAttention,
        );
    });

    it('puts a folder with a failed merge step in needs-attention', () => {
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

    it('puts a folder with a loading merge step in working', () => {
        assert.strictEquals(
            bucketFolder({
                folder: folder({
                    panes: {
                        ai: PaneStatus.Busy,
                        shell: PaneStatus.None,
                    },
                }),
                needsAttention: false,
            }),
            StatusBucket.Working,
        );
    });

    it('falls back to needs-attention for a folder that is neither working nor parked', () => {
        assert.strictEquals(
            bucketFolder({
                folder: baseFolder,
                needsAttention: false,
            }),
            StatusBucket.NeedsAttention,
        );
    });
});

describe(bucketFoldersByStatus.name, () => {
    it('sorts each bucket with the given comparator', () => {
        const buckets = bucketFoldersByStatus({
            folders: [
                folder({
                    path: '/repos/root/zeta',
                    name: 'zeta',
                }),
                folder({
                    path: '/repos/root/alpha',
                    name: 'alpha',
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
                needsAttention: buckets[StatusBucket.NeedsAttention].map((entry) => entry.name),
                doLater: buckets[StatusBucket.DoLater].map((entry) => entry.name),
            },
            {
                needsAttention: [
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
        const buckets = bucketFoldersByStatus({
            folders: [
                folder({
                    path: '/repos/root/alpha',
                    name: 'alpha',
                }),
                folder({
                    path: '/repos/root/zeta',
                    name: 'zeta',
                }),
                folder({
                    path: '/repos/root/middle',
                    name: 'middle',
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
                working: buckets[StatusBucket.Working],
                doLater: buckets[StatusBucket.DoLater],
            },
            {
                needsAttention: [],
                working: [],
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
