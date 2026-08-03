// cspell:words titlebar

import {PaneKind} from '@agent-storm/common';
import {css, defineElement, defineElementEvent, html, listen, repeat} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {ensureVscode, killVscode} from '../../util/api-client.js';
import {moveTabGroup, type PaneAttentionRequest} from '../../util/interaction-state.js';
import {localStorageClient, paneSplit} from '../../util/local-storage-client.js';
import {type FrontendTab} from '../../util/router.js';
import {ScreenSize} from '../../util/screen-size.js';
import {getBackendBaseUrl} from '../../util/service-origin.js';
import {VirTerminal} from './vir-terminal.element.js';

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
     * Currently-active tab — `'ai' | 'shell' | 'code'`. Driven by the `?tab=...` search param up at
     * the app level so the URL is the source of truth. On desktop, both `ai` and `shell` render the
     * CLI layout (split panes); on mobile each value shows exactly one pane.
     */
    activeTab: FrontendTab;
    /**
     * Coarse viewport bucket from `vir-app`'s state. Controls the tab layout (2 tabs vs 3) and the
     * pane-visibility rules. Updates as the user resizes the window.
     */
    screenSize: ScreenSize;
    aiRestartKey: number;
}>()({
    tagName: 'vir-pane-group',
    events: {
        /**
         * Emitted when the user clicks one of the tab buttons. Parent should update the `?tab=...`
         * URL param to the requested value (the actual route paths stay the same).
         */
        tabRequested: defineElementEvent<FrontendTab>(),
        attentionRequested: defineElementEvent<PaneAttentionRequest>(),
    },
    state() {
        return {
            split: localStorageClient.paneSplit.read(),
            dragging: false,
            /**
             * Which pane last received focus inside this group. Sticky across window blur/focus
             * cycles: a `:focus-within` CSS-based highlight loses match when the user cmd+tabs away
             * (xterm's hidden textarea blurs and doesn't reliably regain focus through the shadow
             * boundary on return), so we mirror focus into local state and drive the highlight off
             * that instead. Undefined before the user has clicked into either pane.
             */
            focusedKind: undefined as PaneKind | undefined,
            /**
             * VS Code iframe URL for THIS folder. Set after the first `ensureVscode` resolves; once
             * set, the iframe stays mounted (hidden when CLI tab is active) so its in-memory editor
             * state survives toggling between tabs. Cleared on close-button click.
             */
            vscodeUrl: undefined as string | undefined,
            vscodeLoading: false,
            vscodeError: undefined as string | undefined,
            /**
             * Set true when the user clicks the close (×) button next to the Code tab. While true,
             * the render-time auto-ensure block is suppressed so the just-killed VS Code doesn't
             * immediately respawn during the brief window where `codeTabActive` is still observed
             * as true (the cliTabRequested event needs a round-trip through vir-app's router state
             * before the prop flips). Reset to false when the user explicitly re-requests the Code
             * tab via the tab-bar button.
             */
            vscodeUserClosed: false,
            tabOrder: localStorageClient.tabOrder.read(),
            draggedTab: undefined as FrontendTab | undefined,
            dropTargetTab: undefined as FrontendTab | undefined,
            dropPosition: undefined as 'before' | 'after' | undefined,
            unsubscribeTabOrder: undefined as (() => void) | undefined,
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
         * Mobile-only strip naming the active folder. Sits above the tab bar and is tall enough to
         * fully contain vir-app's absolutely-positioned hamburger (top-left of the stage), so the
         * tab bar below it stays clear of the hamburger and needs no left padding of its own. The
         * symmetric horizontal padding keeps the name centered while clearing the hamburger.
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

        .tab:focus-visible,
        .close-vscode:focus-visible {
            outline: 2px solid var(--app-accent);
            outline-offset: 2px;
        }

        .close-vscode {
            appearance: none;
            background: transparent;
            border: none;
            min-width: 28px;
            min-height: 28px;
            padding: 4px 6px;
            margin-left: 1px;
            border-radius: var(--app-radius-sm);
            cursor: pointer;
            color: var(--app-muted);
            font: inherit;
            line-height: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .close-vscode:hover {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            background-color: var(--app-hover);
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

        .code-pane,
        .cli-panes {
            position: absolute;
            inset: 0;
            display: flex;
            flex-direction: row;
            /*
             * Clip the iframe's negative margin-top so the shifted-up VS Code workbench doesn't
             * overflow into the tab strip above the pane group. See .vscode-iframe below for the
             * offset itself.
             */
            overflow: hidden;
            box-sizing: border-box;
        }

        .code-pane {
            padding: 8px;
        }

        .code-pane[data-hidden],
        .cli-panes[data-hidden] {
            /* Keep the iframe mounted across CLI ↔ Code toggles so VS Code's in-memory editor
               state (open files, scroll positions, terminal contents inside the editor) survives.
               visibility:hidden + pointer-events:none preserves the iframe document while making
               the hidden side click-through inert. */
            visibility: hidden;
            pointer-events: none;
        }

        .vscode-iframe {
            /*
             * Shift the iframe up by VS Code's now-hidden (via visibility: hidden in the proxy's
             * injected CSS) title bar height so the empty slot sits behind the agent-storm tab
             * strip. The titlebar still participates in VS Code's grid layout (we kept its slot,
             * just made the bar invisible) so the workbench's grid math stays correct — only the
             * visible offset is adjusted from this side. Bump --vscode-titlebar-offset if your VS
             * Code version has a different titlebar height; 35px matches stable serve-web today.
             */
            --vscode-titlebar-offset: 35px;
            width: 100%;
            height: calc(100% + var(--vscode-titlebar-offset));
            margin-top: calc(-1 * var(--vscode-titlebar-offset));
            border: 1px solid var(--app-border);
            border-radius: var(--app-radius-md);
            box-shadow: var(--app-pane-shadow);
            /* Wrapper shown behind the VS Code iframe while it loads; track the theme default so it
               doesn't flash white in dark mode (VS Code applies its own theme once loaded). */
            background: var(--app-surface, var(--vira-default-bg, #ffffff));
        }

        .vscode-status {
            flex: 1 1 auto;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: inherit;
            font-size: 13px;
            color: var(--app-muted);
        }

        .vscode-error {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
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

        .pane-body {
            height: 100%;
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

        const isCodeTab = inputs.activeTab === 'code';
        const isMobile = inputs.screenSize === ScreenSize.Mobile;
        /** Basename of the folder path — matches how folder names are derived elsewhere. */
        const folderName = inputs.folder.split('/').findLast(Boolean) || inputs.folder;
        /**
         * Pane visibility decision matrix:
         *
         * - Desktop, tab=ai|shell → both AI + Shell visible (the existing split layout).
         * - Desktop, tab=code → VS Code iframe visible (panes hidden).
         * - Mobile, tab=ai → only AI pane visible (Shell + divider + iframe hidden).
         * - Mobile, tab=shell → only Shell pane visible.
         * - Mobile, tab=code → only iframe visible.
         */
        const showAiPane = !isCodeTab && (!isMobile || inputs.activeTab === 'ai');
        const showShellPane = !isCodeTab && (!isMobile || inputs.activeTab === 'shell');

        /**
         * Lazy: kick off the VS Code spawn the first time the user activates the Code tab. Deferred
         * via microtask so we don't mutate state during render. Once `vscodeUrl` is set the iframe
         * stays mounted across CLI ↔ Code toggles.
         */
        if (
            isCodeTab &&
            !state.vscodeUrl &&
            !state.vscodeLoading &&
            !state.vscodeError &&
            !state.vscodeUserClosed
        ) {
            updateState({
                vscodeLoading: true,
            });
            const folder = inputs.folder;
            void ensureVscode({
                folder,
            })
                .then(({basePath}) => {
                    const url = `${getBackendBaseUrl()}${basePath}/?folder=${encodeURIComponent(folder)}`;
                    updateState({
                        vscodeUrl: url,
                        vscodeLoading: false,
                        vscodeError: undefined,
                    });
                })
                .catch((error: unknown) => {
                    updateState({
                        vscodeLoading: false,
                        vscodeError: error instanceof Error ? error.message : String(error),
                    });
                });
        }

        const onCloseVscode = () => {
            const folder = inputs.folder;
            updateState({
                vscodeUrl: undefined,
                vscodeLoading: false,
                vscodeError: undefined,
                vscodeUserClosed: true,
            });
            void killVscode({
                folder,
            }).catch(() => {
                /* server-side cleanup is best-effort; the iframe is already gone */
            });
            /** If the user closes VS Code while looking at the Code tab, snap back to the AI tab. */
            if (isCodeTab) {
                dispatch(new events.tabRequested('ai'));
            }
        };

        /**
         * Tab bar layout differs by screen size:
         *
         * - Desktop: 2 tabs (CLI, Code). The CLI tab is the active one when `activeTab` is `ai` or
         *   `shell` — the user can't tell them apart on desktop (both panes are visible) so we
         *   collapse them into one button. Clicking CLI sets `tab=ai` as a stable default.
         * - Mobile: 3 tabs (AI, Shell, Code), each mapping directly to the URL param.
         */
        type TabButton = Readonly<{
            label: string;
            tab: FrontendTab;
            tabs: ReadonlyArray<FrontendTab>;
            isActive: boolean;
        }>;
        const tabIndex = (tab: FrontendTab) => state.tabOrder.indexOf(tab);
        const desktopTabButtons: ReadonlyArray<TabButton> = [
            {
                label: 'CLI',
                tab: 'ai',
                tabs: [
                    'ai',
                    'shell',
                ],
                isActive: !isCodeTab,
            },
            {
                label: 'Code',
                tab: 'code',
                tabs: ['code'],
                isActive: isCodeTab,
            },
        ];
        const tabButtons: ReadonlyArray<TabButton> = isMobile
            ? state.tabOrder.map(
                  (tab): TabButton => ({
                      label: tab === 'ai' ? 'AI' : tab === 'shell' ? 'Shell' : 'Code',
                      tab,
                      tabs: [tab],
                      isActive: inputs.activeTab === tab,
                  }),
              )
            : desktopTabButtons.toSorted(
                  (a, b) => Math.min(...a.tabs.map(tabIndex)) - Math.min(...b.tabs.map(tabIndex)),
              );

        const requestTab = (tab: FrontendTab) => {
            /**
             * Reset the user-closed flag on any Code-tab activation so the auto-ensure block fires
             * fresh — without this, after closing VS Code the user would have to click Code, then
             * click somewhere else, then click Code again to actually respawn it.
             */
            if (tab === 'code' && state.vscodeUserClosed) {
                updateState({
                    vscodeUserClosed: false,
                });
            }
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
                                    moveTabGroup(
                                        state.tabOrder,
                                        tabsForButton(draggedTab),
                                        tabsForButton(tab),
                                        state.dropPosition,
                                    ),
                                );
                                clearTabDrag();
                            })}
                            ${listen('dragend', clearTabDrag)}
                        >
                            ${label}
                        </button>
                    `,
                )}
                ${state.vscodeUrl
                    ? html`
                          <button
                              type="button"
                              class="close-vscode"
                              title="Close VS Code for this folder"
                              ${listen('click', onCloseVscode)}
                          >
                              ×
                          </button>
                      `
                    : ''}
            </div>
            <div class="body">
                ${state.vscodeUrl
                    ? html`
                          <div class="code-pane" ?data-hidden=${!isCodeTab}>
                              <iframe
                                  class="vscode-iframe"
                                  src=${state.vscodeUrl}
                                  title="VS Code"
                              ></iframe>
                          </div>
                      `
                    : isCodeTab
                      ? html`
                            <div class="vscode-status">
                                ${state.vscodeError
                                    ? html`
                                          <span class="vscode-error">
                                              VS Code failed to start: ${state.vscodeError}
                                          </span>
                                      `
                                    : 'Starting VS Code…'}
                            </div>
                        `
                      : ''}
                <div class="cli-panes" ?data-hidden=${isCodeTab} ?data-mobile=${isMobile}>
                    ${inputs.aiHidden
                        ? ''
                        : html`
                              <div
                                  class="pane ai-pane"
                                  ?data-hidden=${!showAiPane}
                                  data-pane-focused=${aiFocused ? 'true' : 'false'}
                                  ${listen('focusin', () =>
                                      updateState({
                                          focusedKind: PaneKind.Ai,
                                      }),
                                  )}
                              >
                                  <div class="pane-body">
                                      ${repeat(
                                          [inputs.aiRestartKey],
                                          (restartKeyValue) => String(restartKeyValue),
                                          () => html`
                                              <${VirTerminal.assign({
                                                  folder: inputs.folder,
                                                  kind: PaneKind.Ai,
                                                  active: inputs.active,
                                                  showAccessoryKeys: isMobile,
                                              })}
                                                  ${listen(
                                                      VirTerminal.events.attentionRequested,
                                                      (event) =>
                                                          dispatch(
                                                              new events.attentionRequested(
                                                                  event.detail,
                                                              ),
                                                          ),
                                                  )}
                                              ></${VirTerminal}>
                                          `,
                                      )}
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
                            updateState({
                                focusedKind: PaneKind.Shell,
                            }),
                        )}
                    >
                        <div class="pane-body">
                            <${VirTerminal.assign({
                                folder: inputs.folder,
                                kind: PaneKind.Shell,
                                active: inputs.active,
                                showAccessoryKeys: isMobile,
                            })}
                                ${listen(VirTerminal.events.attentionRequested, (event) =>
                                    dispatch(new events.attentionRequested(event.detail)),
                                )}
                            ></${VirTerminal}>
                        </div>
                    </div>
                </div>
            </div>
        `;
    },
});
