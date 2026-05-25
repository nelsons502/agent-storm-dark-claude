export enum PaneKind {
    Ai = 'ai',
    Shell = 'shell',
    /**
     * Long-running `npm start` for the worktree. Lives behind a tab in the shell area so the
     * user can flip between their personal shell and the project's dev-server output without
     * losing either.
     */
    Services = 'services',
}

export enum UserThemeSelection {
    Auto = 'auto',
    Light = 'light',
    Dark = 'dark',
}

export enum RepoInspectionState {
    /** The folder is empty or does not exist. */
    Empty = 'empty',
    /** A regular git repository (single `.git` directory, no nested worktrees). */
    Regular = 'regular',
    /** Already a worktree-style layout (top-level `.git` file, or children with `.git`). */
    Worktree = 'worktree',
    /** The folder is itself a worktree inside a worktree-style parent. */
    WorktreeChild = 'worktree-child',
    /** The folder exists but is not a git repository and is not empty. */
    NotARepo = 'not-a-repo',
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

