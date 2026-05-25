import {type FolderInfo} from '@agent-storm/common';
import {css, defineElement, html, listen} from 'element-vir';
import {getFolders} from '../../util/api-client.js';
import {installErrorReporter, reportClientError} from '../../util/error-reporter.js';
import {localStorageClient, sidebarWidth} from '../../util/local-storage-client.js';
import {router, type AppRoute, type FrontendPaths} from '../../util/router.js';
import '../../util/service-origin.js';
import '../../util/theme.js';
import {VirAddRepo} from './vir-add-repo.element.js';
import {VirAddWorktree} from './vir-add-worktree.element.js';
import {VirAuthModal} from './vir-auth-modal.element.js';
import {VirBook} from './vir-book.element.js';
import {VirPaneGroup} from './vir-pane-group.element.js';
import {VirPrEmbed} from './vir-pr-embed.element.js';
import {VirProgressTracker} from './vir-progress-tracker.element.js';
import {VirSettingsModal} from './vir-settings-modal.element.js';
import {VirSidebar} from './vir-sidebar.element.js';

installErrorReporter();

/**
 * Result of resolving the current URL against the live folder list.
 *
 * - `folder` — the activated `FolderInfo` (standalone repo or worktree child) when the URL points to
 *   a folder we can resolve. Used as the sidebar's `activeFolder` + the visible pane group.
 * - `redirectToRoot` — when the URL is non-trivial but invalid given the current folder list (e.g.
 *   `/<repoName>` where that repo has worktrees, or `/<repoName>/<worktreeName>` where neither
 *   exists). `vir-app` reacts by calling `router.setRoute({paths: []})` to bounce the user back to
 *   `/`. Suppressed when folder info hasn't loaded yet so we don't fight a still-loading page.
 */
type RouteResolution = {
    folder: FolderInfo | undefined;
    redirectToRoot: boolean;
};

function resolveRoute(
    routePaths: ReadonlyArray<string>,
    folderInfo: ReadonlyMap<string, FolderInfo>,
): RouteResolution {
    /**
     * Reserved literal — element-book route doesn't map to a folder. Also bail before folder info
     * has loaded so we don't redirect a URL that might be perfectly valid once data arrives.
     */
    if (routePaths[0] === 'book' || routePaths.length === 0 || folderInfo.size === 0) {
        return {
            folder: undefined,
            redirectToRoot: false,
        };
    }
    const [
        repoName,
        worktreeName,
    ] = routePaths;
    const folders = Array.from(folderInfo.values());
    if (!worktreeName) {
        /**
         * Single-segment URL: only valid if it matches a standalone (non-worktree-root, no-parent)
         * repo. Worktree-root matches are explicitly invalid per the route spec — the user must
         * pick a worktree segment.
         */
        const standalone = folders.find(
            (folder) =>
                folder.name === repoName && !folder.isWorktreeRoot && !folder.parentRepoPath,
        );
        if (standalone) {
            return {
                folder: standalone,
                redirectToRoot: false,
            };
        }
        return {
            folder: undefined,
            redirectToRoot: true,
        };
    }
    const repoRoot = folders.find((folder) => folder.name === repoName && folder.isWorktreeRoot);
    if (!repoRoot) {
        return {
            folder: undefined,
            redirectToRoot: true,
        };
    }
    const worktree = folders.find(
        (folder) => folder.parentRepoPath === repoRoot.path && folder.name === worktreeName,
    );
    return {
        folder: worktree,
        redirectToRoot: !worktree,
    };
}

/**
 * Compute the URL paths that should represent the given folder.
 *
 * - Standalone repo → `[folder.name]`.
 * - Worktree child → `[parentRepoName, folder.name]` (we resolve the parent's name through
 *   `folderInfo`; falls back to its basename via `parentRepoPath` if for some reason the parent
 *   isn't in the map).
 * - Worktree root → `[folder.name]` (the activation path for worktree-roots is "user clicked a
 *   child", so this branch is mostly defensive; if it ever fires the redirect-to-root logic above
 *   will undo it on the next render).
 */
function pathsForFolder(
    folder: FolderInfo,
    folderInfo: ReadonlyMap<string, FolderInfo>,
): FrontendPaths {
    if (folder.parentRepoPath) {
        const parent = folderInfo.get(folder.parentRepoPath);
        const parentName = parent?.name || folder.parentRepoPath.split('/').findLast(Boolean);
        return [
            parentName || folder.parentRepoPath,
            folder.name,
        ];
    }
    return [folder.name];
}

const folderInfoPollMs = 2000;

function clampSidebarWidth(value: number): number {
    if (!Number.isFinite(value)) {
        return sidebarWidth.default;
    }
    return Math.min(sidebarWidth.max, Math.max(sidebarWidth.min, value));
}

type AppState = {
    /**
     * Folders the user has clicked into, by absolute path. Kept around so each pane keeps its
     * terminal scrollback when the user switches folders. The currently-active folder is derived
     * from the URL + folder info; this list is the "ever opened during this session" superset.
     */
    openedFolders: ReadonlyArray<string>;
    folderInfo: Map<string, FolderInfo>;
    pollHandle: ReturnType<typeof setInterval> | undefined;
    settingsOpen: boolean;
    /**
     * PR URL currently being shown by the fullscreen vir-pr-embed overlay, or null when the
     * overlay is closed. Set when the progress tracker fires `prEmbedRequested`; cleared by
     * the embed's `closed` event (X-button click).
     */
    embeddedPrUrl: string | null;
    route: AppRoute;
    removeRouteListener: (() => void) | undefined;
    sidebarWidth: number;
    sidebarDragging: boolean;
};

type AppUpdate = (newState: Partial<AppState>) => void;

export const VirApp = defineElement()({
    tagName: 'vir-app',
    state(): AppState {
        return {
            openedFolders: [],
            folderInfo: new Map(),
            pollHandle: undefined,
            settingsOpen: false,
            embeddedPrUrl: null,
            route: router.readCurrentRoute(),
            removeRouteListener: undefined,
            sidebarWidth: localStorageClient.sidebarWidth.read(),
            sidebarDragging: false,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: row;
            width: 100%;
            /* 100dvh tracks the dynamic viewport height — on iPadOS Safari (paired with the
               viewport meta's interactive-widget=resizes-content option in index.html) this
               shrinks when the on-screen keyboard appears so the terminals aren't hidden behind
               it. The 100% above it is the fallback for browsers without dvh support. */
            height: 100%;
            height: 100dvh;
            font-family: var(--font-body);
            font-size: var(--font-size-md);
            background: var(--bg);
            color: var(--fg);
        }

        vir-sidebar {
            width: var(--sidebar-width, 280px);
            flex-shrink: 0;
        }

        .sidebar-divider {
            flex: 0 0 4px;
            position: relative;
            cursor: col-resize;
            background: var(--border);
            transition: background 120ms ease;
            /* Sit above the sidebar so the hit-area extension below catches the pointer
               instead of being eaten by sidebar event handlers. */
            z-index: 1;
            touch-action: none;
        }

        /* Visible bar stays a thin 4px, but the user gets ~14px of grabbable surface. */
        .sidebar-divider::before {
            content: '';
            position: absolute;
            top: 0;
            bottom: 0;
            left: -5px;
            right: -5px;
        }

        .sidebar-divider:hover,
        .sidebar-divider.dragging {
            background: var(--border-emphasized);
        }

        .stage {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
            background: var(--bg);
        }

        .stage-content {
            position: relative;
            flex: 1 1 auto;
            min-height: 0;
        }

        .stage-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--fg-muted);
            font-size: var(--font-size-sm);
            line-height: var(--line-height-sm);
            height: 100%;
        }

        .pane-slot {
            position: absolute;
            inset: 0;
            display: none;
        }

        .pane-slot[data-active] {
            display: block;
        }
    `,
    init({updateState}) {
        void refreshFolderInfo(updateState);
        const pollHandle = setInterval(() => {
            void refreshFolderInfo(updateState);
        }, folderInfoPollMs);
        const removeRouteListener = router.listen(true, (route) => {
            updateState({
                route,
            });
        });
        updateState({
            pollHandle,
            removeRouteListener,
        });
    },
    cleanup({state}) {
        if (state.pollHandle) {
            clearInterval(state.pollHandle);
        }
        state.removeRouteListener?.();
    },
    render({state, updateState, host}) {
        if (state.route.paths[0] === 'book') {
            return html`
                <${VirBook.assign({
                    subPaths: state.route.paths.slice(1),
                })}></${VirBook}>
            `;
        } else if (state.route.paths[0] === 'add-repo') {
            return html`
                <${VirAddRepo}></${VirAddRepo}>
                <${VirAuthModal}></${VirAuthModal}>
            `;
        } else if (state.route.paths[0] === 'add-worktree') {
            const repoPath = decodeURIComponent(state.route.paths[1]);
            return html`
                <${VirAddWorktree.assign({repoPath})}></${VirAddWorktree}>
                <${VirAuthModal}></${VirAuthModal}>
            `;
        }

        const currentSidebarWidth = clampSidebarWidth(state.sidebarWidth);
        host.style.setProperty('--sidebar-width', `${currentSidebarWidth}px`);

        /**
         * Single derivation of "the currently active folder" from URL + live folder info. Used to
         * mark the sidebar row, show the right pane group, and set the document title. If the URL
         * can't resolve (mistyped path, repo-with-worktrees + no second segment, etc.) and folder
         * info has actually loaded, bounce the user back to `/` so we don't sit in a broken state.
         */
        const resolution = resolveRoute(state.route.paths, state.folderInfo);
        const activeFolder = resolution.folder?.path;
        if (resolution.redirectToRoot) {
            void Promise.resolve().then(() =>
                router.setRoute({
                    paths: [],
                }),
            );
        }

        /**
         * Keep `openedFolders` in sync with the URL so a freshly-resolved folder mounts its pane
         * without a manual click. Defers the state update via a microtask so we don't mutate during
         * render.
         */
        if (activeFolder && !state.openedFolders.includes(activeFolder)) {
            const newOpened = [
                ...state.openedFolders,
                activeFolder,
            ];
            void Promise.resolve().then(() => {
                updateState({
                    openedFolders: newOpened,
                });
            });
        }

        document.title = resolution.folder
            ? `agent-storm • ${resolution.folder.name}`
            : 'agent-storm';

        const onDividerPointerDown = (event: PointerEvent) => {
            event.preventDefault();
            /**
             * Pointer Events unify mouse, touch, and pen so the same handler covers desktop and
             * iPad. `setPointerCapture` keeps `pointermove`/`pointerup` flowing to this element
             * even if the finger drifts off it mid-drag — crucial on touch where the OS otherwise
             * routes events to whatever the touch is currently over.
             */
            const divider = event.currentTarget;
            if (divider instanceof Element) {
                divider.setPointerCapture(event.pointerId);
            }

            // Mute selection + force resize cursor globally during drag — otherwise crossing
            // into the terminal canvas flips the cursor to i-beam and selects terminal text.
            const previousUserSelect = document.body.style.userSelect;
            const previousCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            let latestWidth = currentSidebarWidth;
            updateState({
                sidebarDragging: true,
            });

            const onMove = (moveEvent: PointerEvent) => {
                if (moveEvent.pointerId !== event.pointerId) {
                    return;
                }
                const rect = host.getBoundingClientRect();
                if (rect.width <= 0) {
                    return;
                }
                latestWidth = clampSidebarWidth(moveEvent.clientX - rect.left);
                updateState({
                    sidebarWidth: latestWidth,
                });
            };

            const onUp = (upEvent: PointerEvent) => {
                if (upEvent.pointerId !== event.pointerId) {
                    return;
                }
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                document.body.style.userSelect = previousUserSelect;
                document.body.style.cursor = previousCursor;
                updateState({
                    sidebarDragging: false,
                });
                localStorageClient.sidebarWidth.write(latestWidth);
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        };

        const onDividerDoubleClick = () => {
            updateState({
                sidebarWidth: sidebarWidth.default,
            });
            localStorageClient.sidebarWidth.write(sidebarWidth.default);
        };

        return html`
            <${VirSidebar.assign({
                activeFolder,
                onActivate: (folderPath: string) => {
                    const folder = state.folderInfo.get(folderPath);
                    /**
                     * Drive the URL from the click; render will re-derive `activeFolder` from the
                     * new route. If `folderInfo` doesn't yet know the folder (race with first poll)
                     * we still add it to `openedFolders` so the pane mounts — the URL update
                     * happens on a subsequent render once the data lands. Wipe `search` so the new
                     * repo starts on the CLI tab rather than inheriting the prior repo's `?code`.
                     */
                    if (folder) {
                        router.setRoute({
                            paths: pathsForFolder(folder, state.folderInfo),
                            search: undefined,
                        });
                    }
                    if (!state.openedFolders.includes(folderPath)) {
                        updateState({
                            openedFolders: [
                                ...state.openedFolders,
                                folderPath,
                            ],
                        });
                    }
                },
                onOpenSettings: () =>
                    updateState({
                        settingsOpen: true,
                    }),
            })}></${VirSidebar}>
            <div
                class="sidebar-divider ${state.sidebarDragging ? 'dragging' : ''}"
                role="separator"
                aria-orientation="vertical"
                title="Drag to resize. Double-click to reset."
                ${listen('pointerdown', onDividerPointerDown)}
                ${listen('dblclick', onDividerDoubleClick)}
            ></div>
            <div class="stage">
                <div class="stage-content">
                    ${state.openedFolders.length === 0
                        ? html`
                              <div class="stage-empty">Select a repo to open its panes.</div>
                          `
                        : ''}
                    ${state.openedFolders.map((folder) => {
                        const info = state.folderInfo.get(folder);
                        const active = folder === activeFolder;
                        return html`
                            <div class="pane-slot" ?data-active=${active}>
                                <${VirPaneGroup.assign({
                                    folder,
                                    aiHidden: !!info?.aiHidden,
                                    active,
                                    codeTabActive: !!state.route.search?.code,
                                })}
                                    ${listen(VirPaneGroup.events.cliTabRequested, () => {
                                        router.setRoute({
                                            paths: state.route.paths,
                                            search: undefined,
                                        });
                                    })}
                                    ${listen(VirPaneGroup.events.codeTabRequested, () => {
                                        router.setRoute({
                                            paths: state.route.paths,
                                            search: {
                                                code: [],
                                            },
                                        });
                                    })}
                                ></${VirPaneGroup}>
                            </div>
                        `;
                    })}
                </div>
                ${activeFolder && state.folderInfo.get(activeFolder)
                    ? html`
                          <${VirProgressTracker.assign({
                              folder: state.folderInfo.get(activeFolder)!,
                          })}
                              ${listen(VirProgressTracker.events.prEmbedRequested, (event) => {
                                  updateState({embeddedPrUrl: event.detail});
                              })}
                          ></${VirProgressTracker}>
                      `
                    : ''}
            </div>
            <${VirSettingsModal.assign({
                open: state.settingsOpen,
                onClose: () => {
                    updateState({
                        settingsOpen: false,
                    });
                    void syncTheme();
                },
            })}></${VirSettingsModal}>
            <${VirAuthModal}></${VirAuthModal}>
            <${VirPrEmbed.assign({url: state.embeddedPrUrl})}
                ${listen(VirPrEmbed.events.closed, () => updateState({embeddedPrUrl: null}))}
            ></${VirPrEmbed}>
        `;
    },
});

async function refreshFolderInfo(updateState: AppUpdate): Promise<void> {
    try {
        const folders = await getFolders();
        const folderInfo = new Map<string, FolderInfo>();
        folders.forEach((folder) => {
            folderInfo.set(folder.path, folder);
        });
        updateState({
            folderInfo,
        });
        const currentRoute = router.readCurrentRoute();
        if (currentRoute.paths[0] === 'home' && folders.length === 0) {
            router.setRoute(
                {
                    paths: ['add-repo'],
                },
                {
                    replace: true,
                },
            );
        } else if (currentRoute.paths[0] === 'add-repo' && folders.length > 0) {
            router.setRoute(
                {
                    paths: ['home'],
                },
                {
                    replace: true,
                },
            );
        }
    } catch (error) {
        console.error('refreshFolderInfo failed', error);
        reportClientError(error, 'refreshFolderInfo');
    }
}
