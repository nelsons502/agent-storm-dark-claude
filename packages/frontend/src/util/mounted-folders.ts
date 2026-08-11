/**
 * How many folders may stay mounted at once on desktop.
 *
 * Every mounted folder holds a `VirPaneGroup` with up to two `VirTerminal`s, and each terminal owns
 * an xterm instance with its own scrollback buffer (20k lines by default, configurable to 100k), a
 * live WebGL context, and an open `/pty` WebSocket. Nothing used to evict them: `openedFolders`
 * grew on every folder the user visited and only ever shrank when a worktree was explicitly
 * deleted, so a browser tab left open across a week of work accumulated terminals for every
 * worktree ever touched.
 *
 * Six is chosen against the WebGL context budget, which is the hard ceiling rather than the memory:
 * browsers keep only ~16 live contexts per page and silently discard the oldest beyond that. Six
 * folders is twelve contexts, leaving headroom.
 *
 * Evicting is cheap because it is not destructive — the daemon owns the PTY and replays scrollback
 * on reattach, which is the same path mobile has always used by mounting only the active folder.
 */
export const maxMountedFolders = 6;

/**
 * Record a folder as most-recently-used and drop the least-recently-used ones beyond the limit.
 *
 * The returned array is ordered oldest-first, so the front is what gets evicted. `activeFolder` is
 * always retained regardless of the limit — unmounting the pane the user is looking at would close
 * the terminal in front of them.
 *
 * Returns `undefined` when nothing would change, so callers can skip a state write and avoid
 * re-rendering the whole app.
 */
export function admitMountedFolder(
    options: Readonly<{
        openedFolders: ReadonlyArray<string>;
        folder: string;
        activeFolder: string | undefined;
        limit?: number;
    }>,
): string[] | undefined {
    const limit = Math.max(1, options.limit ?? maxMountedFolders);
    const withoutFolder = options.openedFolders.filter((entry) => entry !== options.folder);
    const mostRecentLast = [
        ...withoutFolder,
        options.folder,
    ];

    /**
     * Walk newest-first and keep the first `limit`, then restore oldest-first order. Done by
     * retention rather than by slicing so the active-folder exemption cannot be defeated by its
     * position.
     */
    const retained = new Set<string>();
    Array.from(mostRecentLast)
        .reverse()
        .forEach((entry) => {
            if (retained.size < limit || entry === options.activeFolder) {
                retained.add(entry);
            }
        });
    const next = mostRecentLast.filter((entry) => retained.has(entry));

    const unchanged =
        next.length === options.openedFolders.length &&
        next.every((entry, index) => options.openedFolders[index] === entry);
    return unchanged ? undefined : next;
}
