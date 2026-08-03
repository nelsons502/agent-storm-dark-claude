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
