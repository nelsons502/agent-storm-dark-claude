import {PaneStatus, type FolderInfo} from '@agent-storm/common';
import {css, defineElement, defineElementEvent, html, listen} from 'element-vir';
import {parseUrl} from 'url-vir';
import {
    markWorktreeReviewed,
    setWorktreeMergeStep,
    stageTrivialHunks,
    startWorktreeTestServer,
} from '../../util/api-client.js';
import {openInVsCode} from '../../util/electron-bridge.js';

/**
 * Inputs evaluated for each step on every render. Mirrors `FolderInfo`'s merge-step fields plus
 * the per-step stored boolean. Steps with `storageKey: null` ignore `storedValue`.
 */
type MergeStepInputs = {
    storedValue: boolean | undefined;
    folderPath: string;
    hasUncommittedChanges: boolean;
    localCommitHash: string | null;
    branchCommitHash: string | null;
    lastReviewedSha: string | null;
    prUrl: string | null;
    prMerged: boolean;
    prIsDraft: boolean;
    prCiPassing: boolean | null;
    prCiInProgress: boolean;
    /**
     * Aggregated review-check status — drives the "Get approval" step in place of GitHub's
     * `reviewDecision`. See `folderInfoShape.prReviewCheckPassing` for semantics.
     */
    prReviewCheckPassing: boolean | null;
    prReviewCheckInProgress: boolean;
    prApproved: boolean;
    prReviewChangesRequested: boolean;
    prReviewPending: boolean;
    /** Mirror of `folderInfoShape.prHasUnresolvedReviewComments` — see that field for semantics. */
    prHasUnresolvedReviewComments: boolean;
    /** Current status of the worktree's AI pane. Drives the "AI generating" step. */
    aiPaneStatus: PaneStatus;
};

/**
 * Side-effect channels handed to a step's `onClick`. Steps wire one or more of these explicitly —
 * there's no implicit "click means toggle" anymore. Each step decides what its click does.
 */
type MergeStepActions = {
    /** Toggle the step's stored boolean. No-op when the step has `storageKey: null`. */
    toggleStored: () => void;
    /**
     * Open `prUrl` in a new tab (browser) or new in-app BrowserWindow (Electron). Silently
     * no-ops when `prUrl` is null or fails the github.com allow-list check.
     */
    /**
     * Ask the parent (vir-app) to embed `prUrl` fullscreen via vir-pr-embed. No-op when
     * `prUrl` is null or fails the github.com allow-list check.
     */
    embedPr: () => void;
    /** Launch VS Code on `folderPath` via the Electron bridge. No-op outside Electron. */
    openInVsCode: () => void;
    /**
     * Persist `lastReviewedSha` to the backend (writes through `/worktrees/mark-reviewed`).
     * `null` clears it. Fire-and-forget; failures land in the global client-error reporter.
     */
    setLastReviewedSha: (sha: string | null) => void;
    /**
     * Spin up (or reuse) the worktree's `npm start` and embed the detected frontend URL
     * fullscreen via the PR-embed overlay. Fires `prEmbedRequested` once the server reports
     * a port; failures land in the client-error reporter and a console message.
     */
    runTestLocally: () => void;
    /**
     * Run `scripts/stage-trivial-hunks.mjs` in the worktree and stage no-review-needed hunks
     * (whitespace, comment-only, import-only, lockfile-when-package-json-changed, css). The
     * script output is logged to the console; failures land in the client-error reporter.
     */
    stageTrivialHunks: () => void;
};

type MergeStepConfigValue = {
    /** Stable identifier used in aria/data attributes. */
    name: string;
    /** Label rendered when `calculate` returns false (or before invalidation). */
    todoLabel: string;
    /** Label rendered when `calculate` returns true. */
    doneLabel: string;
    /**
     * Optional list of `name`s this step depends on. The step is always rendered in the
     * stepper (so the user sees the upcoming work) but until *every* listed step's
     * `calculate` is currently true the node collapses to its plain unchecked state —
     * no checkmark, no red-exclam, no spinner, and it can't be the "current" focused
     * step. Example: "Reviewer approved" sits as a numbered grey circle until "Open PR"
     * is done, then resumes normal done/failed/loading rendering.
     */
    dependsOn?: ReadonlyArray<string>;
    /**
     * Where the per-step boolean lives in localStorage. Null means "derived" — the step's done
     * state is computed purely from inputs (PR state, CI rollup, etc.) and `storedValue` will be
     * undefined inside `calculate`. Non-null storage keys are namespaced under
     * `agent-storm:merge-step:<folder>:<storageKey>` so they're scoped per worktree.
     */
    storageKey: string | null;
    /**
     * Returns true if this step counts as done. Called on every render with fresh inputs.
     */
    calculate: (inputs: MergeStepInputs) => boolean;
    /**
     * Optional in-progress signal — when true (and the step is not already done or failed),
     * the node renders an animated spinner. Used by `pass-ci` while CI is running and
     * `get-approval` while reviewers are still pending.
     */
    loading?: (inputs: MergeStepInputs) => boolean;
    /**
     * Optional failure signal — when true (and the step is not already done), the node
     * renders a red exclamation mark instead of the step number. Used by `get-approval` when
     * the PR is actively blocked by `CHANGES_REQUESTED`. Takes precedence over `loading` so a
     * known failure doesn't get masked by a still-spinning indicator.
     */
    failed?: (inputs: MergeStepInputs) => boolean;
    /**
     * Optional invalidation: when true, the stored boolean is cleared right before `calculate`
     * runs. Lets self-QA / self-review auto-uncheck the instant uncommitted changes appear, or
     * the moment a new commit lands past the SHA the user reviewed. Steps without a
     * `storageKey` should leave this undefined.
     */
    invalidate?: (inputs: MergeStepInputs) => boolean;
    /**
     * Click handler. Fully explicit — replaces the default toggle. A pure-toggle step writes
     * `({}, {toggleStored}) => toggleStored()`; a derived "Open PR" step writes
     * `({}, {openPr}) => openPr()`.
     */
    onClick: (inputs: MergeStepInputs, actions: MergeStepActions) => void;
    /**
     * Optional hover-revealed menu. When provided, hovering (or focusing) the step renders a
     * popover with these entries; each entry is its own discrete action so a single click can't
     * accidentally fire two side-effects at once. Self-review (code) uses this to split
     * "mark reviewed" from "launch VS Code" — clicking the step itself is a no-op while the
     * popover is visible, so power-user actions stay opt-in.
     */
    popoverActions?: ReadonlyArray<{
        /**
         * Either a static label or a function that derives the label from current inputs.
         * The dynamic form lets a single popover entry surface different verbs depending on
         * state — e.g. "Mark as reviewed" vs "Unmark as reviewed" against `storedValue`.
         */
        label: string | ((inputs: MergeStepInputs) => string);
        onClick: (inputs: MergeStepInputs, actions: MergeStepActions) => void;
    }>;
};

export const mergeStepsConfig: ReadonlyArray<MergeStepConfigValue> = [
    {
        name: 'ai-generating',
        todoLabel: 'AI generating',
        doneLabel: 'AI idle',
        storageKey: null,
        // The step "passes" whenever Claude isn't actively rendering output — the worktree
        // is between AI turns and the user can move on to QA / review. There's no historical
        // "AI ever ran" signal, so a fresh worktree where Claude has never been launched
        // also reads as done; the loading state only kicks in once Claude actually starts
        // generating.
        calculate: ({aiPaneStatus}) => aiPaneStatus !== PaneStatus.Busy,
        loading: ({aiPaneStatus}) => aiPaneStatus === PaneStatus.Busy,
        onClick: () => {},
    },
    {
        name: 'ai-self-review',
        todoLabel: 'AI self-review',
        doneLabel: 'AI self-reviewed',
        storageKey: 'ai-self-review',
        calculate: ({storedValue}) => storedValue === true,
        // Same staleness rule as Self-QA: any uncommitted change means the AI's review was
        // against a different tree state. Mask (don't clear) so the checkmark restores once the
        // working tree goes clean again. Manual click for now — wired to toggle until an
        // automated AI-review action lands.
        invalidate: ({hasUncommittedChanges}) => hasUncommittedChanges,
        onClick: (_inputs, {toggleStored}) => toggleStored(),
    },
    {
        name: 'self-qa',
        todoLabel: 'Self-QA',
        doneLabel: 'Self-QA done',
        storageKey: 'self-qa',
        calculate: ({storedValue}) => storedValue === true,
        // Any local edit means the QA attestation was made against a different tree state —
        // mask the step on this render. The underlying boolean is preserved (see the
        // `invalidate` handling in the render loop), so the step un-masks the moment the
        // working tree goes clean again rather than forcing the user to re-click.
        invalidate: ({hasUncommittedChanges}) => hasUncommittedChanges,
        // Click is intercepted by the renderer to open the popover (popoverActions is
        // non-empty). Kept non-undefined to satisfy the type.
        onClick: () => {},
        popoverActions: [
            {
                label: (inputs) =>
                    inputs.storedValue === true ? 'Unmark as completed' : 'Mark as completed',
                onClick: (_inputs, {toggleStored}) => toggleStored(),
            },
            {
                label: 'Test locally',
                onClick: (_inputs, {runTestLocally}) => runTestLocally(),
            },
        ],
    },
    {
        name: 'self-review-code',
        todoLabel: 'Self-review (code)',
        doneLabel: 'Self-reviewed (code)',
        storageKey: 'self-review-code',
        calculate: ({storedValue}) => storedValue === true,
        // Mask (not clear) when either signal says the attestation is stale:
        //   1. Uncommitted changes — review was against a tree that no longer matches HEAD.
        //   2. HEAD moved past the SHA captured at the last check — new commits to review.
        // The stored boolean is preserved; if the user commits / resets back to the reviewed
        // SHA, the checkmark re-appears instead of having been silently wiped.
        invalidate: ({hasUncommittedChanges, localCommitHash, lastReviewedSha}) => {
            if (hasUncommittedChanges) {
                return true;
            }
            // Only invalidate on SHA mismatch when both sides are known; if we don't have a
            // local SHA yet (placeholder before first sweep) keep the prior state rather than
            // flipping it spuriously.
            if (lastReviewedSha && localCommitHash && lastReviewedSha !== localCommitHash) {
                return true;
            }
            return false;
        },
        // Click is intercepted by the renderer (when `popoverActions` is non-empty) to toggle
        // the popover. This handler is unreachable but kept non-undefined to satisfy the type.
        onClick: () => {},
        popoverActions: [
            {
                label: (inputs) =>
                    inputs.storedValue === true ? 'Unmark as reviewed' : 'Mark as reviewed',
                onClick: (inputs, {toggleStored, setLastReviewedSha}) => {
                    const wasDone = inputs.storedValue === true;
                    toggleStored();
                    // Anchor the new "reviewed" state to the SHA the user actually reviewed,
                    // or clear it on un-check so a stale SHA doesn't outlive the toggle.
                    setLastReviewedSha(wasDone ? null : inputs.localCommitHash);
                },
            },
            {
                label: 'Review code in IDE',
                onClick: (_inputs, {openInVsCode: openVsCode}) => openVsCode(),
            },
            {
                label: 'Stage trivial hunks',
                onClick: (_inputs, {stageTrivialHunks: stage}) => stage(),
            },
        ],
    },
    {
        name: 'open-draft-pr',
        todoLabel: 'Open draft PR',
        doneLabel: 'Draft PR opened',
        storageKey: null,
        // Done as soon as any PR URL appears. A non-draft PR also satisfies this — the user
        // skipped the draft phase, but the step still counts as crossed.
        calculate: ({prUrl}) => !!prUrl,
        onClick: (_inputs, {embedPr}) => embedPr(),
    },
    {
        name: 'open-pr',
        todoLabel: 'Open PR',
        doneLabel: 'PR opened',
        storageKey: null,
        // Done when the PR has been promoted out of draft state. Merged PRs naturally satisfy
        // this too — a merged PR is by definition no longer draft.
        calculate: ({prUrl, prIsDraft}) => !!prUrl && !prIsDraft,
        onClick: (_inputs, {embedPr}) => embedPr(),
    },
    {
        name: 'pass-ci',
        todoLabel: 'Pass CI',
        doneLabel: 'Passing CI',
        storageKey: null,
        calculate: ({prCiPassing}) => prCiPassing === true,
        // Spin while at least one check is still running. `failed` deliberately not set —
        // a `prCiPassing: false` is already a strong unchecked-and-not-loading signal, and
        // the user wants the explicit red-exclam treatment reserved for review changes
        // requested. (Easy to extend later if we want CI failures to also flag red.)
        loading: ({prCiInProgress}) => prCiInProgress,
        failed: ({prCiPassing}) => prCiPassing === false,
        onClick: (_inputs, {embedPr}) => embedPr(),
    },
    {
        name: 'get-approval',
        todoLabel: 'Get approval',
        doneLabel: 'Reviewer approved',
        // Approval state is meaningless until a real (non-draft) PR exists — hide the step
        // entirely until `open-pr` is done.
        dependsOn: ['open-pr'],
        // Driven by the review-check CI status, not GitHub's `reviewDecision`. The user's
        // repo gates approval through a CI check that excludes bot reviewers (Claude, Copilot,
        // etc.) the user doesn't care about — passing that check means every approver the
        // user *does* care about has signed off. Merged PRs satisfy this too so the step
        // doesn't appear unchecked on a PR that already shipped.
        storageKey: null,
        calculate: ({prReviewCheckPassing, prMerged}) => prReviewCheckPassing === true || prMerged,
        // Loading covers two cases: review check is mid-flight, OR the PR is open + non-draft
        // with no active block. A review check sitting in a not-yet-passing state because the
        // human just hasn't approved is NOT a failure — it's "still waiting". Done/failed
        // precedence in the render loop strips the loading state once approval lands or a
        // real block appears.
        loading: ({prUrl, prIsDraft}) => !!prUrl && !prIsDraft,
        // Red exclam only on user-actionable blocks:
        //   - `prReviewChangesRequested` — a reviewer explicitly requested changes and the
        //     author hasn't re-requested review.
        //   - `prHasUnresolvedReviewComments` — at least one inline review thread is still
        //     unresolved; the author has something to address before approval is reasonable.
        // A failing review-check on its own does NOT trigger this — that's just "not yet
        // approved" and belongs in the loading state.
        failed: ({prReviewChangesRequested, prHasUnresolvedReviewComments}) =>
            prReviewChangesRequested || prHasUnresolvedReviewComments,
        onClick: (_inputs, {embedPr}) => embedPr(),
    },
    {
        name: 'ready-to-merge',
        todoLabel: 'Ready to merge',
        doneLabel: 'Merged',
        storageKey: null,
        // Only meaningful once every prior step is done. Listing them explicitly keeps the
        // dependency wiring readable — a future reorder of the array won't silently change
        // which steps gate this one.
        dependsOn: [
            'ai-generating',
            'ai-self-review',
            'self-qa',
            'self-review-code',
            'open-draft-pr',
            'open-pr',
            'pass-ci',
            'get-approval',
        ],
        calculate: ({prMerged}) => prMerged,
        onClick: (_inputs, {embedPr}) => embedPr(),
    },
];

/**
 * Build the `MergeStepInputs` shape consumed by `calculate` / `invalidate` / `loading` / `failed`
 * for a given (folder, step) pair. Centralised so the renderer and the sidebar's
 * `isAnyMergeStepLoading` agree exactly on what each step sees — no chance for the two to
 * drift apart when a new field is added to `MergeStepInputs`.
 *
 * `optimisticStoredValue` lets the renderer overlay an in-flight optimistic toggle on top of the
 * server-reported stored value (clicked-but-not-yet-acked). Callers without that state (e.g.
 * the sidebar) pass undefined.
 */
export function buildMergeStepInputs(
    folder: FolderInfo,
    step: MergeStepConfigValue,
    optimisticStoredValue?: boolean,
): MergeStepInputs {
    const storedValue =
        step.storageKey != null
            ? (optimisticStoredValue ?? folder.mergeStepValues[step.storageKey])
            : undefined;
    const inputs: MergeStepInputs = {
        storedValue,
        folderPath: folder.path,
        hasUncommittedChanges: folder.hasUncommittedChanges,
        localCommitHash: folder.localCommitHash ?? null,
        branchCommitHash: folder.branchCommitHash ?? null,
        lastReviewedSha: folder.lastReviewedSha ?? null,
        prUrl: folder.prUrl ?? null,
        prMerged: folder.prMerged,
        prIsDraft: folder.prIsDraft,
        prCiPassing: folder.prCiPassing ?? null,
        prCiInProgress: folder.prCiInProgress,
        prReviewCheckPassing: folder.prReviewCheckPassing ?? null,
        prReviewCheckInProgress: folder.prReviewCheckInProgress,
        prApproved: folder.prApproved,
        prReviewChangesRequested: folder.prReviewChangesRequested,
        prReviewPending: folder.prReviewPending,
        prHasUnresolvedReviewComments: folder.prHasUnresolvedReviewComments,
        aiPaneStatus: folder.panes.ai,
    };
    // Match the renderer: `invalidate` masks the stored value for this evaluation (not
    // cleared on disk). Self-QA / self-review-code rely on this to un-check the moment
    // uncommitted changes appear, without permanently losing the user's attestation.
    if (step.storageKey != null && step.invalidate?.(inputs)) {
        inputs.storedValue = undefined;
    }
    return inputs;
}

/**
 * Compute the effective done / failed / loading state for a step against a folder, applying
 * the renderer's done > failed > loading precedence. The trio matches exactly what the user
 * sees on the corresponding step node in the progress tracker.
 */
export function evaluateMergeStep(
    folder: FolderInfo,
    step: MergeStepConfigValue,
    optimisticStoredValue?: boolean,
): {done: boolean; failed: boolean; loading: boolean} {
    const inputs = buildMergeStepInputs(folder, step, optimisticStoredValue);
    const done = step.calculate(inputs);
    const failed = !done && (step.failed?.(inputs) ?? false);
    const loading = !done && !failed && (step.loading?.(inputs) ?? false);
    return {done, failed, loading};
}

/**
 * Map each step name to its current done state for the given folder. Used to resolve
 * `dependsOn` for visibility — a step is shown iff every dep name maps to `done: true`.
 */
function buildDoneByName(folder: FolderInfo): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const step of mergeStepsConfig) {
        out[step.name] = evaluateMergeStep(folder, step).done;
    }
    return out;
}

/**
 * True iff every step in `step.dependsOn` is currently done. Unknown dep names resolve to
 * `false` so a typo hides the step rather than silently passing.
 */
function areStepDepsSatisfied(
    step: MergeStepConfigValue,
    doneByName: Readonly<Record<string, boolean>>,
): boolean {
    if (!step.dependsOn || step.dependsOn.length === 0) return true;
    return step.dependsOn.every((name) => doneByName[name] === true);
}

/**
 * True iff at least one merge-step whose dependencies are currently satisfied is rendering
 * as loading (spinner) for this folder. The sidebar uses this as the source of truth for
 * the Working / Needs-attention grouping. Deps-unmet steps don't render as loading even if
 * their underlying `loading` predicate is true, so they're skipped here for the same reason.
 */
export function isAnyMergeStepLoading(folder: FolderInfo): boolean {
    const doneByName = buildDoneByName(folder);
    return mergeStepsConfig.some((step) => {
        if (!areStepDepsSatisfied(step, doneByName)) return false;
        return evaluateMergeStep(folder, step).loading;
    });
}

/**
 * One-time best-effort cleanup of pre-backend per-step localStorage keys. Two generations exist:
 *   - `agent-storm:progress:*` (single-integer count, original implementation)
 *   - `agent-storm:merge-step:*` (per-step boolean, removed when storage moved to the backend)
 * Both are dropped on first render so they don't accumulate forever on returning clients.
 */
let legacyPruned = false;
function pruneLegacyProgressKeys(): void {
    if (legacyPruned) {
        return;
    }
    legacyPruned = true;
    try {
        const toRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (
                key &&
                (key.startsWith('agent-storm:progress:') ||
                    key.startsWith('agent-storm:merge-step:'))
            ) {
                toRemove.push(key);
            }
        }
        toRemove.forEach((key) => localStorage.removeItem(key));
    } catch {
        /* private mode / quota errors — non-fatal */
    }
}

/**
 * github.com-only allow-list. Used before we hand a `prUrl` to the embed overlay so a malformed
 * or non-GitHub URL never reaches the webview tag.
 */
function sanitizePrUrl(prUrl: string | null): string | null {
    if (!prUrl) {
        return null;
    }
    const parsed = parseUrl(prUrl);
    const isHttp = parsed.protocol === 'https' || parsed.protocol === 'http';
    if (!isHttp || parsed.hostname !== 'github.com') {
        return null;
    }
    return prUrl;
}

export const VirProgressTracker = defineElement<{
    folder: FolderInfo;
}>()({
    tagName: 'vir-progress-tracker',
    events: {
        /** Emitted when a PR-link step is clicked. Detail is the github.com-allowlisted URL. */
        prEmbedRequested: defineElementEvent<string>(),
    },
    state() {
        return {
            /**
             * Optimistic overrides for per-step booleans. Set the instant a popover toggle is
             * clicked so the checkmark flips visually with zero latency, even before the
             * backend has acknowledged the write or the next `/folders` poll has landed. The
             * entry is removed once the API call resolves (success OR failure) — on failure,
             * the UI snaps back to the server-side value and the parent's error reporter
             * surfaces the underlying problem.
             *
             * Keyed by storage key (the step's `name`), not folder path: this component is
             * unmounted/remounted as the active folder changes, so the override map is
             * already scoped to the current folder.
             */
            pendingMergeStepValues: {} as Record<string, boolean>,
            /**
             * Name of the step whose popover is currently open, or null when no popover is
             * showing. Popovers only open on explicit click (no hover); clicking the same step
             * again, picking a menu item, clicking outside, or pressing Escape closes them.
             */
            openPopoverStep: null as string | null,
            /** Document-level listener handles, kept so cleanup can detach them. */
            outsideClickListener: undefined as ((event: MouseEvent) => void) | undefined,
            keydownListener: undefined as ((event: KeyboardEvent) => void) | undefined,
        };
    },
    init({state, updateState, host}) {
        const outsideClickListener = (event: MouseEvent) => {
            if (!state.openPopoverStep) {
                return;
            }
            const path = event.composedPath();
            // composedPath crosses shadow boundaries — if the click is anywhere inside this
            // component, leave the popover state alone (the per-button handlers handle it);
            // otherwise close.
            if (path.includes(host)) {
                return;
            }
            updateState({openPopoverStep: null});
        };
        const keydownListener = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && state.openPopoverStep) {
                updateState({openPopoverStep: null});
            }
        };
        document.addEventListener('mousedown', outsideClickListener);
        document.addEventListener('keydown', keydownListener);
        updateState({outsideClickListener, keydownListener});
    },
    cleanup({state}) {
        if (state.outsideClickListener) {
            document.removeEventListener('mousedown', state.outsideClickListener);
        }
        if (state.keydownListener) {
            document.removeEventListener('keydown', state.keydownListener);
        }
    },
    styles: css`
        :host {
            display: block;
            padding: 14px 24px 16px;
            border-top: 1px solid var(--border);
            background: var(--bg-subtle);
            font-family: var(--font-body);
            flex-shrink: 0;
        }

        .stepper {
            position: relative;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }

        .track,
        .fill {
            position: absolute;
            top: 10px;
            height: 2px;
            border-radius: 1px;
            pointer-events: none;
        }

        .track {
            left: calc(100% / 14);
            right: calc(100% / 14);
            background: var(--border);
        }

        .fill {
            left: calc(100% / 14);
            background: var(--copper);
            transition: width 220ms ease;
        }

        .step {
            position: relative;
            z-index: 1;
            flex: 1 1 0;
            min-width: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            background: none;
            border: 0;
            padding: 0;
            cursor: pointer;
            color: var(--fg-muted);
            font: inherit;
            opacity: 0.55;
            transition: opacity 160ms ease;
        }

        .step[data-done],
        .step[data-current] {
            opacity: 1;
        }

        .step:focus {
            outline: none;
        }

        .step:focus-visible .node {
            box-shadow: 0 0 0 3px color-mix(in srgb, var(--copper) 35%, transparent);
        }

        .node {
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: 2px solid var(--border);
            background: var(--bg-subtle);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 600;
            font-feature-settings: 'tnum';
            line-height: 1;
            color: var(--fg-muted);
            transition:
                background 160ms ease,
                border-color 160ms ease,
                color 160ms ease;
        }

        .step:hover {
            opacity: 1;
        }

        .step:hover .node {
            border-color: var(--copper);
        }

        .step[data-done] .node {
            background: var(--copper);
            border-color: var(--copper);
            color: var(--bg);
        }

        .step[data-current] .node {
            border-color: var(--copper);
            color: var(--copper);
        }

        /*
         * Loading: animated spinner inside the node. The node itself keeps its border so the
         * step still occupies the same visual footprint; the spinner is a sub-element that
         * spins independently. Opacity is forced to full so the .55 default doesn't dim the
         * spinner — a loading step is informative, not skipped.
         */
        .step[data-loading] {
            opacity: 1;
        }

        .step[data-loading] .node {
            border-color: var(--copper);
            background: var(--bg-subtle);
            color: var(--copper);
        }

        .spinner {
            display: block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            border: 2px solid color-mix(in srgb, var(--copper) 25%, transparent);
            border-top-color: var(--copper);
            animation: vir-progress-spin 720ms linear infinite;
        }

        @keyframes vir-progress-spin {
            to {
                transform: rotate(360deg);
            }
        }

        /*
         * Failure: solid red node with an exclamation glyph. Same visual weight as a done
         * checkmark so a failed step reads as decisive — the user should look at it. The
         * step label flips to the warning hue to match the node and pull the eye downward.
         */
        .step[data-failed] {
            opacity: 1;
        }

        .step[data-failed] .node {
            background: var(--danger, #d9534f);
            border-color: var(--danger, #d9534f);
            color: var(--bg, #fff);
            font-size: 13px;
        }

        .step[data-failed] .label {
            color: var(--danger, #d9534f);
            font-weight: 500;
        }

        .label {
            font-size: 11px;
            line-height: 1.3;
            text-align: center;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 100%;
            color: var(--fg-muted);
            transition: color 160ms ease;
        }

        .step[data-done] .label {
            color: var(--fg);
        }

        .step[data-current] .label {
            color: var(--copper);
            font-weight: 500;
        }

        .step-wrap {
            position: relative;
            flex: 1 1 0;
            min-width: 0;
            display: flex;
            justify-content: center;
        }

        .step-wrap .step {
            width: 100%;
        }

        .popover {
            position: absolute;
            bottom: calc(100% + 8px);
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            flex-direction: column;
            min-width: 168px;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: var(--radius-md, 6px);
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
            padding: 4px;
            z-index: 5;
            opacity: 0;
            pointer-events: none;
            transition: opacity 120ms ease;
        }

        /*
         * Popovers are click-driven: clicking a step with popoverActions sets data-open on the
         * wrapper, which reveals the menu. Click the same step again, an item, anywhere else,
         * or press Escape to close. No hover-reveal — sliding over a step button leaves it
         * alone.
         */
        .step-wrap[data-open] .popover {
            opacity: 1;
            pointer-events: auto;
        }

        .popover-item {
            background: none;
            border: 0;
            padding: 8px 10px;
            text-align: left;
            font: inherit;
            font-size: 12px;
            color: var(--fg);
            border-radius: 4px;
            cursor: pointer;
            white-space: nowrap;
        }

        .popover-item:hover,
        .popover-item:focus-visible {
            background: color-mix(in srgb, var(--copper) 12%, transparent);
            color: var(--copper);
            outline: none;
        }

        .popover-arrow {
            position: absolute;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            width: 10px;
            height: 6px;
            background: var(--bg);
            border-right: 1px solid var(--border);
            border-bottom: 1px solid var(--border);
            clip-path: polygon(0 0, 100% 0, 50% 100%);
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        pruneLegacyProgressKeys();

        const folder = inputs.folder;
        const folderPath = folder.path;

        // Resolve each step's inputs + raw done/failed/loading state via the shared helpers.
        // We compute raw states first (no dep-masking) so deps can resolve against optimistic
        // done values — checking "Open PR" reveals Reviewer-approved in the same frame, no
        // wait for the next /folders poll.
        const rawResolved = mergeStepsConfig.map((step) => {
            const optimistic =
                step.storageKey != null
                    ? state.pendingMergeStepValues[step.storageKey]
                    : undefined;
            const stepInputs = buildMergeStepInputs(folder, step, optimistic);
            const {done, failed, loading} = evaluateMergeStep(folder, step, optimistic);
            return {step, inputs: stepInputs, done, failed, loading};
        });
        const doneByName: Record<string, boolean> = {};
        for (const entry of rawResolved) doneByName[entry.step.name] = entry.done;
        // Mask state for steps whose deps aren't yet satisfied: render as plain unchecked
        // (no check / ! / spinner / current-emphasis). The step stays visible so the user
        // can see the upcoming work, just without misleading indicators.
        const resolved = rawResolved.map((entry) => {
            const depsSatisfied = areStepDepsSatisfied(entry.step, doneByName);
            if (depsSatisfied) return {...entry, depsSatisfied};
            return {
                ...entry,
                depsSatisfied,
                done: false,
                failed: false,
                loading: false,
            };
        });

        // `current` (the emphasized "you're here" step) is the first not-done step that
        // also has its deps satisfied — a step the user can't act on yet shouldn't grab
        // the spotlight.
        const firstNotDone = resolved.findIndex((entry) => !entry.done && entry.depsSatisfied);
        const doneCount = resolved.filter((entry) => entry.done).length;
        const fillRatio =
            doneCount >= 1 ? (doneCount - 1) / Math.max(1, mergeStepsConfig.length - 1) : 0;

        return html`
            <div class="stepper" role="group" aria-label="PR progress">
                <div class="track"></div>
                <div
                    class="fill"
                    style="width: calc(${fillRatio} * (100% - 100% / ${mergeStepsConfig.length}))"
                ></div>
                ${resolved.map(({step, inputs: stepInputs, done, failed, loading}, index) => {
                    const current = index === firstNotDone;
                    const label = done ? step.doneLabel : step.todoLabel;
                    const actions: MergeStepActions = {
                        toggleStored: () => {
                            if (step.storageKey == null) {
                                return;
                            }
                            const storageKey = step.storageKey;
                            const next = !done;
                            // Flip the override immediately so the checkmark updates in the
                            // same frame as the click. The override is cleared once the API
                            // call settles — success means the next /folders poll will deliver
                            // the same value; failure means the server-side value re-asserts
                            // itself and the user can see the click didn't take.
                            updateState({
                                pendingMergeStepValues: {
                                    ...state.pendingMergeStepValues,
                                    [storageKey]: next,
                                },
                            });
                            void setWorktreeMergeStep({
                                worktreePath: folderPath,
                                name: storageKey,
                                value: next,
                            })
                                .catch((error: unknown) => {
                                    console.error('setWorktreeMergeStep failed', error);
                                })
                                .finally(() => {
                                    const cleared = {...state.pendingMergeStepValues};
                                    delete cleared[storageKey];
                                    updateState({pendingMergeStepValues: cleared});
                                });
                        },
                        embedPr: () => {
                            const safeUrl = sanitizePrUrl(folder.prUrl ?? null);
                            if (safeUrl) {
                                dispatch(new events.prEmbedRequested(safeUrl));
                            }
                        },
                        openInVsCode: () => {
                            void openInVsCode(folderPath);
                        },
                        setLastReviewedSha: (sha) => {
                            void markWorktreeReviewed({
                                worktreePath: folderPath,
                                sha,
                            }).catch((error: unknown) => {
                                console.error('markWorktreeReviewed failed', error);
                            });
                        },
                        runTestLocally: () => {
                            // First click on a worktree spawns `npm start` and waits for it
                            // to print a localhost URL — that can take a while on cold caches,
                            // so the click resolves async with no inline progress UI. Console
                            // + global error reporter pick up the failure path; the success
                            // path drops straight into the embed overlay.
                            void startWorktreeTestServer({worktreePath: folderPath})
                                .then(({port}) => {
                                    dispatch(
                                        new events.prEmbedRequested(
                                            `http://localhost:${port}/`,
                                        ),
                                    );
                                })
                                .catch((error: unknown) => {
                                    console.error('startWorktreeTestServer failed', error);
                                });
                        },
                        stageTrivialHunks: () => {
                            void stageTrivialHunks({worktreePath: folderPath})
                                .then(({output}) => {
                                    console.info(`[stage-trivial-hunks @ ${folderPath}]\n${output}`);
                                })
                                .catch((error: unknown) => {
                                    console.error('stageTrivialHunks failed', error);
                                });
                        },
                    };
                    const nodeContents = done
                        ? '✓'
                        : failed
                          ? '!'
                          : loading
                            ? html`<span class="spinner" aria-hidden="true"></span>`
                            : index + 1;
                    const hasPopover = !!step.popoverActions && step.popoverActions.length > 0;
                    const popoverOpen = hasPopover && state.openPopoverStep === step.name;
                    const button = html`
                        <button
                            type="button"
                            class="step"
                            data-step=${step.name}
                            ?data-done=${done}
                            ?data-current=${current}
                            ?data-loading=${loading}
                            ?data-failed=${failed}
                            aria-pressed=${done ? 'true' : 'false'}
                            aria-haspopup=${hasPopover ? 'menu' : 'false'}
                            aria-expanded=${hasPopover ? (popoverOpen ? 'true' : 'false') : 'false'}
                            title=${label}
                            ${listen('click', () => {
                                if (hasPopover) {
                                    // Toggle: clicking the open step closes its popover; clicking
                                    // a different step switches to that step's popover.
                                    updateState({
                                        openPopoverStep: popoverOpen ? null : step.name,
                                    });
                                    return;
                                }
                                step.onClick(stepInputs, actions);
                            })}
                        >
                            <span class="node" aria-hidden="true">${nodeContents}</span>
                            <span class="label">${label}</span>
                        </button>
                    `;
                    if (!hasPopover) {
                        return button;
                    }
                    return html`
                        <div class="step-wrap" ?data-open=${popoverOpen}>
                            ${button}
                            <div class="popover" role="menu">
                                ${step.popoverActions!.map((entry) => {
                                    const resolvedLabel =
                                        typeof entry.label === 'function'
                                            ? entry.label(stepInputs)
                                            : entry.label;
                                    return html`
                                        <button
                                            type="button"
                                            class="popover-item"
                                            role="menuitem"
                                            ${listen('click', () => {
                                                entry.onClick(stepInputs, actions);
                                                updateState({openPopoverStep: null});
                                            })}
                                        >
                                            ${resolvedLabel}
                                        </button>
                                    `;
                                })}
                                <div class="popover-arrow" aria-hidden="true"></div>
                            </div>
                        </div>
                    `;
                })}
            </div>
        `;
    },
});
