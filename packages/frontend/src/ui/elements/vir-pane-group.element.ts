// cspell:words titlebar, grabbable

import {
    PaneKind,
    type AgentProfile,
    type FolderInfo,
    type FolderSessions,
    type SessionMeta,
} from '@agent-storm/common';
import {css, defineElement, defineElementEvent, html, listen, repeat} from 'element-vir';
import {
    HorizontalAnchor,
    renderMenuItemEntries,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraMenuTrigger,
    ViraSize,
    viraThemeByKeys,
    type ViraMenuItemEntry,
} from 'vira';
import {
    getSessionAgentProfilePresentation,
    resolveAgentProfileForPresentation,
} from '../../util/agent-profiles.js';
import {
    closeSession,
    createSession,
    getFolderSessions,
    renameSession,
    resetAiSession,
    restartPane,
    setSessionAgentProfile,
} from '../../util/api-client.js';
import {moveTabGroup, type PaneAttentionRequest} from '../../util/interaction-state.js';
import {localStorageClient, paneSplit} from '../../util/local-storage-client.js';
import {type FrontendTab} from '../../util/router.js';
import {ScreenSize} from '../../util/screen-size.js';
/**
 * Type-only: the diff pane pulls in the whole CodeMirror suite, which a static import would parse
 * on every app boot even for users who never open a Diff tab. Splitting it out defers ~90KB
 * minified. The class is loaded on demand when the Diff tab is first opened, in `render` below.
 */
import {VirAgentProfilePickerModal} from './vir-agent-profile-picker-modal.element.js';
import type {VirDiffPane} from './vir-diff-pane.element.js';
import {VirGithubPane} from './vir-github-pane.element.js';
import {VirProgressTracker, type MergeStepActionDetail} from './vir-progress-tracker.element.js';
import {VirTerminal} from './vir-terminal.element.js';

/** Tab label: the user's name when set, otherwise the tab's 1-based position. */
function sessionLabel(session: Readonly<SessionMeta>, index: number): string {
    return session.name || String(index + 1);
}

/**
 * Resolve a 1-based URL index to a live session. An index can outlive the session it referenced
 * (the tab was closed, or the folder's list shrank), so anything out of range falls back to the
 * first session rather than rendering an empty pane.
 */
function sessionAtIndex(
    sessions: ReadonlyArray<Readonly<SessionMeta>>,
    oneBasedIndex: number,
): SessionMeta | undefined {
    return sessions[oneBasedIndex - 1] || sessions[0];
}

type TabButton = {
    label: string;
    tab: FrontendTab;
    tabs: ReadonlyArray<FrontendTab>;
    isActive: boolean;
};

function clampSplit(value: number): number {
    if (!Number.isFinite(value)) {
        return paneSplit.default;
    }
    return Math.min(paneSplit.max, Math.max(paneSplit.min, value));
}

export const VirPaneGroup = defineElement<{
    folder: string;
    aiHidden: boolean;
    /**
     * True when this pane-group is the user's currently focused folder. Forwarded to each
     * `VirTerminal` so they can re-fit and push a fresh size to the server when transitioning to
     * visible — a CSS-hidden pane may have missed window-resize events while it was `display:
     * none`.
     */
    active: boolean;
    /**
     * Currently-active tab. Driven by the `?tab=...` param at the app level so the URL is the
     * source of truth. On desktop, both `ai` and `shell` render the CLI layout (split panes); on
     * mobile each value shows exactly one pane.
     */
    activeTab: FrontendTab;
    /**
     * URL of the pull request on this folder's branch, or empty when it has none. Non-empty is the
     * only condition for showing the GitHub tab — the pane fetches the PR's details itself.
     */
    prUrl: string;
    /**
     * Coarse viewport bucket from `vir-app`'s state. Controls whether the CLI panes get one shared
     * tab or one each, and the pane-visibility rules. Updates as the user resizes the window.
     */
    screenSize: ScreenSize;
    /**
     * 1-based index of the active session tab for each pane, straight from the URL. Two values
     * because desktop shows both panes at once, so each has its own independent selection. An index
     * past the end of the folder's list falls back to the first session.
     */
    aiSessionIndex: number;
    shellSessionIndex: number;
    agentProfiles: ReadonlyArray<AgentProfile>;
    /** Resolved folder/repo/global profile used by tabs whose stored profile id is empty or stale. */
    folderAgentProfileId: string;
    /**
     * This folder's info, for the merge-step tracker in the tab bar. Undefined while the first
     * folder-info poll is still in flight, which renders no tracker rather than an empty one.
     */
    folderInfo: Readonly<FolderInfo> | undefined;
}>()({
    tagName: 'vir-pane-group',
    events: {
        /**
         * Emitted when the user clicks one of the tab buttons. Parent should update the `?tab=...`
         * URL param to the requested value (the actual route paths stay the same).
         */
        tabRequested: defineElementEvent<FrontendTab>(),
        attentionRequested: defineElementEvent<PaneAttentionRequest>(),
        attentionCleared: defineElementEvent<PaneAttentionRequest>(),
        /**
         * Emitted when the user selects (or creates, or closes into) a different session tab.
         * Carries the 1-based index the URL should now hold for that pane kind.
         */
        sessionRequested: defineElementEvent<{kind: PaneKind; index: number}>(),
        /** Forwarded straight up from the tab bar's merge-step tracker; the app owns the effects. */
        mergeStepActionRequested: defineElementEvent<MergeStepActionDetail>(),
    },
    state() {
        return {
            split: localStorageClient.paneSplit.read(),
            dragging: false,
            /**
             * Session tab lists for this folder, both kinds. Undefined until the first `/sessions`
             * load resolves; the panes render nothing until then so a terminal never mounts against
             * a guessed session id.
             */
            sessions: undefined as FolderSessions | undefined,
            sessionsRequested: false,
            sessionsError: undefined as string | undefined,
            /**
             * Per-session remount counters, keyed `${kind}:${sessionId}`. Bumping one forces its
             * `VirTerminal` to unmount and remount, which is how a restart gets a fresh socket
             * against the newly-spawned PTY (the terminal bakes its connection into `onDomCreated`,
             * which does not re-run on input changes).
             */
            restartKeys: {} as Record<string, number | undefined>,
            /**
             * Which pane last received focus inside this group. Sticky across window blur/focus
             * cycles: a `:focus-within` CSS-based highlight loses match when the user cmd+tabs away
             * (xterm's hidden textarea blurs and doesn't reliably regain focus through the shadow
             * boundary on return), so we mirror focus into local state and drive the highlight off
             * that instead. Undefined before the user has clicked into either pane.
             */
            focusedKind: undefined as PaneKind | undefined,
            tabOrder: localStorageClient.tabOrder.read(),
            draggedTab: undefined as FrontendTab | undefined,
            dropTargetTab: undefined as FrontendTab | undefined,
            dropPosition: undefined as 'before' | 'after' | undefined,
            unsubscribeTabOrder: undefined as (() => void) | undefined,
            /**
             * Holds the lazily-imported diff pane class once the user first opens the Diff tab, and
             * is never cleared. Doubles as the mount flag it replaced: the diff pane costs nothing
             * while hidden (it holds no socket and no subprocess), so keeping it mounted preserves
             * its selected file and scroll position across tab switches.
             */
            diffPane: undefined as typeof VirDiffPane | undefined,
            /** Guards against firing a second dynamic import while the first is still in flight. */
            diffPaneLoading: false,
            /** Same lazy-mount-then-keep pattern as `diffPane` above, for the GitHub pane. */
            githubMounted: false,
            profilePickerOpen: false,
            profilePickerMode: 'new' as 'new' | 'switch',
            profilePickerSessionId: undefined as string | undefined,
            profilePickerSelection: '',
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            color: var(--app-text);
            background: var(--app-bg);
            font-family: var(--app-font-sans, ui-sans-serif, system-ui, sans-serif);
        }

        /*
         * Mobile-only strip naming the active folder. Sits above the tab bar and has to fully
         * contain vir-app's absolutely-positioned hamburger (top-left of the stage, 6px inset on a
         * 24px button), so the tab bar below it stays clear of the hamburger and needs no left
         * padding of its own. 32px is that button's extent and nothing more — this strip is pure
         * overhead on a phone screen. The symmetric horizontal padding keeps the name centered
         * while clearing the hamburger.
         */
        .folder-name-bar {
            flex-grow: 0;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            min-height: 44px;
            padding: 0 44px;
            background: var(--app-chrome-bg);
            border-bottom: 1px solid var(--app-border);
        }

        .folder-name-label {
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-family: inherit;
            font-size: 13px;
            font-weight: 600;
            color: var(--app-text);
        }

        .tab-bar {
            display: flex;
            align-items: center;
            gap: 3px;
            flex: 0 0 auto;
            min-height: 48px;
            box-sizing: border-box;
            padding: 7px 12px;
            background: var(--app-chrome-bg);
            border-bottom: 1px solid var(--app-border);
            font-family: inherit;
            font-size: 12px;
        }

        /*
         * The tracker takes whatever width is left after the tab buttons and scrolls internally, so
         * a long step list never pushes the buttons around or wraps the bar.
         */
        ${VirProgressTracker} {
            flex: 1 1 auto;
            min-width: 0;
            margin-left: 10px;
        }

        .desktop-folder-name {
            min-width: 0;
            max-width: min(34%, 320px);
            margin-right: 13px;
            padding-right: 16px;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            color: var(--app-muted);
            border-right: 1px solid var(--app-border);
            font-size: 12px;
            font-weight: 550;
        }

        .tab {
            appearance: none;
            background: transparent;
            border: 1px solid transparent;
            border-radius: var(--app-radius-sm);
            min-height: 30px;
            padding: 5px 12px;
            cursor: grab;
            color: var(--app-muted);
            font: inherit;
            font-weight: 500;
            transition:
                color 140ms ease,
                background-color 140ms ease,
                border-color 140ms ease;
        }

        .tab:active {
            cursor: grabbing;
        }

        .tab[data-dragging] {
            opacity: 0.45;
        }

        .tab[data-drop-before] {
            box-shadow: -3px 0 0 var(--app-accent);
        }

        .tab[data-drop-after] {
            box-shadow: 3px 0 0 var(--app-accent);
        }

        .tab:hover {
            color: var(--app-text);
            background: var(--app-hover);
        }

        .tab[data-selected] {
            color: var(--app-text);
            background: var(--app-active);
            border-color: var(--app-border);
            box-shadow: 0 1px 1px rgba(0, 0, 0, 0.04);
        }

        .tab:focus-visible {
            outline: 2px solid var(--app-accent);
            outline-offset: 2px;
        }

        .body {
            display: flex;
            flex-direction: row;
            flex: 1 1 auto;
            min-height: 0;
            width: 100%;
            position: relative;
            background: var(--app-bg);
        }

        .diff-pane,
        .github-pane,
        .cli-panes {
            position: absolute;
            inset: 0;
            display: flex;
            flex-direction: row;
            overflow: hidden;
            box-sizing: border-box;
        }

        .diff-pane[data-hidden],
        .github-pane[data-hidden],
        .cli-panes[data-hidden] {
            /*
             * Keep the hidden side mounted so its scroll position and, for the terminals, their
             * live PTY sockets survive a tab switch. Hiding by visibility preserves all of that,
             * and killing pointer events makes the hidden side inert to clicks.
             */
            visibility: hidden;
            pointer-events: none;
        }

        .pane {
            flex-basis: 0;
            min-width: 0;
            min-height: 0;
            overflow: hidden;
            background: var(--app-surface);
            border: 1px solid var(--app-border);
            border-radius: var(--app-radius-md);
            box-shadow: var(--app-pane-shadow);
            transition:
                border-color 160ms ease,
                box-shadow 160ms ease,
                filter 160ms ease;
            /* Column so the session sub-tab strip sits above the terminal in normal flow. */
            display: flex;
            flex-direction: column;
            /* Anchor for .session-add-floating. */
            position: relative;
        }

        .ai-pane {
            flex-grow: var(--ai-grow, 0.5);
        }

        .shell-pane {
            flex-grow: var(--shell-grow, 0.5);
        }

        /* Dim whichever pane isn't the last-focused one so it's obvious which one keystrokes
           will land in. Driven by an explicit data attribute (see focusedKind in state) rather
           than :focus-within so the highlight survives cmd+tab away/back — xterm's hidden
           textarea blurs on window blur and doesn't reliably refocus on return, which would
           otherwise drop the indicator. */
        .pane[data-pane-focused='false'] {
            filter: brightness(0.91) saturate(0.92);
        }

        .pane[data-pane-focused='true'] {
            border-color: var(--app-border-strong);
            box-shadow:
                0 0 0 1px var(--app-accent-soft),
                var(--app-pane-shadow);
        }

        /*
         * Session sub-tab strip, nested under the CLI/Code (or AI/Shell/Code) tab bar. Rendered only
         * when a pane has more than one session so single-session users lose no vertical space; the
         * "+" control lives in the pane's hover affordance instead (see .session-add).
         */
        .session-bar {
            flex-grow: 0;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            gap: 2px;
            padding: 2px 4px;
            box-sizing: border-box;
            /*
             * Must stay overflow: visible. Any scroll/hidden value here establishes a clipping box
             * that cuts off each tab's pop-up menu — and setting only overflow-x makes overflow-y
             * compute to auto, so it clips vertically too. Tabs wrap to a second line instead of
             * scrolling; their labels are usually a single digit, so wrapping is rare.
             */
            flex-wrap: wrap;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 11px;
            /* Keep the strip from being squeezed out when the terminal wants all the height. */
            min-height: 26px;
        }

        .session-tab {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            flex-shrink: 0;
            padding: 2px 4px 2px 8px;
            border: 1px solid transparent;
            border-radius: 4px;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            background: transparent;
            font: inherit;
            max-width: 160px;
        }

        .session-tab:hover {
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            background: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        .session-tab[data-selected] {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            border-color: ${viraThemeByKeys.blue.foreground.decoration.foreground.value};
        }

        .session-tab-label {
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        .profile-badge {
            appearance: none;
            min-width: 0;
            max-width: 120px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding: 1px 6px;
            border: 1px solid var(--app-border);
            border-radius: 999px;
            color: var(--app-muted);
            background: var(--app-surface-raised);
            font: inherit;
            font-size: 10px;
            line-height: 1.4;
            cursor: pointer;
        }

        .profile-badge:hover,
        .profile-badge:focus-visible {
            color: var(--app-text);
            border-color: var(--app-border-strong);
        }

        .pane-body {
            /* Fill whatever the session strip leaves behind. */
            flex-grow: 1;
            flex-shrink: 1;
            min-height: 0;
        }

        /*
         * When a pane has a single session there's no tab strip, so this is the only way to create a
         * second one. Floated over the terminal's top-right rather than taking flow space, and only
         * opaque on pane hover, so a user who never wants multiple sessions never sees it. Absolute
         * positioning (rather than collapsing the strip's height) avoids re-triggering an xterm refit
         * on every hover.
         */
        .session-floating-controls {
            position: absolute;
            top: 2px;
            right: 2px;
            z-index: 2;
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .session-add-floating {
            opacity: 0;
            transition: opacity 120ms ease;
        }

        .pane:hover .session-add-floating,
        .session-add-floating:focus-visible {
            opacity: 1;
        }

        .session-error {
            padding: 2px 6px;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 11px;
        }

        .divider {
            flex: 0 0 9px;
            position: relative;
            cursor: col-resize;
            background: transparent;
            /* Sit above the panes so the hit-area extension below catches the pointer
               instead of being eaten by terminal mousedown handlers. */
            z-index: 1;
            touch-action: none;
        }

        .divider::after {
            content: '';
            position: absolute;
            top: 0;
            bottom: 0;
            left: 4px;
            width: 1px;
            background: var(--app-border);
            transition: background 140ms ease;
        }

        .divider:hover::after,
        .divider.dragging::after {
            background: var(--app-accent);
        }

        .cli-panes {
            padding: 8px;
        }

        /*
         * Mobile layout overrides: hide the inactive pane and the resize divider so the active
         * pane fills the available area. Driven by a data-mobile attribute on .cli-panes (toggled
         * from the render based on the screenSize input).
         */
        .cli-panes[data-mobile] .divider,
        .cli-panes[data-mobile] .pane[data-hidden] {
            display: none;
        }

        .cli-panes[data-mobile] .pane:not([data-hidden]) {
            flex-grow: 1;
        }

        .cli-panes[data-mobile] {
            padding: 0;
        }

        .cli-panes[data-mobile] .pane {
            border: none;
            border-radius: 0;
            box-shadow: none;
        }

        .tab-bar[data-mobile] {
            min-height: 44px;
            padding: 6px 8px;
        }

        .tab-bar[data-mobile] .tab {
            flex: 1 1 0;
        }
    `,
    init({updateState}) {
        updateState({
            unsubscribeTabOrder: localStorageClient.tabOrder.subscribe((tabOrder) => {
                updateState({
                    tabOrder,
                });
            }),
        });
    },
    cleanup({state}) {
        state.unsubscribeTabOrder?.();
    },
    render({inputs, state, updateState, host, dispatch, events}) {
        /**
         * Load this folder's session tabs once per mount. The pane group is keyed by folder up in
         * `vir-app`, so a folder switch mounts a fresh element and re-runs this.
         */
        if (!state.sessionsRequested) {
            updateState({
                sessionsRequested: true,
            });
            void getFolderSessions({
                folder: inputs.folder,
            })
                .then((sessions) => {
                    updateState({
                        sessions,
                        sessionsError: undefined,
                    });
                })
                .catch((error: unknown) => {
                    updateState({
                        sessionsError: error instanceof Error ? error.message : String(error),
                    });
                });
        }

        /** Replace the local list after any mutation so tab order and names match the server. */
        const applySessions = (sessions: FolderSessions) => {
            updateState({
                sessions,
                sessionsError: undefined,
            });
        };

        const reportSessionError = (error: unknown) => {
            updateState({
                sessionsError: error instanceof Error ? error.message : String(error),
            });
        };

        const bumpRestartKey = (kind: PaneKind, sessionId: string) => {
            const key = `${kind}:${sessionId}`;
            updateState({
                restartKeys: {
                    ...state.restartKeys,
                    [key]: (state.restartKeys[key] || 0) + 1,
                },
            });
        };

        const sessionIndexFor = (kind: PaneKind): number =>
            kind === PaneKind.Ai ? inputs.aiSessionIndex : inputs.shellSessionIndex;

        const createSessionWithProfile = (kind: PaneKind, agentProfileId = '') => {
            void createSession({
                folder: inputs.folder,
                kind,
                agentProfileId: kind === PaneKind.Ai ? agentProfileId || undefined : undefined,
            })
                .then((sessions) => {
                    applySessions(sessions);
                    /** Jump to the session just created — it's appended, so it's the last one. */
                    dispatch(
                        new events.sessionRequested({
                            kind,
                            index: sessions[kind].length,
                        }),
                    );
                })
                .catch(reportSessionError);
        };

        const onAddSession = (kind: PaneKind) => {
            if (kind === PaneKind.Ai) {
                updateState({
                    profilePickerOpen: true,
                    profilePickerMode: 'new',
                    profilePickerSessionId: undefined,
                    profilePickerSelection: '',
                });
            } else {
                createSessionWithProfile(kind);
            }
        };

        const openProfileSwitch = (session: Readonly<SessionMeta>) => {
            const storedChoice = inputs.agentProfiles.some(
                (profile) => profile.id === session.agentProfileId,
            )
                ? session.agentProfileId
                : '';
            updateState({
                profilePickerOpen: true,
                profilePickerMode: 'switch',
                profilePickerSessionId: session.id,
                profilePickerSelection: storedChoice,
            });
        };

        const onRenameSession = (kind: PaneKind, session: Readonly<SessionMeta>, index: number) => {
            /**
             * A native prompt rather than a modal: it's the smallest thing that does the job, and
             * `vir-terminal` already uses `window.prompt` for its paste fallback. Worth upgrading
             * to an inline input if renaming turns out to be frequent.
             */
            const nextName = window.prompt(
                'Session name (empty to use its number):',
                session.name || String(index + 1),
            );
            if (nextName == undefined) {
                return;
            }
            void renameSession({
                folder: inputs.folder,
                kind,
                sessionId: session.id,
                name: nextName,
            })
                .then(applySessions)
                .catch(reportSessionError);
        };

        const onRestartSession = (kind: PaneKind, session: Readonly<SessionMeta>) => {
            void restartPane({
                folder: inputs.folder,
                kind,
                sessionId: session.id,
            })
                .then(() => bumpRestartKey(kind, session.id))
                .catch(reportSessionError);
        };

        const onResetAiSession = (session: Readonly<SessionMeta>) => {
            void resetAiSession({
                folder: inputs.folder,
                sessionId: session.id,
            })
                .then(() => bumpRestartKey(PaneKind.Ai, session.id))
                .catch(reportSessionError);
        };

        const profileForSession = (session: Readonly<SessionMeta>): AgentProfile => {
            return resolveAgentProfileForPresentation({
                profiles: inputs.agentProfiles,
                inheritedProfileId: inputs.folderAgentProfileId,
                explicitProfileId: session.agentProfileId,
            });
        };

        const onCloseSession = (kind: PaneKind, session: Readonly<SessionMeta>, index: number) => {
            void closeSession({
                folder: inputs.folder,
                kind,
                sessionId: session.id,
            })
                .then((sessions) => {
                    applySessions(sessions);
                    /**
                     * Keep the selection in range after a removal. Closing the active tab (or any
                     * tab before it) shifts everything left, so clamp to the new length.
                     */
                    const nextIndex = Math.min(
                        Math.max(
                            1,
                            sessionIndexFor(kind) > index
                                ? sessionIndexFor(kind) - 1
                                : sessionIndexFor(kind),
                        ),
                        sessions[kind].length,
                    );
                    dispatch(
                        new events.sessionRequested({
                            kind,
                            index: nextIndex,
                        }),
                    );
                })
                .catch(reportSessionError);
        };

        /**
         * Per-tab menu. Restart / reset live here rather than on the folder's sidebar row because
         * with several sessions per pane, "restart the AI" is only meaningful against a specific
         * one.
         */
        const buildSessionMenuEntries = ({
            kind,
            session,
            index,
            sessionCount,
        }: Readonly<{
            kind: PaneKind;
            session: Readonly<SessionMeta>;
            index: number;
            sessionCount: number;
        }>): ReadonlyArray<ViraMenuItemEntry> => {
            /**
             * Annotated so each literal widens to `ViraMenuItemEntry` (whose `content` is an
             * `HtmlInterpolation`, not a `string`) before the conditional entries are filtered
             * out.
             */
            const entries: ReadonlyArray<ViraMenuItemEntry | undefined> = [
                {
                    content: 'Rename',
                    onClick: () => onRenameSession(kind, session, index),
                },
                {
                    content: 'Restart',
                    onClick: () => onRestartSession(kind, session),
                },
                kind === PaneKind.Ai
                    ? {
                          content: 'Change agent profile',
                          onClick: () => openProfileSwitch(session),
                      }
                    : undefined,
                kind === PaneKind.Ai && profileForSession(session).newSessionCommand
                    ? {
                          content: 'New AI session',
                          onClick: () => onResetAiSession(session),
                      }
                    : undefined,
                {
                    content: 'New tab',
                    onClick: () => onAddSession(kind),
                },
                /** The last remaining tab can't be closed — a pane with no tabs has nothing to show. */
                sessionCount > 1
                    ? {
                          content: 'Close',
                          onClick: () => onCloseSession(kind, session, index),
                      }
                    : undefined,
            ];
            return entries.filter((entry): entry is ViraMenuItemEntry => !!entry);
        };

        const renderProfileBadge = (session: Readonly<SessionMeta>) => {
            const presentation = getSessionAgentProfilePresentation({
                session,
                index: 0,
                profiles: inputs.agentProfiles,
                inheritedProfileId: inputs.folderAgentProfileId,
            });
            return html`
                <button
                    type="button"
                    class="profile-badge"
                    title=${`Configured profile: ${presentation.profileName}. Running command changes on restart.`}
                    ${listen('click', (event) => {
                        event.stopPropagation();
                        openProfileSwitch(session);
                    })}
                >
                    ${presentation.profileName}
                </button>
            `;
        };

        /** Sole new-tab affordance when the multi-session strip is hidden. */
        const renderFloatingAddSession = (kind: PaneKind) => html`
            <span class="session-floating-controls">
                ${kind === PaneKind.Ai && state.sessions?.ai[0]
                    ? renderProfileBadge(state.sessions.ai[0])
                    : ''}
                <${ViraButton.assign({
                    buttonSize: ViraSize.Small,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    color: ViraColorVariant.Neutral,
                    text: '+',
                })}
                    class="session-add-floating"
                    title=${kind === PaneKind.Ai ? 'New AI tab' : 'New shell tab'}
                    ${listen('click', () => onAddSession(kind))}
                ></${ViraButton}>
            </span>
        `;

        const renderSessionBar = (
            kind: PaneKind,
            sessions: ReadonlyArray<Readonly<SessionMeta>>,
        ) => {
            const activeSession = sessionAtIndex(sessions, sessionIndexFor(kind));
            return html`
                <div class="session-bar" role="tablist" aria-label="Sessions">
                    ${repeat(
                        sessions,
                        (session) => session.id,
                        (session, index) => html`
                            <div
                                class="session-tab"
                                role="tab"
                                ?data-selected=${session.id === activeSession?.id}
                                aria-selected=${session.id === activeSession?.id}
                                title=${session.name || `Session ${index + 1}`}
                                ${listen('click', () =>
                                    dispatch(
                                        new events.sessionRequested({
                                            kind,
                                            index: index + 1,
                                        }),
                                    ),
                                )}
                            >
                                <span class="session-tab-label">
                                    ${sessionLabel(session, index)}
                                </span>
                                ${kind === PaneKind.Ai ? renderProfileBadge(session) : ''}
                                <span ${listen('click', (event) => event.stopPropagation())}>
                                    <${ViraMenuTrigger.assign({
                                        horizontalAnchor: HorizontalAnchor.Right,
                                    })}>
                                        <${ViraButton.assign({
                                            buttonSize: ViraSize.Small,
                                            buttonEmphasis: ViraEmphasis.Subtle,
                                            color: ViraColorVariant.Neutral,
                                            text: '⋮',
                                        })}
                                            slot=${ViraMenuTrigger.slotNames[
                                                'vira-menu-trigger-trigger'
                                            ]}
                                            title="Session actions"
                                        ></${ViraButton}>
                                        ${renderMenuItemEntries(
                                            buildSessionMenuEntries({
                                                kind,
                                                session,
                                                index,
                                                sessionCount: sessions.length,
                                            }),
                                        )}
                                    </${ViraMenuTrigger}>
                                </span>
                            </div>
                        `,
                    )}
                    <${ViraButton.assign({
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                        text: '+',
                    })}
                        class="session-add"
                        title=${kind === PaneKind.Ai ? 'New AI tab' : 'New shell tab'}
                        ${listen('click', () => onAddSession(kind))}
                    ></${ViraButton}>
                </div>
            `;
        };

        /**
         * Mount exactly one terminal per pane: the active session's. Inactive sessions keep their
         * PTY alive on the daemon and replay scrollback on reattach, so holding a socket open for
         * each would buy nothing but idle connections. The `repeat` key combines the session id
         * with its restart counter so both switching tabs and restarting force a fresh element —
         * `VirTerminal` opens its socket in `onDomCreated`, which never re-runs for a reused
         * element.
         */
        const renderPaneTerminal = (
            kind: PaneKind,
            sessions: ReadonlyArray<Readonly<SessionMeta>>,
        ) => {
            const session = sessionAtIndex(sessions, sessionIndexFor(kind));
            if (!session) {
                return '';
            }
            const sessionRestartKey = state.restartKeys[`${kind}:${session.id}`] || 0;
            const mountKey = `${session.id}:${sessionRestartKey}`;
            return repeat(
                [mountKey],
                (key) => key,
                () => html`
                    <${VirTerminal.assign({
                        folder: inputs.folder,
                        kind,
                        sessionId: session.id,
                        active: inputs.active,
                        showAccessoryKeys: inputs.screenSize === ScreenSize.Mobile,
                    })}
                        ${listen(VirTerminal.events.attentionRequested, (event) =>
                            dispatch(new events.attentionRequested(event.detail)),
                        )}
                    ></${VirTerminal}>
                `,
            );
        };

        const focusPane = (kind: PaneKind, sessions: ReadonlyArray<Readonly<SessionMeta>>) => {
            updateState({
                focusedKind: kind,
            });
            const session = sessionAtIndex(sessions, sessionIndexFor(kind));
            if (session) {
                dispatch(
                    new events.attentionCleared({
                        folder: inputs.folder,
                        kind,
                        sessionId: session.id,
                    }),
                );
            }
        };

        const split = clampSplit(state.split);
        host.style.setProperty('--ai-grow', String(split));
        host.style.setProperty('--shell-grow', String(1 - split));

        const onDividerPointerDown = (event: PointerEvent) => {
            event.preventDefault();
            /**
             * Pointer Events unify mouse, touch, and pen so the same handler covers desktop and
             * iPad. `setPointerCapture` keeps `pointermove`/`pointerup` flowing to this element
             * even if the finger drifts off it mid-drag.
             */
            const divider = event.currentTarget;
            if (divider instanceof Element) {
                divider.setPointerCapture(event.pointerId);
            }

            // Mute selection + force resize cursor globally during drag — otherwise crossing
            // into the xterm canvas flips the cursor to i-beam and selects terminal text.
            const previousUserSelect = document.body.style.userSelect;
            const previousCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            let latestSplit = split;
            updateState({
                dragging: true,
            });

            const onMove = (moveEvent: PointerEvent) => {
                if (moveEvent.pointerId !== event.pointerId) {
                    return;
                }
                const rect = host.getBoundingClientRect();
                if (rect.width <= 0) {
                    return;
                }
                latestSplit = clampSplit((moveEvent.clientX - rect.left) / rect.width);
                updateState({
                    split: latestSplit,
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
                    dragging: false,
                });
                localStorageClient.paneSplit.write(latestSplit);
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        };

        const onDividerDoubleClick = () => {
            updateState({
                split: paneSplit.default,
            });
            localStorageClient.paneSplit.write(paneSplit.default);
        };

        /**
         * `focusin` bubbles through the shadow boundary (composed events), so xterm's hidden
         * textarea gaining focus reaches this listener via the outer `.pane` div. Default the
         * highlight to whichever pane is visible first when nothing has been focused yet, so the
         * initial render doesn't show both panes dimmed.
         */
        const focusedKind = state.focusedKind ?? (inputs.aiHidden ? PaneKind.Shell : PaneKind.Ai);
        const aiFocused = focusedKind === PaneKind.Ai;
        const shellFocused = focusedKind === PaneKind.Shell;

        const isDiffTab = inputs.activeTab === 'diff';
        /**
         * A `?tab=github` URL for a folder whose PR has gone away (merged and aged out, branch
         * force-pushed) falls back to the CLI layout instead of showing an empty pane. The URL
         * keeps its value, so the tab and its pane come back if the PR reappears.
         */
        const isGithubTab = inputs.activeTab === 'github' && !!inputs.prUrl;
        const isMobile = inputs.screenSize === ScreenSize.Mobile;
        /** Basename of the folder path — matches how folder names are derived elsewhere. */
        const folderName = inputs.folder.split('/').findLast(Boolean) || inputs.folder;
        /**
         * Pane visibility decision matrix:
         *
         * - Desktop, tab=ai|shell → both AI + Shell visible (the existing split layout).
         * - Desktop, tab=diff|github → that pane visible (both terminals hidden).
         * - Mobile, tab=ai → only AI pane visible.
         * - Mobile, tab=shell → only Shell pane visible.
         * - Mobile, tab=diff|github → only that pane visible.
         */
        const showCliPanes = !isDiffTab && !isGithubTab;
        const showAiPane = showCliPanes && (!isMobile || inputs.activeTab === 'ai');
        const showShellPane = showCliPanes && (!isMobile || inputs.activeTab === 'shell');

        /**
         * Whether to actually mount each terminal (vs. just hide it with CSS). On desktop both are
         * always mounted so the split view is live and switching tabs is instant. On mobile only
         * the visible pane's terminal is mounted, so an inactive folder never holds a socket and
         * even the active folder holds at most one `/pty` WebSocket at a time — switching
         * tabs/panes closes the old socket (the daemon keeps the PTY and replays scrollback on the
         * next attach). This keeps phones from accumulating idle sockets.
         */
        const mountAiTerminal = !isMobile || showAiPane;
        const mountShellTerminal = !isMobile || showShellPane;

        if (isDiffTab && !state.diffPane && !state.diffPaneLoading) {
            updateState({
                diffPaneLoading: true,
            });
            void import('./vir-diff-pane.element.js').then(({VirDiffPane}) => {
                updateState({
                    diffPane: VirDiffPane,
                    diffPaneLoading: false,
                });
            });
        }

        if (isGithubTab && !state.githubMounted) {
            updateState({
                githubMounted: true,
            });
        }

        /**
         * Tab bar layout differs by screen size:
         *
         * - Desktop: CLI + Diff. The CLI tab is the active one when `activeTab` is `ai` or `shell` —
         *   the user can't tell them apart on desktop (both panes are visible) so we collapse them
         *   into one button. Clicking CLI sets `tab=ai` as a stable default.
         * - Mobile: AI, Shell, Diff, each mapping directly to the URL param.
         *
         * Both layouts gain a GitHub tab only while the branch has a PR.
         */
        const tabIndex = (tab: FrontendTab) => state.tabOrder.indexOf(tab);
        const desktopTabButtons: ReadonlyArray<TabButton> = [
            {
                label: 'CLI',
                tab: 'ai',
                tabs: [
                    'ai',
                    'shell',
                ],
                isActive: showCliPanes,
            },
            {
                label: 'Diff',
                tab: 'diff',
                tabs: ['diff'],
                isActive: isDiffTab,
            },
            ...(inputs.prUrl
                ? [
                      {
                          label: 'GitHub',
                          tab: 'github' as const,
                          tabs: ['github'] as const,
                          isActive: isGithubTab,
                      },
                  ]
                : []),
        ];
        const tabButtons: ReadonlyArray<TabButton> = isMobile
            ? state.tabOrder
                  .filter((tab) => tab !== 'github' || !!inputs.prUrl)
                  .map((tab): TabButton => {
                      return {
                          label:
                              tab === 'ai'
                                  ? 'AI'
                                  : tab === 'shell'
                                    ? 'Shell'
                                    : tab === 'diff'
                                      ? 'Diff'
                                      : 'GitHub',
                          tab,
                          tabs: [tab],
                          isActive: inputs.activeTab === tab,
                      };
                  })
            : desktopTabButtons.toSorted(
                  (a, b) => Math.min(...a.tabs.map(tabIndex)) - Math.min(...b.tabs.map(tabIndex)),
              );

        const requestTab = (tab: FrontendTab) => {
            dispatch(new events.tabRequested(tab));
        };

        const clearTabDrag = () => {
            updateState({
                draggedTab: undefined,
                dropTargetTab: undefined,
                dropPosition: undefined,
            });
        };

        const tabsForButton = (tab: FrontendTab): ReadonlyArray<FrontendTab> =>
            !isMobile && tab === 'ai'
                ? [
                      'ai',
                      'shell',
                  ]
                : [tab];

        const closeProfilePicker = () => {
            updateState({
                profilePickerOpen: false,
                profilePickerSessionId: undefined,
                profilePickerSelection: '',
            });
        };

        const confirmProfilePicker = (agentProfileId: string) => {
            if (state.profilePickerMode === 'new') {
                closeProfilePicker();
                createSessionWithProfile(PaneKind.Ai, agentProfileId);
                return;
            }
            const session = state.sessions?.ai.find(
                (entry) => entry.id === state.profilePickerSessionId,
            );
            if (!session) {
                closeProfilePicker();
                return;
            }
            const currentStoredChoice = inputs.agentProfiles.some(
                (profile) => profile.id === session.agentProfileId,
            )
                ? session.agentProfileId
                : '';
            if (agentProfileId === currentStoredChoice) {
                closeProfilePicker();
                return;
            }
            void setSessionAgentProfile({
                folder: inputs.folder,
                sessionId: session.id,
                agentProfileId,
            })
                .then((sessions) => {
                    applySessions(sessions);
                    bumpRestartKey(PaneKind.Ai, session.id);
                    closeProfilePicker();
                })
                .catch(reportSessionError);
        };

        return html`
            ${isMobile
                ? html`
                      <div class="folder-name-bar" title=${inputs.folder}>
                          <span class="folder-name-label">${folderName}</span>
                      </div>
                  `
                : ''}
            <div class="tab-bar" role="tablist" ?data-mobile=${isMobile}>
                ${isMobile
                    ? ''
                    : html`
                          <span class="desktop-folder-name" title=${inputs.folder}>
                              ${folderName}
                          </span>
                      `}
                ${tabButtons.map(
                    ({label, tab, isActive}) => html`
                        <button
                            type="button"
                            class="tab"
                            role="tab"
                            draggable="true"
                            ?data-selected=${isActive}
                            ?data-dragging=${state.draggedTab === tab}
                            ?data-drop-before=${state.dropTargetTab === tab &&
                            state.dropPosition === 'before'}
                            ?data-drop-after=${state.dropTargetTab === tab &&
                            state.dropPosition === 'after'}
                            aria-selected=${isActive}
                            aria-grabbed=${state.draggedTab === tab}
                            title="Drag to reorder"
                            ${listen('click', () => requestTab(tab))}
                            ${listen('dragstart', (event) => {
                                event.dataTransfer?.setData('text/plain', tab);
                                if (event.dataTransfer) {
                                    event.dataTransfer.effectAllowed = 'move';
                                }
                                updateState({
                                    draggedTab: tab,
                                });
                            })}
                            ${listen('dragover', (event) => {
                                event.preventDefault();
                                if (event.dataTransfer) {
                                    event.dataTransfer.dropEffect = 'move';
                                }
                                const target = event.currentTarget;
                                if (!(target instanceof HTMLElement)) {
                                    return;
                                }
                                const rect = target.getBoundingClientRect();
                                const dropPosition =
                                    event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                                if (
                                    state.dropTargetTab !== tab ||
                                    state.dropPosition !== dropPosition
                                ) {
                                    updateState({
                                        dropTargetTab: tab,
                                        dropPosition,
                                    });
                                }
                            })}
                            ${listen('drop', (event) => {
                                event.preventDefault();
                                const draggedTab = (event.dataTransfer?.getData('text/plain') ||
                                    state.draggedTab) as FrontendTab | undefined;
                                if (!draggedTab || !state.dropPosition) {
                                    clearTabDrag();
                                    return;
                                }
                                localStorageClient.tabOrder.write(
                                    moveTabGroup({
                                        order: state.tabOrder,
                                        draggedTabs: tabsForButton(draggedTab),
                                        targetTabs: tabsForButton(tab),
                                        position: state.dropPosition,
                                    }),
                                );
                                clearTabDrag();
                            })}
                            ${listen('dragend', clearTabDrag)}
                        >
                            ${label}
                        </button>
                    `,
                )}
                ${
                    /**
                     * Never for a worktree root — a repo root has no PR lifecycle, so its tracker
                     * would sit permanently at step one.
                     */
                    inputs.folderInfo && !inputs.folderInfo.isWorktreeRoot
                        ? html`
                              <${VirProgressTracker.assign({
                                  folder: inputs.folderInfo,
                                  screenSize: inputs.screenSize,
                              })}
                                  ${listen(VirProgressTracker.events.stepActionRequested, (event) =>
                                      dispatch(new events.mergeStepActionRequested(event.detail)),
                                  )}
                              ></${VirProgressTracker}>
                          `
                        : ''
                }
            </div>
            <div class="body">
                ${state.diffPane
                    ? html`
                          <div class="diff-pane" ?data-hidden=${!isDiffTab}>
                              <${state.diffPane.assign({
                                  folder: inputs.folder,
                                  active: isDiffTab && inputs.active,
                                  screenSize: inputs.screenSize,
                              })}></${state.diffPane}>
                          </div>
                      `
                    : ''}
                ${state.githubMounted
                    ? html`
                          <div class="github-pane" ?data-hidden=${!isGithubTab}>
                              <${VirGithubPane.assign({
                                  folder: inputs.folder,
                                  active: isGithubTab && inputs.active,
                                  screenSize: inputs.screenSize,
                              })}></${VirGithubPane}>
                          </div>
                      `
                    : ''}
                <div class="cli-panes" ?data-hidden=${!showCliPanes} ?data-mobile=${isMobile}>
                    ${inputs.aiHidden
                        ? ''
                        : html`
                              <div
                                  class="pane ai-pane"
                                  ?data-hidden=${!showAiPane}
                                  data-pane-focused=${aiFocused ? 'true' : 'false'}
                                  ${listen('focusin', () =>
                                      focusPane(PaneKind.Ai, state.sessions?.ai || []),
                                  )}
                              >
                                  ${state.sessions && state.sessions.ai.length > 1
                                      ? renderSessionBar(PaneKind.Ai, state.sessions.ai)
                                      : renderFloatingAddSession(PaneKind.Ai)}
                                  ${state.sessionsError
                                      ? html`
                                            <div class="session-error" role="alert">
                                                ${state.sessionsError}
                                            </div>
                                        `
                                      : ''}
                                  <div class="pane-body">
                                      ${mountAiTerminal && state.sessions
                                          ? renderPaneTerminal(PaneKind.Ai, state.sessions.ai)
                                          : ''}
                                  </div>
                              </div>
                              <div
                                  class="divider ${state.dragging ? 'dragging' : ''}"
                                  role="separator"
                                  aria-orientation="vertical"
                                  title="Drag to resize. Double-click to reset."
                                  ${listen('pointerdown', onDividerPointerDown)}
                                  ${listen('dblclick', onDividerDoubleClick)}
                              ></div>
                          `}
                    <div
                        class="pane shell-pane"
                        ?data-hidden=${!showShellPane}
                        data-pane-focused=${shellFocused ? 'true' : 'false'}
                        ${listen('focusin', () =>
                            focusPane(PaneKind.Shell, state.sessions?.shell || []),
                        )}
                    >
                        ${state.sessions && state.sessions.shell.length > 1
                            ? renderSessionBar(PaneKind.Shell, state.sessions.shell)
                            : renderFloatingAddSession(PaneKind.Shell)}
                        <div class="pane-body">
                            ${mountShellTerminal && state.sessions
                                ? renderPaneTerminal(PaneKind.Shell, state.sessions.shell)
                                : ''}
                        </div>
                    </div>
                </div>
            </div>
            <${VirAgentProfilePickerModal.assign({
                open: state.profilePickerOpen,
                profiles: inputs.agentProfiles,
                inheritedProfileId: inputs.folderAgentProfileId,
                selectedProfileId: state.profilePickerSelection,
                inheritLabel: 'Inherit folder default',
                modalTitle:
                    state.profilePickerMode === 'new'
                        ? 'Choose agent profile for new tab'
                        : 'Change agent profile',
                saveLabel: state.profilePickerMode === 'new' ? 'Create tab' : 'Switch and restart',
                message:
                    state.profilePickerMode === 'new'
                        ? 'The tab is created with this profile before its terminal starts.'
                        : 'Only this tab restarts. The badge shows the profile configured for its next launch.',
            })}
                ${listen(VirAgentProfilePickerModal.events.closeRequested, closeProfilePicker)}
                ${listen(VirAgentProfilePickerModal.events.selectionConfirmed, (event) =>
                    confirmProfilePicker(event.detail),
                )}
            ></${VirAgentProfilePickerModal}>
        `;
    },
});
