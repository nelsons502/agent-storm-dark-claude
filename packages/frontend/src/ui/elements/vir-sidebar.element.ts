import {type Config, type FolderInfo, PaneKind} from '@agent-storm/common';
import {css, defineElement, html, listen} from 'element-vir';
import {parseUrl} from 'url-vir';
import {
    HorizontalAnchor,
    lucideIcons,
    renderMenuItemEntries,
    ViraButton,
    ViraColorVariant,
    ViraMenuTrigger,
    type ViraMenuItemEntry,
    ViraModal,
    ViraSize,
} from 'vira';
import {
    deleteWorktree,
    getConfig,
    getFolders,
    killFolderPanes,
    putConfig,
    restartPane,
} from '../../util/api-client.js';
import {
    addRepoFlow,
    type ConvertRepoConfirmRequest,
    type PickBaseBranchRequest,
} from '../../util/add-repo.js';
import {reportClientError} from '../../util/error-reporter.js';
import {localStorageClient} from '../../util/local-storage-client.js';
import {router} from '../../util/router.js';
import {viraButtonOverrides} from '../button-overrides.styles.js';
import {VirConvertRepoModal} from './vir-convert-repo-modal.element.js';
import {VirPickBaseBranchModal} from './vir-pick-base-branch-modal.element.js';
import {isAnyMergeStepLoading} from './vir-progress-tracker.element.js';

/**
 * Only `https://github.com/...` URLs are allowed through `window.open`. `prUrl` ultimately comes
 * from `gh pr view --json url` which we trust, but `window.open` will happily navigate to
 * `javascript:...` (executes in opener context) and `file://...` URLs, and a hypothetical
 * compromised `gh` output could redirect to an attacker domain. Parsing with `url-vir`'s `parseUrl`
 * (instead of regex) gives us a structured scheme + hostname split that can't be tricked by
 * `https://github.com.evil.com` (different hostname) or `https://github.com@evil.com` (different
 * host) — both of which a simple `startsWith` check would let through.
 */
function openPrUrl(prUrl: string | null | undefined): void {
    if (!prUrl) {
        return;
    }
    const parsed = parseUrl(prUrl);
    const isHttp = parsed.protocol === 'https' || parsed.protocol === 'http';
    if (!isHttp || parsed.hostname !== 'github.com') {
        return;
    }
    window.open(prUrl, '_blank', 'noopener');
}

/**
 * Sidebar status (Working / Needs attention grouping, pane dots) is the only signal a user has
 * that their typed input registered, so this needs to feel near-instant. 500ms is fast enough
 * that flipping a pane between Idle and Busy looks responsive, slow enough to keep `/folders`
 * load modest.
 */
const pollIntervalMs = 500;

function isWorking(folder: FolderInfo): boolean {
    // Working = at least one progress-tracker step is currently rendering as loading. The
    // merge-steps config is the single source of truth for what "passively waiting" means,
    // so the sidebar grouping never drifts from what the user sees on the step nodes
    // (AI-generating spinning, CI in flight, get-approval spinning while waiting on a
    // reviewer, etc.). Failures and done states inherently fall through to Needs-attention
    // via the done > failed > loading precedence inside `evaluateMergeStep`.
    return isAnyMergeStepLoading(folder);
}

function buildMetaLabel(folder: FolderInfo): string {
    if (folder.git.unpushed && folder.git.dirty) {
        return '↑·*';
    } else if (folder.git.unpushed) {
        return '↑';
    } else if (folder.git.dirty) {
        return '*';
    }
    return '';
}

type SidebarState = {
    folders: ReadonlyArray<FolderInfo>;
    /**
     * Latest config snapshot from the backend. The sidebar's "Show hidden worktrees" toggle
     * lives in config (not localStorage) so it syncs across the desktop + browser builds; the
     * refresh loop pulls a fresh copy each poll so a toggle from another client surfaces here
     * within the standard poll interval.
     */
    config: Config | undefined;
    pollHandle: ReturnType<typeof setInterval> | undefined;
    loadError: string | undefined;
    actionError: {title: string; message: string} | undefined;
    openMenuFolderPath: string | undefined;
    repoFilter: string | undefined;
    convertRequest: ConvertRepoConfirmRequest | undefined;
    convertResolve: ((confirmed: boolean) => void) | undefined;
    pickBranchRequest: PickBaseBranchRequest | undefined;
    pickBranchResolve: ((branch: string | undefined) => void) | undefined;
    /**
     * Whether the "Working" group is currently collapsed. Hydrated from
     * `localStorageClient.workingGroupCollapsed` so the choice survives reloads and persists
     * across browser sessions per workspace.
     */
    workingCollapsed: boolean;
};

type SidebarUpdate = (newState: Partial<SidebarState>) => void;

export const VirSidebar = defineElement<{
    activeFolder: string | undefined;
    onActivate: (folder: string) => void;
    onOpenSettings: () => void;
}>()({
    tagName: 'vir-sidebar',
    state(): SidebarState {
        return {
            folders: [],
            config: undefined,
            pollHandle: undefined,
            loadError: undefined,
            actionError: undefined,
            openMenuFolderPath: undefined,
            repoFilter: undefined,
            convertRequest: undefined,
            convertResolve: undefined,
            pickBranchRequest: undefined,
            pickBranchResolve: undefined,
            workingCollapsed: localStorageClient.workingGroupCollapsed.read(),
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
            font-family: var(--font-body);
            font-size: 12.5px;
            line-height: 1.5;
            background: var(--sidebar-bg);
            color: var(--sidebar-fg);
            border-right: 1px solid var(--sidebar-border);
            overflow: hidden;
            -webkit-font-smoothing: antialiased;
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 22px 22px 18px;
            border-bottom: 1px solid var(--sidebar-border);
        }

        .topbar {
            padding: 14px 16px 4px;
        }

        vira-button.new-worktree {
            width: 100%;
            text-transform: uppercase;
            letter-spacing: 0.12em;
            font-size: 11px;
            --vira-button-background-color: color-mix(in srgb, var(--copper) 6%, transparent);
            --vira-button-text-color: var(--copper);
            --vira-button-border-color: var(--copper);
            --vira-button-hover-background-color: color-mix(
                in srgb,
                var(--copper) 14%,
                transparent
            );
            --vira-button-hover-text-color: var(--copper);
            --vira-button-hover-border-color: var(--copper);
            --vira-button-active-background-color: color-mix(
                in srgb,
                var(--copper) 14%,
                transparent
            );
            --vira-button-active-text-color: var(--copper);
            --vira-button-active-border-color: var(--copper);
        }

        .brand-mark {
            width: 32px;
            height: 32px;
            flex-shrink: 0;
            display: block;
        }

        .brand-text {
            display: flex;
            flex-direction: column;
            min-width: 0;
        }

        .brand-name {
            font-family: var(--font-body);
            font-weight: 600;
            font-size: 17px;
            letter-spacing: -0.02em;
            color: var(--sidebar-fg);
            line-height: 1.1;
        }

        .brand-name em {
            font-style: normal;
            color: var(--copper);
            font-weight: 600;
            margin: 0 1px;
        }

        .brand-version {
            font-size: 9px;
            color: var(--sidebar-fg-subtle);
            letter-spacing: 0.18em;
            text-transform: uppercase;
            margin-top: 4px;
        }

        .section-label {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 18px 22px 10px;
            font-size: 9px;
            letter-spacing: 0.22em;
            text-transform: uppercase;
            color: var(--sidebar-fg-subtle);
        }

        .section-label .count {
            color: var(--sidebar-fg-faint);
            font-weight: 400;
            font-feature-settings: 'tnum';
        }

        .section-actions {
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }

        vira-button.filter-button {
            --vira-button-padding: 2px;
        }

        vira-button.filter-button[data-active] {
            --vira-button-text-color: var(--copper);
            --vira-button-hover-text-color: var(--copper);
            --vira-button-active-text-color: var(--copper);
        }

        .filter-status {
            padding: 0 22px 8px;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 10.5px;
            color: var(--sidebar-fg-subtle);
        }

        .filter-status .filter-clear {
            color: var(--copper);
            cursor: pointer;
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        .list {
            flex-grow: 1;
            overflow-y: auto;
            padding: 0 16px 12px;
            display: flex;
            flex-direction: column;
            gap: 1px;
        }

        .group-label {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 14px 6px 6px;
            font-size: 9px;
            letter-spacing: 0.2em;
            text-transform: uppercase;
            color: var(--sidebar-fg-subtle);
        }

        .group-label:first-child {
            padding-top: 6px;
        }

        .group-label .group-count {
            color: var(--sidebar-fg-faint);
            font-weight: 400;
            font-feature-settings: 'tnum';
        }

        .group-label[data-variant='attention'] {
            color: var(--amber);
        }

        /*
         * The "Working" header (when both groups are present) gets a top border + a bit more
         * breathing room to visually separate from "Needs attention" above it. The
         * :first-child guard suppresses the border when Working is the only group — no
         * stray line needed at the very top.
         */
        .group-label[data-variant='working']:not(:first-child) {
            border-top: 1px solid var(--sidebar-border);
            margin-top: 6px;
            padding-top: 14px;
        }

        .group-label.collapsible {
            cursor: pointer;
            user-select: none;
        }

        .group-label.collapsible:hover {
            color: var(--sidebar-fg);
        }

        .group-label .group-left {
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }

        .group-chevron {
            display: inline-flex;
            font-size: 10px;
            line-height: 1;
            transition: transform 120ms ease;
        }

        .group-label[data-collapsed] .group-chevron {
            transform: rotate(-90deg);
        }

        /*
         * Rows in the "Working" group are passive — the user isn't expected to act on them
         * until something completes — so dim the name and the meta text. The active row stays
         * full strength via the [data-active] rule below so it's still obvious which one is
         * selected.
         */
        .row[data-working]:not([data-active]) .name,
        .row[data-working]:not([data-active]) .meta {
            color: var(--sidebar-fg-subtle);
        }

        .list::-webkit-scrollbar {
            width: 8px;
        }
        .list::-webkit-scrollbar-track {
            background: transparent;
        }
        .list::-webkit-scrollbar-thumb {
            background: var(--sidebar-border-2);
            border-radius: var(--radius-full);
        }
        .list::-webkit-scrollbar-thumb:hover {
            background: var(--sidebar-fg-faint);
        }

        .row {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 9px 10px;
            margin: 1px 0;
            border-radius: 4px;
            cursor: pointer;
            user-select: none;
            color: var(--sidebar-fg-muted);
            font-size: 12.5px;
            position: relative;
            transition:
                background-color 120ms ease,
                color 120ms ease;
        }

        .row:hover {
            background: var(--sidebar-accent-bg-hover);
            color: var(--sidebar-accent-fg);
        }

        .row[data-active] {
            background: var(--sidebar-accent-bg);
            color: var(--sidebar-accent-fg);
        }

        .row[data-active]::before {
            content: '';
            position: absolute;
            left: -16px;
            top: 50%;
            transform: translateY(-50%);
            width: 2px;
            height: 18px;
            background: var(--sidebar-accent-rail);
            border-radius: 0 2px 2px 0;
        }

        .name {
            flex-grow: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-weight: 500;
        }

        .name[data-pr-open] {
            text-decoration: underline;
            text-decoration-color: var(--blue-400);
            text-underline-offset: 2px;
        }

        .name[data-pr-merged] {
            text-decoration: underline;
            text-decoration-color: var(--purple-500);
            text-underline-offset: 2px;
        }

        .meta {
            font-size: 10px;
            color: var(--sidebar-fg-subtle);
            font-feature-settings: 'tnum';
            flex-shrink: 0;
            max-width: 60px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .row[data-active] .meta {
            color: var(--copper);
        }

        .actions {
            display: inline-flex;
            gap: 2px;
            margin-left: 2px;
        }

        vira-button.add-repo {
            margin: 8px 16px 0;
        }

        .foot {
            margin-top: auto;
            padding: 14px 22px;
            border-top: 1px solid var(--sidebar-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            font-size: 10.5px;
            color: var(--sidebar-fg-subtle);
        }

        .foot-meta {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .foot-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--moss);
            box-shadow: 0 0 6px rgba(122, 145, 89, 0.7);
            flex-shrink: 0;
        }

        vira-button.ghost-icon {
            --vira-button-background-color: transparent;
            --vira-button-text-color: var(--sidebar-fg-subtle);
            --vira-button-border-color: transparent;
            --vira-button-hover-background-color: var(--sidebar-accent-bg-hover);
            --vira-button-hover-text-color: var(--sidebar-fg);
            --vira-button-hover-border-color: transparent;
            --vira-button-active-background-color: var(--sidebar-accent-bg-hover);
            --vira-button-active-text-color: var(--sidebar-fg);
            --vira-button-active-border-color: transparent;
        }

        .error {
            margin: 8px 16px 0;
            padding: 10px 12px;
            border-radius: var(--radius-md);
            background: var(--bg-error);
            color: var(--fg-error);
            border: 1px solid var(--border-error);
            font-size: var(--font-size-xs);
            line-height: var(--line-height-xs);
            white-space: pre-wrap;
        }

        .error-modal-body {
            display: flex;
            flex-direction: column;
            gap: 16px;
            min-width: 420px;
            max-width: 720px;
            color: var(--fg);
            font-family: var(--font-body);
        }

        .error-modal-message {
            font-family: var(--font-mono);
            font-size: var(--font-size-sm);
            line-height: var(--line-height-sm);
            color: var(--fg);
            background: var(--bg-error);
            border: 1px solid var(--border-error);
            border-radius: var(--radius-md);
            padding: 12px 14px;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 60vh;
            overflow: auto;
        }

        .error-modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
        }

        .empty {
            padding: 16px 12px;
            color: var(--sidebar-fg-subtle);
            text-align: center;
            font-size: 11px;
        }

        ${viraButtonOverrides}
    `,
    init({updateState}) {
        void refresh(updateState);
        const pollHandle = setInterval(() => {
            void refresh(updateState);
        }, pollIntervalMs);
        updateState({
pollHandle
});
    },
    cleanup({state}) {
        if (state.pollHandle) {
            clearInterval(state.pollHandle);
        }
    },
    render({inputs, state, updateState}) {
        const worktreeRoots = state.folders.filter((folder) => folder.isWorktreeRoot);
        /**
         * Base-branch worktrees are the canonical home for shared local-only files
         * (`.not-committed/`, secrets) seeded into new worktrees, so they're hidden from the
         * sidebar and can't be removed. The backend enforces the same rule in `/worktrees/delete`;
         * filtering here just prevents the user from being offered an action that will be refused.
         */
        const showHidden = !!state.config?.showHiddenWorktrees;
        const allWorktrees = worktreeRoots.flatMap((root) =>
            state.folders.filter(
                (folder) =>
                    folder.parentRepoPath === root.path &&
                    !folder.isBaseBranch &&
                    (showHidden || !folder.isHidden),
            ),
        );
        const hiddenCount = worktreeRoots.reduce(
            (count, root) =>
                count +
                state.folders.filter(
                    (folder) =>
                        folder.parentRepoPath === root.path &&
                        !folder.isBaseBranch &&
                        folder.isHidden,
                ).length,
            0,
        );
        const repoOptions: ReadonlyArray<{path: string; name: string}> = worktreeRoots.map(
            (folder) => ({
                path: folder.path,
                name: folder.name,
            }),
        );
        const knownRepoPaths = new Set(repoOptions.map((repo) => repo.path));
        const activeRepoFilter =
            state.repoFilter && knownRepoPaths.has(state.repoFilter)
                ? state.repoFilter
                : undefined;
        const visibleWorktrees = activeRepoFilter
            ? allWorktrees.filter((folder) => folder.parentRepoPath === activeRepoFilter)
            : allWorktrees;
        const workingWorktrees = visibleWorktrees.filter(isWorking);
        const needsAttentionWorktrees = visibleWorktrees.filter((folder) => !isWorking(folder));
        const worktreeCount = visibleWorktrees.length.toString().padStart(2, '0');
        const activeRepoName = activeRepoFilter
            ? repoOptions.find((repo) => repo.path === activeRepoFilter)?.name
            : undefined;
        const newWorktreeEntries = worktreeRoots.length
            ? worktreeRoots.map((folder) => ({
                  content: folder.name,
                  onClick: () => {
                      router.setRoute({
                          paths: ['add-worktree', encodeURIComponent(folder.path)],
                      });
                  },
              }))
            : [
                  {
                      content: 'No repositories yet',
                      disabled: true,
                      onClick: () => {},
                  },
              ];

        const filterEntries: ViraMenuItemEntry[] = [
            {
                content: 'All repositories',
                selected: !activeRepoFilter,
                onClick: () => updateState({
repoFilter: undefined
}),
            },
            ...(repoOptions.length
                ? repoOptions.map((repo) => ({
                      content: repo.name,
                      selected: activeRepoFilter === repo.path,
                      onClick: () => updateState({
repoFilter: repo.path
}),
                  }))
                : [
                      {
                          content: 'No repositories yet',
                          disabled: true,
                          onClick: () => {},
                      },
                  ]),
            {
                content: showHidden
                    ? `Hide hidden worktrees${hiddenCount ? ` (${hiddenCount})` : ''}`
                    : `Show hidden worktrees${hiddenCount ? ` (${hiddenCount})` : ''}`,
                onClick: () => {
                    void toggleShowHidden(updateState);
                },
            },
        ];

        return html`
            <div class="brand">
                <img
                    class="brand-mark"
                    src="/agent-storm-mark.svg"
                    width="32"
                    height="32"
                    alt=""
                    aria-hidden="true"
                />
                <div class="brand-text">
                    <div class="brand-name">agent<em>·</em>storm</div>
                    <div class="brand-version">workspace</div>
                </div>
            </div>

            <div class="topbar">
                <${ViraMenuTrigger.assign({
                    horizontalAnchor: HorizontalAnchor.Left,
                })}>
                    <${ViraButton.assign({
                        text: 'New worktree',
                        icon: lucideIcons.GitBranchPlus,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Custom,
                    })}
                        slot=${ViraMenuTrigger.slotNames.trigger}
                        class="new-worktree"
                        title="Create a new worktree in one of your repositories"
                    ></${ViraButton}>
                    ${renderMenuItemEntries(newWorktreeEntries)}
                </${ViraMenuTrigger}>
            </div>

            <div class="section-label">
                <span>Worktrees</span>
                <span class="section-actions">
                    <span class="count">${worktreeCount}</span>
                    <${ViraMenuTrigger.assign({
                        horizontalAnchor: HorizontalAnchor.Right,
                    })}>
                        <${ViraButton.assign({
                            icon: lucideIcons.EllipsisVertical,
                            buttonSize: ViraSize.Small,
                            color: ViraColorVariant.Custom,
                        })}
                            slot=${ViraMenuTrigger.slotNames.trigger}
                            class="ghost-icon filter-button"
                            ?data-active=${!!activeRepoFilter}
                            aria-label="Filter worktrees"
                            title="Filter by repository"
                        ></${ViraButton}>
                        ${renderMenuItemEntries(filterEntries)}
                    </${ViraMenuTrigger}>
                </span>
            </div>

            ${activeRepoName
                ? html`
                      <div class="filter-status">
                          <span>Filtered: ${activeRepoName}</span>
                          <span
                              class="filter-clear"
                              role="button"
                              tabindex="0"
                              ${listen('click', () => updateState({
repoFilter: undefined
}))}
                          >
                              clear
                          </span>
                      </div>
                  `
                : ''}

            ${state.loadError
                ? html`
                      <div class="error">${state.loadError}</div>
                  `
                : ''}

            <div class="list">
                ${state.folders.length === 0 && !state.loadError
                    ? html`
                          <div class="empty">No repos yet. Add one below.</div>
                      `
                    : ''}
                ${state.folders.length > 0 &&
                visibleWorktrees.length === 0 &&
                !state.loadError
                    ? html`
                          <div class="empty">No worktrees match this filter.</div>
                      `
                    : ''}
                ${needsAttentionWorktrees.length
                    ? html`
                          <div class="group-label" data-variant="attention">
                              <span>Needs attention</span>
                              <span class="group-count">
                                  ${needsAttentionWorktrees.length.toString().padStart(2, '0')}
                              </span>
                          </div>
                          ${needsAttentionWorktrees.map((folder) =>
                              renderRow({
                                  folder,
                                  folders: state.folders,
                                  activeFolder: inputs.activeFolder,
                                  openMenuFolderPath: state.openMenuFolderPath,
                                  onActivate: inputs.onActivate,
                                  updateState,
                              }),
                          )}
                      `
                    : ''}
                ${workingWorktrees.length
                    ? html`
                          <div
                              class="group-label collapsible"
                              data-variant="working"
                              ?data-collapsed=${state.workingCollapsed}
                              role="button"
                              tabindex="0"
                              aria-expanded=${state.workingCollapsed ? 'false' : 'true'}
                              ${listen('click', () => {
                                  const next = !state.workingCollapsed;
                                  updateState({workingCollapsed: next});
                                  localStorageClient.workingGroupCollapsed.write(next);
                              })}
                              ${listen('keydown', (event: KeyboardEvent) => {
                                  if (event.key !== 'Enter' && event.key !== ' ') {
                                      return;
                                  }
                                  event.preventDefault();
                                  const next = !state.workingCollapsed;
                                  updateState({workingCollapsed: next});
                                  localStorageClient.workingGroupCollapsed.write(next);
                              })}
                          >
                              <span class="group-left">
                                  <span class="group-chevron" aria-hidden="true">▼</span>
                                  <span>Working</span>
                              </span>
                              <span class="group-count">
                                  ${workingWorktrees.length.toString().padStart(2, '0')}
                              </span>
                          </div>
                          ${state.workingCollapsed
                              ? ''
                              : workingWorktrees.map((folder) =>
                                    renderRow({
                                        folder,
                                        folders: state.folders,
                                        activeFolder: inputs.activeFolder,
                                        openMenuFolderPath: state.openMenuFolderPath,
                                        onActivate: inputs.onActivate,
                                        updateState,
                                        working: true,
                                    }),
                                )}
                      `
                    : ''}
            </div>

            <${ViraButton.assign({
                text: 'add repository',
                icon: lucideIcons.Plus,
                buttonSize: ViraSize.Medium,
                color: ViraColorVariant.Custom,
            })}
                class="tertiary add-repo"
                ${listen('click', () => void promptAddRepo(updateState))}
            ></${ViraButton}>

            <div class="foot">
                <span class="foot-meta">
                    <span class="foot-dot" aria-hidden="true"></span>
                    <span>agent-storm</span>
                </span>
                <${ViraButton.assign({
                    icon: lucideIcons.Settings,
                    buttonSize: ViraSize.Medium,
                    color: ViraColorVariant.Custom,
                })}
                    class="ghost-icon"
                    aria-label="Settings"
                    title="Settings"
                    ${listen('click', () => inputs.onOpenSettings())}
                ></${ViraButton}>
            </div>

            <${ViraModal.assign({
                open: !!state.actionError,
                modalTitle: state.actionError?.title ?? '',
            })}
                ${listen(ViraModal.events.modalClose, () =>
                    updateState({
actionError: undefined
}),
                )}
            >
                ${state.actionError
                    ? html`
                          <div class="error-modal-body">
                              <div class="error-modal-message">
                                  ${state.actionError.message}
                              </div>
                              <div class="error-modal-footer">
                                  <${ViraButton.assign({
                                      text: 'Close',
                                      color: ViraColorVariant.Neutral,
                                      buttonSize: ViraSize.Medium,
                                  })}
                                      ${listen('click', () =>
                                          updateState({
actionError: undefined
}),
                                      )}
                                  ></${ViraButton}>
                              </div>
                          </div>
                      `
                    : ''}
            </${ViraModal}>

            <${VirConvertRepoModal.assign({request: state.convertRequest})}
                ${listen(VirConvertRepoModal.events.confirmed, () => {
                    state.convertResolve?.(true);
                    updateState({convertRequest: undefined, convertResolve: undefined});
                })}
                ${listen(VirConvertRepoModal.events.cancelled, () => {
                    state.convertResolve?.(false);
                    updateState({convertRequest: undefined, convertResolve: undefined});
                })}
            ></${VirConvertRepoModal}>

            <${VirPickBaseBranchModal.assign({request: state.pickBranchRequest})}
                ${listen(VirPickBaseBranchModal.events.confirmed, (event) => {
                    state.pickBranchResolve?.(event.detail);
                    updateState({pickBranchRequest: undefined, pickBranchResolve: undefined});
                })}
                ${listen(VirPickBaseBranchModal.events.cancelled, () => {
                    state.pickBranchResolve?.(undefined);
                    updateState({pickBranchRequest: undefined, pickBranchResolve: undefined});
                })}
            ></${VirPickBaseBranchModal}>
        `;
    },
});

function renderRow({
    folder,
    folders,
    activeFolder,
    openMenuFolderPath,
    onActivate,
    updateState,
    working = false,
}: Readonly<{
    folder: FolderInfo;
    folders: ReadonlyArray<FolderInfo>;
    activeFolder: string | undefined;
    openMenuFolderPath: string | undefined;
    onActivate: (folder: string) => void;
    updateState: SidebarUpdate;
    /** True when the row is in the "Working" group — drops the name color a step. */
    working?: boolean;
}>) {
    const metaLabel = buildMetaLabel(folder);
    const isMenuOpen = openMenuFolderPath === folder.path;
    return html`
        <div
            class="row"
            ?data-active=${activeFolder === folder.path}
            ?data-menu-open=${isMenuOpen}
            ?data-working=${working}
            ${listen('click', () => onActivate(folder.path))}
        >
            <span
                class="name"
                ?data-pr-open=${!!folder.prUrl && !folder.prMerged}
                ?data-pr-merged=${!!folder.prUrl && folder.prMerged}
            >
                ${folder.name}
            </span>
            ${metaLabel ? html`<span class="meta">${metaLabel}</span>` : ''}
            <span class="actions" ${listen('click', (event) => event.stopPropagation())}>
                <${ViraMenuTrigger.assign({
                    horizontalAnchor: HorizontalAnchor.Right,
                })}
                    ${listen(ViraMenuTrigger.events.openChange, (event) => {
                        updateState({
                            openMenuFolderPath: event.detail ? folder.path : undefined,
                        });
                    })}
                >
                    <${ViraButton.assign({
                        icon: lucideIcons.EllipsisVertical,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Custom,
                    })}
                        slot=${ViraMenuTrigger.slotNames.trigger}
                        class="ghost-icon"
                        aria-label="Folder actions"
                        title="Actions"
                    ></${ViraButton}>
                    ${renderMenuItemEntries([
                        {
                            content: 'Open PR',
                            hidden: !folder.prUrl,
                            onClick: () => {
                                openPrUrl(folder.prUrl);
                            },
                        },
                        {
                            content: folder.aiHidden ? 'Show AI pane' : 'Hide AI pane',
                            onClick: () => {
                                void toggleAiHidden(folder.path, updateState);
                            },
                        },
                        {
                            content: 'Restart AI',
                            onClick: () => {
                                void restartPane({
folder: folder.path, kind: PaneKind.Ai
}).catch(
                                    (error: unknown) =>
                                        showError(updateState, 'Restart AI failed', error),
                                );
                            },
                        },
                        {
                            content: 'Kill folder panes',
                            onClick: () => {
                                void killFolderPanes({
folder: folder.path
}).catch(
                                    (error: unknown) =>
                                        showError(updateState, 'Kill panes failed', error),
                                );
                            },
                        },
                        {
                            content: folder.isHidden ? 'Mark visible' : 'Mark hidden',
                            hidden: folder.isBaseBranch,
                            onClick: () => {
                                void toggleWorktreeHidden(folder.path, updateState);
                            },
                        },
                        {
                            content: 'Delete worktree',
                            hidden: folder.isBaseBranch,
                            onClick: () => {
                                void confirmDeleteWorktree(
                                    folder.path,
                                    folders,
                                    updateState,
                                );
                            },
                        },
                        {
                            content: 'Remove parent repo',
                            hidden: !folder.parentRepoPath,
                            onClick: () => {
                                if (folder.parentRepoPath) {
                                    void confirmRemoveRepo(
                                        folder.parentRepoPath,
                                        folders,
                                        updateState,
                                    );
                                }
                            },
                        },
                    ])}
                </${ViraMenuTrigger}>
            </span>
        </div>
    `;
}

async function refresh(updateState: SidebarUpdate): Promise<void> {
    try {
        // Fetch folders + config together so the "Show hidden" toggle (which lives in config)
        // and the per-row `isHidden` flag (which flows through FolderInfo) stay in lockstep —
        // otherwise toggling Show-hidden from another client would lag the visible row set by
        // up to one full poll cycle.
        const [
            folders,
            config,
        ] = await Promise.all([
            getFolders(),
            getConfig(),
        ]);
        updateState({
folders, config, loadError: undefined
});
    } catch (error: unknown) {
        console.error('sidebar refresh failed', error);
        reportClientError(error, 'sidebar-refresh');
        updateState({
loadError: error instanceof Error ? error.message : String(error)
});
    }
}

function showError(updateState: SidebarUpdate, title: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    updateState({
        actionError: {
            title,
            message,
        },
    });
}

async function promptAddRepo(updateState: SidebarUpdate): Promise<void> {
    try {
        await addRepoFlow(
            (request) =>
                new Promise<boolean>((resolve) => {
                    updateState({convertRequest: request, convertResolve: resolve});
                }),
            (request) =>
                new Promise<string | undefined>((resolve) => {
                    updateState({pickBranchRequest: request, pickBranchResolve: resolve});
                }),
        );
        await refresh(updateState);
    } catch (error: unknown) {
        showError(updateState, 'Add repo failed', error);
    }
}

async function confirmRemoveRepo(
    repoPath: string,
    currentFolders: ReadonlyArray<FolderInfo>,
    updateState: SidebarUpdate,
): Promise<void> {
    if (!window.confirm(`Remove repo ${repoPath}?`)) {
        return;
    }
    // Optimistically drop the repo root and every worktree underneath it. The server still
    // reconciles + persists below, but pulling the rows out immediately means the user sees
    // them disappear on click instead of waiting for the PUT + reconcile round trip (which
    // does ~4 git subprocesses per remaining worktree before the response returns).
    updateState({
        folders: currentFolders.filter(
            (folder) => folder.path !== repoPath && folder.parentRepoPath !== repoPath,
        ),
    });
    try {
        const config = await getConfig();
        // Collect the worktree paths that lived under this repo so we can prune them out of
        // `hiddenWorktrees` in the same write — otherwise stale entries pile up after each
        // repo remove + re-add.
        const repoConfig = config.repos.find((repo) => repo.path === repoPath);
        const worktreePaths = new Set(
            repoConfig?.worktrees.map((worktree) => worktree.path) ?? [],
        );
        await putConfig({
            ...config,
            repos: config.repos.filter((repo) => repo.path !== repoPath),
            hiddenAiPane: config.hiddenAiPane.filter((path) => path !== repoPath),
            hiddenWorktrees: config.hiddenWorktrees.filter((path) => !worktreePaths.has(path)),
        });
        await refresh(updateState);
    } catch (error: unknown) {
        showError(updateState, 'Remove repo failed', error);
        // Reconciling failed — pull the real list back so the optimistic removal can't leave
        // the sidebar pointing at a stale view.
        await refresh(updateState);
    }
}

async function confirmDeleteWorktree(
    worktreePath: string,
    currentFolders: ReadonlyArray<FolderInfo>,
    updateState: SidebarUpdate,
): Promise<void> {
    if (!window.confirm(`Delete worktree ${worktreePath}?`)) {
        return;
    }
    // Pull the row out of the sidebar before the API call so the UI reflects the user's
    // intent immediately. The await below blocks on `git worktree remove` + a full
    // reconcile sweep, which can take a noticeable beat on repos with many worktrees.
    updateState({
        folders: currentFolders.filter((folder) => folder.path !== worktreePath),
    });
    try {
        await deleteWorktree({
worktreePath
});
        await refresh(updateState);
    } catch (error: unknown) {
        showError(updateState, 'Delete worktree failed', error);
        // Reconciling failed — restore the real list so the optimistic removal doesn't
        // hide a worktree that's actually still on disk.
        await refresh(updateState);
    }
}

async function toggleWorktreeHidden(
    worktreePath: string,
    updateState: SidebarUpdate,
): Promise<void> {
    try {
        const config = await getConfig();
        const isHidden = config.hiddenWorktrees.includes(worktreePath);
        await putConfig({
            ...config,
            hiddenWorktrees: isHidden
                ? config.hiddenWorktrees.filter((path) => path !== worktreePath)
                : [
                      ...config.hiddenWorktrees,
                      worktreePath,
                  ],
        });
        await refresh(updateState);
    } catch (error: unknown) {
        showError(updateState, 'Toggle worktree hidden failed', error);
    }
}

async function toggleShowHidden(updateState: SidebarUpdate): Promise<void> {
    try {
        // Refetch rather than mutating the in-state snapshot — config can change from other
        // clients between polls, and we don't want to overwrite a concurrent edit with stale
        // values just because the toggle was clicked first.
        const config = await getConfig();
        await putConfig({
            ...config,
            showHiddenWorktrees: !config.showHiddenWorktrees,
        });
        await refresh(updateState);
    } catch (error: unknown) {
        showError(updateState, 'Toggle show-hidden failed', error);
    }
}

async function toggleAiHidden(folderPath: string, updateState: SidebarUpdate): Promise<void> {
    try {
        const config = await getConfig();
        const isHidden = config.hiddenAiPane.includes(folderPath);
        await putConfig({
            ...config,
            hiddenAiPane: isHidden
                ? config.hiddenAiPane.filter((path) => path !== folderPath)
                : [
                      ...config.hiddenAiPane,
                      folderPath,
                  ],
        });
        await refresh(updateState);
    } catch (error: unknown) {
        showError(updateState, 'Toggle AI pane failed', error);
    }
}
