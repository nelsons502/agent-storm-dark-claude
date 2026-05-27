import {AnyOrigin, defineService, HttpMethod} from '@rest-vir/define-service';
import {
    defineShape,
    enumShape,
    nullableShape,
    optionalShape,
    recordShape,
    tupleShape,
    unionShape,
} from 'object-shape-tester';
import {PaneKind, PaneStatus, RepoInspectionState} from './enums.js';

const port = 41_880;

const stringMessageShape = defineShape('');

/**
 * Client → host messages on the `/pty` socket are either raw keystroke / paste data written
 * directly to the pty, or `{resize: {cols, rows}}` carrying the xterm viewport's current
 * dimensions. The host pushes those dimensions through to `node-pty` so the spawned shell wraps at
 * the right column.
 */
const ptyClientMessageShape = defineShape(
    unionShape('', {
        resize: {
            cols: 0,
            rows: 0,
        },
    }),
);

const ptySearchParamsShape = defineShape({
    folder: tupleShape(''),
    kind: tupleShape(enumShape(PaneKind)),
});

/**
 * The WebSocket upgrade can't carry an `Authorization` header from a browser, but it _can_ carry
 * subprotocols. The auth bearer rides in `Sec-WebSocket-Protocol`; the server validates it and
 * sends back this same value to complete the upgrade handshake.
 */
const ptyProtocolsShape = defineShape(tupleShape(''));

const worktreeConfigShape = defineShape({
    /** Absolute path to the worktree directory on disk. */
    path: '',
    /**
     * Whether this worktree tracks the parent repo's base branch. The base worktree is hidden
     * from the sidebar (it's the canonical home for shared local-only files like
     * `.not-committed/`) and refuses deletion.
     */
    isBase: false,
    /**
     * Local HEAD commit SHA captured the last time the user checked the Self-review (code) step.
     * The progress tracker uses this to invalidate the self-review checkbox when a new local
     * commit moves HEAD past what was actually reviewed. Null when the step has never been
     * checked or after invalidation.
     */
    lastReviewedSha: nullableShape(''),
    /**
     * Per-step booleans for the progress tracker's user-toggled merge steps (self-QA,
     * self-review-code, etc.). Keyed by the step's `storageKey`. Stored on the worktree config
     * — and so persisted in `~/.config/agent-storm.json` — rather than in browser localStorage
     * so progress survives across machines / clients and so the desktop and browser builds
     * agree on state.
     */
    mergeStepValues: recordShape({
        keys: '',
        values: false,
        partial: true,
    }),
});

const repoConfigShape = defineShape({
    path: '',
    postWorktreeCmd: nullableShape(''),
    /**
     * The branch that's treated as the source-of-truth worktree for this repo. Its worktree is
     * hidden from the sidebar and cannot be deleted; it's the canonical place to keep shared
     * local-only files (e.g. `.not-committed/`) that get seeded into new worktrees. Null means
     * no base branch is configured (no hiding, no deletion guard).
     */
    baseBranch: nullableShape(''),
    /**
     * Explicit list of worktrees tracked under this repo. Source of truth for what the sidebar
     * shows; reconciled against the filesystem when the config is saved, when a worktree is
     * created or deleted, and at the start of each background sweep. Empty for regular
     * (non-worktree-layout) git repos.
     */
    worktrees: [worktreeConfigShape],
    /**
     * Whether this repo uses a worktree-style layout (one bare git dir + multiple checked-out
     * worktrees under a shared root). False for regular single-checkout repos. Reconciled
     * alongside `worktrees`; stored in config so enumeration doesn't have to re-probe the
     * filesystem on every refresh.
     */
    isWorktreeLayout: false,
});

const configShape = defineShape({
    aiCmd: 'claude',
    postWorktreeCmd: nullableShape(''),
    repos: [repoConfigShape],
    hiddenAiPane: [''],
    /**
     * Worktree paths the user has marked as hidden from the sidebar. Mirrors the shape of
     * `hiddenAiPane` rather than living per-worktree under `repos[].worktrees[]` so the toggle
     * surfaces with a single `putConfig` call and doesn't need a dedicated endpoint. Filtered
     * out of the sidebar's tab list unless `showHiddenWorktrees` is on; cleaned up alongside
     * the worktree's row on delete and alongside the repo's rows on remove.
     */
    hiddenWorktrees: [''],
    /**
     * Whether the sidebar should show worktrees marked as hidden. Optional + falsy by default so
     * the "Hidden" mark actually hides things on first use; toggled from the worktree-section
     * three-dot menu. Persisted in config (not localStorage) so the choice syncs across the
     * desktop + browser builds.
     */
    showHiddenWorktrees: optionalShape(false),
    /**
     * Opt-out flag for the background `gh pr view` calls the refresh loop makes on each non-root
     * folder. Optional and falsy by default so GitHub polling is on out of the box; set to true to
     * skip the `gh` shell-outs entirely when GitHub starts rate-limiting the account (the API
     * starts returning 403s and the sidebar's PR badges go stale anyway, so the calls become pure
     * overhead until the limit resets).
     */
    disabledGitHubPolling: optionalShape(false),
    /**
     * Runtime-set auto-disable state for GitHub polling, persisted across server restarts so `tsx
     * --watch` reloads during dev don't immediately re-poll GitHub after a rate-limit / auth
     * failure. Set by the backend when a GraphQL call surfaces such an error; cleared once
     * `disabledUntilMs` elapses or the user explicitly toggles polling off-and-on. Distinct from
     * `disabledGitHubPolling` above, which is the manual user kill-switch.
     */
    githubPollingAutoDisable: nullableShape({
        reason: '',
        disabledUntilMs: 0,
    }),
    /**
     * Whether the in-app terminal should use the xterm WebGL renderer. Optional and defaulted to
     * true; users on machines without WebGL2 (or with flaky GPU drivers) can switch this off to
     * fall back to xterm's DOM renderer.
     */
    useWebgl: optionalShape(true),
});

export const folderInfoShape = defineShape({
    path: '',
    name: '',
    parentRepoPath: nullableShape(''),
    isWorktreeRoot: false,
    isBaseBranch: false,
    aiHidden: false,
    /**
     * Whether the user marked this worktree as hidden from the sidebar. Mirrored from
     * `config.hiddenWorktrees`; the sidebar filters these rows out unless the "Show hidden"
     * toggle is on.
     */
    isHidden: false,
    branch: nullableShape(''),
    git: {
        dirty: false,
        notPushed: false,
    },
    prUrl: nullableShape(''),
    prMerged: false,
    /**
     * Whether the worktree has any uncommitted changes (modified, staged, or untracked files).
     * Mirrors `git.dirty`; surfaced separately so the progress tracker has a stable name to
     * invalidate self-QA / self-review checkboxes on each new edit.
     */
    hasUncommittedChanges: false,
    /** Local HEAD commit SHA for the worktree, or null when detached / not a repo. */
    localCommitHash: nullableShape(''),
    /**
     * The PR's remote head SHA from `gh pr view --json headRefOid`. Null if no PR exists or
     * GitHub polling is disabled. Lets the progress tracker tell "PR open" from "PR open AND
     * everything pushed" without having to peek at the local upstream ref.
     */
    branchCommitHash: nullableShape(''),
    /** Whether the open PR is in draft state. Undefined when no PR exists. */
    prIsDraft: false,
    /**
     * Aggregated CI verdict mirrored from `PrInfo.ciPassing`. `null` while checks are still
     * running or no checks have registered yet — the progress tracker pairs this with
     * `prCiInProgress` to tell those two cases apart.
     */
    prCiPassing: nullableShape(false),
    /**
     * True while at least one CI check is still running. Lets the UI surface a loading state
     * on the "Pass CI" step and classify the worktree as "Working" rather than
     * "Needs attention" while checks are in flight.
     */
    prCiInProgress: false,
    /**
     * Aggregated result of *review-flavoured* status checks (anything whose name matches
     * `/review/i` — same set excluded from `prCiPassing`). These are CI checks that gate on
     * "all required human approvals received", so the "Get approval" step uses this directly
     * instead of GitHub's `reviewDecision`, which would also count bot reviewers (Claude,
     * Copilot, etc.) the user doesn't actually care about.
     *
     * Null when there are no review checks on the PR (or all are still running).
     */
    prReviewCheckPassing: nullableShape(false),
    /** True while at least one review-flavoured check is still running. */
    prReviewCheckInProgress: false,
    prApproved: false,
    /**
     * True when GitHub's `reviewDecision` is `CHANGES_REQUESTED` — at least one reviewer is
     * actively blocking the PR and the author hasn't re-requested review since. Powers the
     * red-exclamation failure state on the "Get approval" step.
     */
    prReviewChangesRequested: false,
    /**
     * True when reviewers have been requested but haven't yet responded
     * (`reviewDecision === 'REVIEW_REQUIRED'` with non-empty `reviewRequests`). Distinguishes
     * "waiting on humans" from "no reviewers configured" so the approval step only shows a
     * loading state when someone is actually expected to act.
     */
    prReviewPending: false,
    /**
     * True iff at least one inline review thread on the PR is still unresolved AND not
     * outdated. Outdated threads (pointing at code that no longer exists in the diff) are
     * excluded — the reviewer's concern is moot regardless of whether anyone clicked
     * "Resolve conversation". Drives the red-exclam state on the "Get approval" step
     * alongside `prReviewChangesRequested`.
     */
    prHasUnresolvedReviewComments: false,
    /** SHA captured the last time the user checked Self-review (code). Mirrors worktree config. */
    lastReviewedSha: nullableShape(''),
    /**
     * Mirrors `worktreeConfigShape.mergeStepValues` — the per-step booleans the progress tracker
     * reads for its user-toggled steps. Always populated (empty record if the worktree has never
     * had a check toggled).
     */
    mergeStepValues: recordShape({
        keys: '',
        values: false,
        partial: true,
    }),
    panes: {
        ai: enumShape(PaneStatus),
        shell: enumShape(PaneStatus),
    },
});

const foldersResponseShape = defineShape({
    folders: [folderInfoShape],
});

const folderActionRequestShape = defineShape({
    folder: '',
});

const paneActionRequestShape = defineShape({
    folder: '',
    kind: enumShape(PaneKind),
});

const createWorktreeRequestShape = defineShape({
    repoPath: '',
    name: '',
});

const deleteWorktreeRequestShape = defineShape({
    worktreePath: '',
});

const markWorktreeReviewedRequestShape = defineShape({
    worktreePath: '',
    /** SHA to record as `lastReviewedSha`, or null to clear it (e.g. on uncheck). */
    sha: nullableShape(''),
});

const setMergeStepRequestShape = defineShape({
    worktreePath: '',
    /** Step's `storageKey` (e.g. `self-qa`). Must match a non-null storageKey in mergeStepsConfig. */
    name: '',
    /** New boolean to record. Null deletes the entry — same as the un-toggled / never-set state. */
    value: nullableShape(false),
});

const okResponseShape = defineShape({
    ok: true,
});

const startTestServerRequestShape = defineShape({
    worktreePath: '',
});

const startTestServerResponseShape = defineShape({
    /** The first `http://localhost:<port>` URL the worktree's `npm start` printed. */
    port: 0,
    /** True when the child was already running and the cached port was returned without respawn. */
    reused: false,
});

const stageTrivialHunksRequestShape = defineShape({
    worktreePath: '',
});

const stageTrivialHunksResponseShape = defineShape({
    /** Combined stdout from the script — summary of what got staged / what was skipped. */
    output: '',
});

const uploadRequestShape = defineShape({
    filename: '',
    dataBase64: '',
});

const uploadResponseShape = defineShape({
    path: '',
});

const folderPickerResponseShape = defineShape({
    path: nullableShape(''),
});

const repoInspectRequestShape = defineShape({
    path: '',
});

const repoInspectResponseShape = defineShape({
    state: enumShape(RepoInspectionState),
    currentBranch: nullableShape(''),
    workingTreeClean: false,
    /**
     * Branches present in the repo as worktrees (for already-Worktree layouts) or just the
     * single current branch (for Regular layouts that haven't been converted yet). Empty for
     * non-repo / detached states. Used by the add-repo UI to pick a base branch.
     */
    branches: [''],
    /**
     * For WorktreeChild state: the resolved parent path that should be registered as the
     * repo root. Null for every other state.
     */
    worktreeRoot: nullableShape(''),
});

const convertRepoRequestShape = defineShape({
    repoPath: '',
});

const deleteRepoRequestShape = defineShape({
    repoPath: '',
});

const clientErrorRequestShape = defineShape({
    message: '',
    stack: nullableShape(''),
    source: '',
    url: nullableShape(''),
    userAgent: nullableShape(''),
});


export const agentStormService = defineService({
    serviceName: 'agent-storm',
    serviceOrigin: `http://localhost:${port}`,
    requiredClientOrigin: AnyOrigin,
    endpoints: {
        '/config': {
            methods: {
                [HttpMethod.Get]: true,
                [HttpMethod.Put]: true,
            },
            requestDataShape: nullableShape(configShape),
            responseDataShape: configShape,
        },
        '/folders': {
            methods: {
                [HttpMethod.Get]: true,
            },
            requestDataShape: undefined,
            responseDataShape: foldersResponseShape,
        },
        '/worktrees/create': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: createWorktreeRequestShape,
            responseDataShape: okResponseShape,
        },
        '/worktrees/delete': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: deleteWorktreeRequestShape,
            responseDataShape: okResponseShape,
        },
        '/worktrees/mark-reviewed': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: markWorktreeReviewedRequestShape,
            responseDataShape: okResponseShape,
        },
        '/worktrees/set-merge-step': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: setMergeStepRequestShape,
            responseDataShape: okResponseShape,
        },
        '/worktrees/test-server/start': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: startTestServerRequestShape,
            responseDataShape: startTestServerResponseShape,
        },
        '/worktrees/stage-trivial-hunks': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: stageTrivialHunksRequestShape,
            responseDataShape: stageTrivialHunksResponseShape,
        },
        '/panes/restart': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: paneActionRequestShape,
            responseDataShape: okResponseShape,
        },
        '/panes/kill': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: folderActionRequestShape,
            responseDataShape: okResponseShape,
        },
        '/daemon/restart': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: undefined,
            responseDataShape: okResponseShape,
        },
        '/uploads/create': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: uploadRequestShape,
            responseDataShape: uploadResponseShape,
        },
        '/folder-picker': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: undefined,
            responseDataShape: folderPickerResponseShape,
        },
        '/repos/inspect': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: repoInspectRequestShape,
            responseDataShape: repoInspectResponseShape,
        },
        '/repos/convert-to-worktree': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: convertRepoRequestShape,
            responseDataShape: okResponseShape,
        },
        '/repos/delete': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: deleteRepoRequestShape,
            responseDataShape: okResponseShape,
        },
        '/client-errors': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: clientErrorRequestShape,
            responseDataShape: okResponseShape,
        },
    },
    webSockets: {
        '/pty': {
            messageFromClientShape: ptyClientMessageShape,
            messageFromHostShape: stringMessageShape,
            searchParamsShape: ptySearchParamsShape,
            protocolsShape: ptyProtocolsShape,
        },
    },
});

export const defaultConfig = configShape.default;

export type Config = typeof configShape.runtimeType;
export type RepoConfig = typeof repoConfigShape.runtimeType;
export type FolderInfo = typeof folderInfoShape.runtimeType;
export type RepoInspection = typeof repoInspectResponseShape.runtimeType;
