export enum PaneKind {
    Ai = 'ai',
    Shell = 'shell',
}

export enum PaneStatus {
    /** No PTY has ever been started for this pane. */
    None = 'none',
    /** PTY is alive and producing output recently. */
    Busy = 'busy',
    /** PTY is alive but has been quiet for a moment. */
    Idle = 'idle',
    /** PTY process exited (the pane shows its last buffered output). */
    Exited = 'exited',
}

/**
 * How the sidebar arranges its folder list. `Repo` keeps the existing layout (each repo's worktrees
 * nested under their root). `Status` regroups folders by their AI pane's current {@link PaneStatus}
 * regardless of which repo they belong to. The actual regrouping logic isn't wired up yet — this is
 * just the user's preference, persisted in config.
 *
 * The first variant is the default (object-shape-tester's `enumShape` picks the first value when
 * the field is absent from config), so `Repo` stays as the out-of-the-box behavior.
 */
export enum SidebarGrouping {
    Repo = 'repo',
    Status = 'status',
}

/**
 * Which color theme the frontend applies. `Light` is the original, upstream look and is left
 * completely untouched by this fork. `Dark` is electrovir's upstream dark mode — vira's built-in
 * dark theme (neutral cool greys). `DarkClaude` applies a dark color theme modeled after the Claude
 * desktop / Claude Code aesthetic (warm near-black surfaces, clay accent). `DarkCodex` uses cool
 * blue-black surfaces and a blue accent modeled after Codex. `Auto` follows the OS
 * `prefers-color-scheme`, applying `Dark` when the system is dark and `Light` otherwise.
 *
 * The first variant is the default (object-shape-tester's `enumShape` picks the first value when
 * the field is absent from config), so existing configs without a `theme` field keep rendering in
 * `Light` exactly as before.
 */
export enum Theme {
    Light = 'light',
    Dark = 'dark',
    DarkClaude = 'dark-claude',
    DarkCodex = 'dark-codex',
    Auto = 'auto',
}

/**
 * How the sidebar orders folders within each group. `Date` uses each folder's filesystem creation
 * time (newest first), falling back to name for folders the backend couldn't stat.
 *
 * The first variant is the default (`enumShape` picks the first value when the field is absent from
 * config), so `Name` stays as the out-of-the-box behavior.
 */
export enum SidebarSorting {
    Name = 'name',
    Date = 'date',
}

/**
 * How a file in the Diff pane differs on one side of the index. Derived from a single letter of
 * `git status --porcelain`'s two-letter code — the index column for a staged entry, the worktree
 * column for an unstaged one.
 */
export enum GitFileChange {
    Added = 'added',
    Modified = 'modified',
    Deleted = 'deleted',
    Renamed = 'renamed',
    Untracked = 'untracked',
}

/**
 * Which pair of trees a diff compares. `Staged` is `HEAD` → index (what a commit would contain);
 * `Unstaged` is index → working tree (what a commit would leave behind). A partially-staged file
 * appears on both sides with different content, which is exactly why the pane can't collapse them
 * into one `HEAD` → working tree diff.
 */
export enum GitDiffSide {
    Staged = 'staged',
    Unstaged = 'unstaged',
}

/**
 * Lifecycle state of a pull request, flattened from GitHub's separate `state` + `isDraft` fields
 * into the one value the UI actually branches on.
 */
export enum GitHubPrState {
    Draft = 'draft',
    Open = 'open',
    Merged = 'merged',
    Closed = 'closed',
}

/**
 * Aggregate CI result for the PR's head commit, collapsed from GitHub's `statusCheckRollup.state`.
 * `None` covers both "the repo runs no checks" and "the rollup isn't computed yet".
 */
export enum GitHubCheckState {
    None = 'none',
    Pending = 'pending',
    Success = 'success',
    Failure = 'failure',
}

/** One reviewer's latest verdict on the PR. */
export enum GitHubReviewState {
    Approved = 'approved',
    ChangesRequested = 'changesRequested',
    Commented = 'commented',
    Dismissed = 'dismissed',
    Pending = 'pending',
}

/**
 * The eight reactions GitHub allows on a comment. Values are GitHub's own `ReactionContent` enum
 * literals so they can be handed straight to the `addReaction` / `removeReaction` mutations without
 * a translation table.
 */
export enum GitHubReaction {
    ThumbsUp = 'THUMBS_UP',
    ThumbsDown = 'THUMBS_DOWN',
    Laugh = 'LAUGH',
    Hooray = 'HOORAY',
    Confused = 'CONFUSED',
    Heart = 'HEART',
    Rocket = 'ROCKET',
    Eyes = 'EYES',
}

/**
 * One stage of getting a worktree's work merged, in the order the progress tracker renders them.
 * Values are stable storage keys: the manual-attestation steps persist under these strings in
 * config, so renaming a value silently discards a user's recorded progress.
 */
export enum MergeStepKey {
    AiGenerating = 'aiGenerating',
    SelfQa = 'selfQa',
    SelfReview = 'selfReview',
    DraftPr = 'draftPr',
    PrOpened = 'prOpened',
    CiPassing = 'ciPassing',
    Approved = 'approved',
    Merged = 'merged',
}

/**
 * The subset of steps the user ticks off by hand, as opposed to the ones derived from observed
 * state. Only these are persisted, and only these can be toggled through the API.
 */
export type ManualMergeStepKey = MergeStepKey.SelfQa | MergeStepKey.SelfReview;

export const manualMergeStepKeys: ReadonlyArray<ManualMergeStepKey> = [
    MergeStepKey.SelfQa,
    MergeStepKey.SelfReview,
];

/**
 * Rendered state of one merge step. When several could apply at once, done wins over failed, which
 * wins over loading, which wins over not-yet-started — a merged PR reads as done even if its checks
 * never went green, because the outcome the step describes has already happened.
 */
export enum MergeStepState {
    Todo = 'todo',
    Loading = 'loading',
    Failed = 'failed',
    Done = 'done',
}
