import {
    GitHubCheckState,
    GitHubReviewState,
    MergeStepKey,
    MergeStepState,
    PaneStatus,
    type FolderInfo,
    type ManualMergeStepKey,
} from '@agent-storm/common';

/**
 * What clicking a step (or a button in its popover) should do. These are identifiers rather than
 * callbacks so this module stays pure and directly testable — the element maps each one onto an
 * actual event dispatch.
 */
export enum MergeStepAction {
    /** Toggle the step's stored attestation flag. */
    ToggleStored = 'toggleStored',
    OpenDiffTab = 'openDiffTab',
    OpenGitHubTab = 'openGitHubTab',
}

export type MergeStepPopoverAction = {
    label: string;
    action: MergeStepAction;
};

type MergeStepDefinition = {
    key: MergeStepKey;
    todoLabel: string;
    doneLabel: string;
    /**
     * Present only on manual attestation steps. When set, the step's done-ness comes from
     * `folder.mergeStepValues[storageKey]` rather than from observed state.
     */
    storageKey?: ManualMergeStepKey;
    calculate: (folder: Readonly<FolderInfo>) => boolean;
    loading?: (folder: Readonly<FolderInfo>) => boolean;
    failed?: (folder: Readonly<FolderInfo>) => boolean;
    /**
     * Hides a stored attestation without clearing it — uncommitted changes mask the self-QA
     * checkmark, and it comes back when the tree is clean again instead of forcing a re-click.
     */
    invalidate?: (folder: Readonly<FolderInfo>) => boolean;
    /**
     * Steps that must be done before this one is allowed to show anything but a not-yet-started
     * state. Without this a branch with no PR would render red conflict and failure states for work
     * that hasn't begun.
     */
    dependsOn?: ReadonlyArray<MergeStepKey>;
    popoverActions?: ReadonlyArray<MergeStepPopoverAction>;
};

export type MergeStep = {
    key: MergeStepKey;
    label: string;
    state: MergeStepState;
    popoverActions: ReadonlyArray<MergeStepPopoverAction>;
    /** Set only for manual steps, so the element knows which flag a toggle would write. */
    storageKey: ManualMergeStepKey | undefined;
};

function hasStoredFlag(folder: Readonly<FolderInfo>, key: MergeStepKey): boolean {
    return !!folder.mergeStepValues[key];
}

/** The PR is live enough that review outcomes are meaningful. */
function isPrUnderReview(folder: Readonly<FolderInfo>): boolean {
    return !!folder.pr && !folder.pr.isDraft && !folder.pr.merged;
}

export const mergeStepDefinitions: ReadonlyArray<MergeStepDefinition> = [
    {
        key: MergeStepKey.AiGenerating,
        todoLabel: 'AI generating',
        doneLabel: 'AI done',
        /**
         * Anything other than `Busy` counts as finished, including a pane that was never started:
         * plenty of worktrees are hand-edited, and those shouldn't stall at step one forever.
         */
        calculate: (folder) => folder.panes.ai !== PaneStatus.Busy,
        loading: (folder) => folder.panes.ai === PaneStatus.Busy,
    },
    {
        key: MergeStepKey.SelfQa,
        storageKey: MergeStepKey.SelfQa,
        todoLabel: 'Self-QA',
        doneLabel: 'Self-QA done',
        calculate: (folder) => hasStoredFlag(folder, MergeStepKey.SelfQa),
        invalidate: (folder) => folder.git.dirty,
        popoverActions: [
            {
                label: 'Mark as QA’d',
                action: MergeStepAction.ToggleStored,
            },
        ],
    },
    {
        key: MergeStepKey.SelfReview,
        storageKey: MergeStepKey.SelfReview,
        todoLabel: 'Self-review',
        doneLabel: 'Self-reviewed',
        calculate: (folder) => hasStoredFlag(folder, MergeStepKey.SelfReview),
        /**
         * A review of an older commit says nothing about the code that's checked out now, so the
         * attestation expires when the branch moves. `lastReviewedSha` being null means the flag
         * predates SHA tracking; treat that as expired rather than trusting it.
         */
        invalidate: (folder) =>
            folder.git.dirty || folder.lastReviewedSha !== folder.localCommitHash,
        popoverActions: [
            {
                label: 'Open Diff tab',
                action: MergeStepAction.OpenDiffTab,
            },
            {
                label: 'Mark as reviewed',
                action: MergeStepAction.ToggleStored,
            },
        ],
    },
    {
        key: MergeStepKey.DraftPr,
        todoLabel: 'Open a draft PR',
        doneLabel: 'Draft PR opened',
        calculate: (folder) => !!folder.pr,
        popoverActions: [
            {
                label: 'Open GitHub tab',
                action: MergeStepAction.OpenGitHubTab,
            },
        ],
    },
    {
        key: MergeStepKey.PrOpened,
        todoLabel: 'Mark ready for review',
        doneLabel: 'PR open',
        calculate: (folder) => !!folder.pr && !folder.pr.isDraft,
        dependsOn: [MergeStepKey.DraftPr],
        popoverActions: [
            {
                label: 'Open GitHub tab',
                action: MergeStepAction.OpenGitHubTab,
            },
        ],
    },
    {
        key: MergeStepKey.CiPassing,
        todoLabel: 'CI',
        doneLabel: 'CI passing',
        calculate: (folder) => folder.pr?.checks === GitHubCheckState.Success,
        loading: (folder) => folder.pr?.checks === GitHubCheckState.Pending,
        failed: (folder) => folder.pr?.checks === GitHubCheckState.Failure,
        dependsOn: [MergeStepKey.DraftPr],
        popoverActions: [
            {
                label: 'Open GitHub tab',
                action: MergeStepAction.OpenGitHubTab,
            },
        ],
    },
    {
        key: MergeStepKey.Approved,
        todoLabel: 'Approval',
        doneLabel: 'Approved',
        calculate: (folder) =>
            folder.pr?.reviewDecision === GitHubReviewState.Approved || !!folder.pr?.merged,
        /** An open non-draft PR is, by definition, waiting on somebody. */
        loading: isPrUnderReview,
        /**
         * Merge conflicts land here rather than on their own step: both this and "changes
         * requested" mean the same thing to the user — the PR is blocked on work only they can do.
         */
        failed: (folder) =>
            folder.pr?.reviewDecision === GitHubReviewState.ChangesRequested ||
            !!folder.pr?.hasMergeConflicts,
        dependsOn: [MergeStepKey.PrOpened],
        popoverActions: [
            {
                label: 'Open GitHub tab',
                action: MergeStepAction.OpenGitHubTab,
            },
        ],
    },
    {
        key: MergeStepKey.Merged,
        todoLabel: 'Merge',
        doneLabel: 'Merged',
        calculate: (folder) => !!folder.pr?.merged,
        dependsOn: [MergeStepKey.PrOpened],
    },
];

function calculateState(
    definition: Readonly<MergeStepDefinition>,
    folder: Readonly<FolderInfo>,
    doneKeys: ReadonlySet<MergeStepKey>,
): MergeStepState {
    const isDone = definition.calculate(folder) && !definition.invalidate?.(folder);
    if (isDone) {
        return MergeStepState.Done;
    } else if (!(definition.dependsOn || []).every((key) => doneKeys.has(key))) {
        /** Work that hasn't begun yet reads as not-yet-started, never failed or in progress. */
        return MergeStepState.Todo;
    } else if (definition.failed?.(folder)) {
        return MergeStepState.Failed;
    } else if (definition.loading?.(folder)) {
        return MergeStepState.Loading;
    } else {
        return MergeStepState.Todo;
    }
}

/**
 * Evaluate every merge step for one folder, in render order. Definitions are ordered so that a
 * step's `dependsOn` targets always precede it, which lets one forward pass resolve the gating.
 */
export function calculateMergeSteps(folder: Readonly<FolderInfo>): MergeStep[] {
    const doneKeys = new Set<MergeStepKey>();
    return mergeStepDefinitions.map((definition) => {
        const state = calculateState(definition, folder, doneKeys);
        if (state === MergeStepState.Done) {
            doneKeys.add(definition.key);
        }
        return {
            key: definition.key,
            label: state === MergeStepState.Done ? definition.doneLabel : definition.todoLabel,
            state,
            popoverActions: definition.popoverActions || [],
            storageKey: definition.storageKey,
        };
    });
}

/**
 * Shared with the sidebar's status grouping, which reserves its "Needs attention" section for the
 * states that are genuinely on the user.
 */
export function isAnyMergeStepFailed(folder: Readonly<FolderInfo>): boolean {
    return calculateMergeSteps(folder).some((step) => step.state === MergeStepState.Failed);
}
