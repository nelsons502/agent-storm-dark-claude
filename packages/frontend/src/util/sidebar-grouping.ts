import {type FolderInfo} from '@agent-storm/common';
import {isAnyMergeStepFailed, isAnyMergeStepLoading} from './merge-steps.js';

/**
 * The three sections the sidebar splits folders into under `SidebarGrouping.Status`. Ordered as
 * they render: what you have to deal with, what is running without you, and what you have
 * explicitly set aside.
 */
export enum StatusBucket {
    NeedsAttention = 'needsAttention',
    Working = 'working',
    DoLater = 'doLater',
}

export const statusBucketOrder: ReadonlyArray<StatusBucket> = [
    StatusBucket.NeedsAttention,
    StatusBucket.Working,
    StatusBucket.DoLater,
];

export const statusBucketLabels: Record<StatusBucket, string> = {
    [StatusBucket.NeedsAttention]: 'Needs attention',
    [StatusBucket.Working]: 'Working',
    [StatusBucket.DoLater]: 'Do later',
};

/**
 * Which section one folder belongs in.
 *
 * Precedence matters more than the individual rules: parking is an explicit user decision and so
 * outranks everything the app inferred; an attention flag or a failed merge step means the folder
 * is blocked on the user even if something is also still running; and anything left over that isn't
 * visibly working lands in needs-attention, because "nothing is happening and nobody has looked at
 * it" is exactly the state this view exists to surface.
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
        return StatusBucket.NeedsAttention;
    } else if (isAnyMergeStepLoading(folder)) {
        return StatusBucket.Working;
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
        [StatusBucket.Working]: [],
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
