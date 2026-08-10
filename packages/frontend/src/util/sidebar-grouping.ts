import {PaneStatus, type FolderInfo} from '@agent-storm/common';
import {isAnyMergeStepFailed} from './merge-steps.js';

/**
 * The three sections the sidebar splits folders into under `SidebarGrouping.Status`. Ordered as
 * they render: what is stalled on you, what somebody else has the ball on, and what you set aside.
 */
export enum StatusBucket {
    NeedsAttention = 'needsAttention',
    /** Waiting on the AI or on a reviewer — nothing here is yours to move. */
    Waiting = 'waiting',
    DoLater = 'doLater',
}

export const statusBucketOrder: ReadonlyArray<StatusBucket> = [
    StatusBucket.NeedsAttention,
    StatusBucket.Waiting,
    StatusBucket.DoLater,
];

export const statusBucketLabels: Record<StatusBucket, string> = {
    [StatusBucket.NeedsAttention]: 'Needs attention',
    [StatusBucket.Waiting]: 'Waiting',
    [StatusBucket.DoLater]: 'Do later',
};

/**
 * Which section one folder belongs in.
 *
 * The dividing question is who holds the ball. Waiting means somebody else does — the AI is
 * mid-run, or a PR is sitting with a reviewer — and nothing there will move faster for your looking
 * at it. Everything else is stalled until you act, which includes the cases that are easy to
 * mistake for progress: a worktree with no PR opened yet, a PR with changes requested, red CI,
 * merge conflicts, and a merged PR whose worktree still wants cleaning up.
 *
 * Parking outranks all of it, since that is your own explicit call rather than something inferred.
 */
export function bucketFolder({
    folder,
    needsAttention,
}: Readonly<{
    folder: Readonly<FolderInfo>;
    needsAttention: boolean;
}>): StatusBucket {
    if (folder.isParked) {
        return StatusBucket.DoLater;
    } else if (needsAttention || isAnyMergeStepFailed(folder)) {
        /**
         * `isAnyMergeStepFailed` is what covers changes-requested, failing CI and merge conflicts.
         * It deliberately outranks a busy AI pane: a run in flight cannot clear a reviewer's
         * verdict, so a folder in that state is still waiting on you.
         */
        return StatusBucket.NeedsAttention;
    } else if (folder.panes.ai === PaneStatus.Busy) {
        return StatusBucket.Waiting;
    } else if (folder.pr && !folder.pr.merged) {
        /** A live PR with nothing wrong is with its reviewer, whether or not CI has finished. */
        return StatusBucket.Waiting;
    } else {
        return StatusBucket.NeedsAttention;
    }
}

/**
 * Split already-filtered folders into the three status sections, each sorted with the sidebar's
 * active comparator so "Sort by name" / "Sort by date" keep working inside the grouping.
 *
 * The one departure from a plain sort: folders in `attentionFolders` (the notification feature's
 * "AI pane is waiting on you" set) float to the top of needs-attention. That set is a live,
 * unambiguous signal and burying it alphabetically among stalled worktrees would waste it.
 */
export function bucketFoldersByStatus({
    folders,
    attentionFolders,
    comparator,
}: Readonly<{
    folders: ReadonlyArray<FolderInfo>;
    attentionFolders: ReadonlySet<string>;
    comparator: (a: FolderInfo, b: FolderInfo) => number;
}>): Record<StatusBucket, FolderInfo[]> {
    const buckets: Record<StatusBucket, FolderInfo[]> = {
        [StatusBucket.NeedsAttention]: [],
        [StatusBucket.Waiting]: [],
        [StatusBucket.DoLater]: [],
    };
    folders.forEach((folder) => {
        buckets[
            bucketFolder({
                folder,
                needsAttention: attentionFolders.has(folder.path),
            })
        ].push(folder);
    });
    statusBucketOrder.forEach((bucket) => {
        buckets[bucket].sort(comparator);
    });
    buckets[StatusBucket.NeedsAttention].sort(
        (a, b) => Number(attentionFolders.has(b.path)) - Number(attentionFolders.has(a.path)),
    );
    return buckets;
}
