import {
    GitHubCheckState,
    GitHubReviewState,
    MergeStepKey,
    MergeStepState,
    PaneStatus,
    type FolderInfo,
} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    calculateMergeSteps,
    isAnyMergeStepFailed,
    isAnyMergeStepLoading,
    mergeStepDefinitions,
} from './merge-steps.js';

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

const openPr: NonNullable<FolderInfo['pr']> = {
    url: 'https://github.com/owner/name/pull/1',
    isDraft: false,
    merged: false,
    checks: GitHubCheckState.Success,
    reviewDecision: GitHubReviewState.Pending,
    hasMergeConflicts: false,
};

function folder(overrides: Readonly<Partial<FolderInfo>>): FolderInfo {
    return {
        ...baseFolder,
        ...overrides,
    };
}

function stateOf(info: Readonly<FolderInfo>, key: MergeStepKey): MergeStepState {
    const step = calculateMergeSteps(info).find((candidate) => candidate.key === key);
    assert.isDefined(step, `no step for ${key}`);
    return step.state;
}

describe(calculateMergeSteps.name, () => {
    it('returns every defined step, in definition order', () => {
        assert.deepEquals(
            calculateMergeSteps(baseFolder).map((step) => step.key),
            mergeStepDefinitions.map((definition) => definition.key),
        );
    });

    describe(MergeStepKey.AiGenerating, () => {
        it('is loading while the AI pane is busy and done once it settles', () => {
            assert.deepEquals(
                {
                    busy: stateOf(
                        folder({
                            panes: {
                                ai: PaneStatus.Busy,
                                shell: PaneStatus.None,
                            },
                        }),
                        MergeStepKey.AiGenerating,
                    ),
                    idle: stateOf(baseFolder, MergeStepKey.AiGenerating),
                },
                {
                    busy: MergeStepState.Loading,
                    idle: MergeStepState.Done,
                },
            );
        });
    });

    describe(MergeStepKey.SelfQa, () => {
        it('is done once the stored flag is set', () => {
            assert.strictEquals(
                stateOf(
                    folder({
                        mergeStepValues: {
                            [MergeStepKey.SelfQa]: true,
                        },
                    }),
                    MergeStepKey.SelfQa,
                ),
                MergeStepState.Done,
            );
        });

        it('masks the stored flag while the tree is dirty, and restores it when clean again', () => {
            const dirty = folder({
                git: {
                    dirty: true,
                    notPushed: false,
                },
                mergeStepValues: {
                    [MergeStepKey.SelfQa]: true,
                },
            });
            assert.strictEquals(stateOf(dirty, MergeStepKey.SelfQa), MergeStepState.Todo);
            /**
             * The masking must not clear the stored value: going clean again has to restore the
             * checkmark rather than force the user to re-attest.
             */
            assert.strictEquals(
                stateOf(
                    folder({
                        mergeStepValues: dirty.mergeStepValues,
                    }),
                    MergeStepKey.SelfQa,
                ),
                MergeStepState.Done,
            );
        });
    });

    describe(MergeStepKey.SelfReview, () => {
        it('is done when the reviewed commit is still checked out', () => {
            assert.strictEquals(
                stateOf(
                    folder({
                        mergeStepValues: {
                            [MergeStepKey.SelfReview]: true,
                        },
                        lastReviewedSha: 'commit-1',
                    }),
                    MergeStepKey.SelfReview,
                ),
                MergeStepState.Done,
            );
        });

        it('expires once the branch moves past the reviewed commit', () => {
            assert.strictEquals(
                stateOf(
                    folder({
                        localCommitHash: 'commit-2',
                        mergeStepValues: {
                            [MergeStepKey.SelfReview]: true,
                        },
                        lastReviewedSha: 'commit-1',
                    }),
                    MergeStepKey.SelfReview,
                ),
                MergeStepState.Todo,
            );
        });
    });

    describe('PR steps', () => {
        it('reads a draft PR as draft-opened but not opened', () => {
            const draft = folder({
                pr: {
                    ...openPr,
                    isDraft: true,
                },
            });
            assert.deepEquals(
                {
                    draft: stateOf(draft, MergeStepKey.DraftPr),
                    opened: stateOf(draft, MergeStepKey.PrOpened),
                },
                {
                    draft: MergeStepState.Done,
                    opened: MergeStepState.Todo,
                },
            );
        });

        it('maps every check rollup state onto the matching step state', () => {
            assert.deepEquals(
                [
                    GitHubCheckState.Success,
                    GitHubCheckState.Pending,
                    GitHubCheckState.Failure,
                    GitHubCheckState.None,
                ].map((checks) =>
                    stateOf(
                        folder({
                            pr: {
                                ...openPr,
                                checks,
                            },
                        }),
                        MergeStepKey.CiPassing,
                    ),
                ),
                [
                    MergeStepState.Done,
                    MergeStepState.Loading,
                    MergeStepState.Failed,
                    MergeStepState.Todo,
                ],
            );
        });

        it('fails the approval step on requested changes and on merge conflicts', () => {
            assert.deepEquals(
                {
                    changesRequested: stateOf(
                        folder({
                            pr: {
                                ...openPr,
                                reviewDecision: GitHubReviewState.ChangesRequested,
                            },
                        }),
                        MergeStepKey.Approved,
                    ),
                    conflicting: stateOf(
                        folder({
                            pr: {
                                ...openPr,
                                hasMergeConflicts: true,
                            },
                        }),
                        MergeStepKey.Approved,
                    ),
                    waiting: stateOf(
                        folder({
                            pr: openPr,
                        }),
                        MergeStepKey.Approved,
                    ),
                },
                {
                    changesRequested: MergeStepState.Failed,
                    conflicting: MergeStepState.Failed,
                    waiting: MergeStepState.Loading,
                },
            );
        });
    });

    describe('dependsOn gating', () => {
        it('renders no alarming state on a branch with no PR at all', () => {
            const states = calculateMergeSteps(baseFolder)
                .filter((step) =>
                    [
                        MergeStepKey.CiPassing,
                        MergeStepKey.Approved,
                        MergeStepKey.Merged,
                    ].includes(step.key),
                )
                .map((step) => step.state);
            assert.deepEquals(states, [
                MergeStepState.Todo,
                MergeStepState.Todo,
                MergeStepState.Todo,
            ]);
        });

        it('keeps the approval step quiet while the PR is still a draft', () => {
            assert.strictEquals(
                stateOf(
                    folder({
                        pr: {
                            ...openPr,
                            isDraft: true,
                            hasMergeConflicts: true,
                        },
                    }),
                    MergeStepKey.Approved,
                ),
                MergeStepState.Todo,
            );
        });
    });

    describe('precedence', () => {
        it('reads a merged PR as done throughout, even with red checks behind it', () => {
            const merged = folder({
                pr: {
                    ...openPr,
                    merged: true,
                    checks: GitHubCheckState.Failure,
                    reviewDecision: GitHubReviewState.Pending,
                },
            });
            assert.deepEquals(
                {
                    merged: stateOf(merged, MergeStepKey.Merged),
                    approved: stateOf(merged, MergeStepKey.Approved),
                },
                {
                    merged: MergeStepState.Done,
                    approved: MergeStepState.Done,
                },
            );
        });
    });
});

describe(isAnyMergeStepLoading.name, () => {
    it('is true while CI runs and false once everything has landed', () => {
        assert.deepEquals(
            {
                running: isAnyMergeStepLoading(
                    folder({
                        pr: {
                            ...openPr,
                            checks: GitHubCheckState.Pending,
                        },
                    }),
                ),
                landed: isAnyMergeStepLoading(
                    folder({
                        pr: {
                            ...openPr,
                            merged: true,
                        },
                    }),
                ),
            },
            {
                running: true,
                landed: false,
            },
        );
    });

    it('is true while the AI pane is still generating', () => {
        assert.isTrue(
            isAnyMergeStepLoading(
                folder({
                    panes: {
                        ai: PaneStatus.Busy,
                        shell: PaneStatus.None,
                    },
                }),
            ),
        );
    });
});

describe(isAnyMergeStepFailed.name, () => {
    it('is true for failing CI and false for a branch with no PR', () => {
        assert.deepEquals(
            {
                failing: isAnyMergeStepFailed(
                    folder({
                        pr: {
                            ...openPr,
                            checks: GitHubCheckState.Failure,
                        },
                    }),
                ),
                noPr: isAnyMergeStepFailed(baseFolder),
            },
            {
                failing: true,
                noPr: false,
            },
        );
    });
});
