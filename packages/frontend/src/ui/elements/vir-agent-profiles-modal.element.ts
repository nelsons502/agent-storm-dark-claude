import {type AgentProfile, type Config} from '@agent-storm/common';
import {createCuid2} from '@augment-vir/common';
import {css, defineElement, defineElementEvent, html, listen, repeat} from 'element-vir';
import {
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraInput,
    ViraModal,
    ViraSelect,
    ViraTextArea,
} from 'vira';
import {type AgentProfileDraft, validateAgentProfileDraft} from '../../util/agent-profiles.js';
import {getConfig, putConfig} from '../../util/api-client.js';

const emptyDraft: AgentProfileDraft = {
    name: '',
    launchCommand: '',
    newSessionCommand: '',
};

export const VirAgentProfilesModal = defineElement<{
    open: boolean;
    profiles: ReadonlyArray<AgentProfile>;
    defaultAgentProfileId: string;
}>()({
    tagName: 'vir-agent-profiles-modal',
    events: {
        closeRequested: defineElementEvent<void>(),
        configSaved: defineElementEvent<Config>(),
    },
    state() {
        return {
            loadedProfiles: [] as ReadonlyArray<AgentProfile>,
            loadedDefaultAgentProfileId: '',
            editing: false,
            editingProfileId: undefined as string | undefined,
            draft: emptyDraft,
            saveError: undefined as string | undefined,
            saving: false,
        };
    },
    styles: css`
        :host {
            font-family: var(--app-font-sans, ui-sans-serif, system-ui, sans-serif);
        }

        .body {
            display: flex;
            flex-direction: column;
            gap: 16px;
            width: min(720px, calc(100dvw - 80px));
            max-width: 100%;
            box-sizing: border-box;
        }

        .intro,
        .notice {
            color: var(--app-muted);
            font-size: 13px;
            line-height: 1.45;
        }

        .notice {
            padding: 10px 12px;
            border: 1px solid var(--app-border);
            border-radius: var(--app-radius-sm);
            background: var(--app-surface);
        }

        .toolbar,
        .footer,
        .row-actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .toolbar {
            justify-content: space-between;
        }

        .default-select {
            flex: 1 1 auto;
            min-width: 0;
        }

        .profiles {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .profile-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 12px;
            align-items: center;
            padding: 12px;
            border: 1px solid var(--app-border);
            border-radius: var(--app-radius-md);
            background: var(--app-surface);
        }

        .profile-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--app-text);
            font-size: 14px;
            font-weight: 650;
        }

        .profile-command {
            margin-top: 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: var(--app-muted);
            font-family: var(--app-font-mono, ui-monospace, monospace);
            font-size: 12px;
        }

        .editor {
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 14px;
            border: 1px solid var(--app-border-strong);
            border-radius: var(--app-radius-md);
            background: var(--app-surface-raised);
        }

        .editor-title {
            font-size: 14px;
            font-weight: 650;
        }

        .error {
            color: var(--app-danger, #b42318);
            font-size: 13px;
            white-space: pre-wrap;
        }

        .footer {
            justify-content: flex-end;
            padding-top: 12px;
            border-top: 1px solid var(--app-border);
        }

        @media (max-width: 640px) {
            .body {
                width: calc(100dvw - 32px);
            }

            .toolbar,
            .profile-row {
                display: flex;
                flex-direction: column;
                align-items: stretch;
            }

            .row-actions {
                justify-content: flex-end;
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const reset = () => {
            updateState({
                loadedProfiles: [],
                loadedDefaultAgentProfileId: '',
                editing: false,
                editingProfileId: undefined,
                draft: emptyDraft,
                saveError: undefined,
                saving: false,
            });
        };
        const close = () => {
            reset();
            dispatch(new events.closeRequested());
        };
        const saveProfileFields = async (
            transform: (config: Config) => Pick<Config, 'agentProfiles' | 'defaultAgentProfileId'>,
        ) => {
            if (state.saving) {
                return;
            }
            updateState({
                saving: true,
                saveError: undefined,
            });
            try {
                const current = await getConfig();
                const fields = transform(current);
                const saved = await putConfig({
                    ...current,
                    ...fields,
                });
                updateState({
                    loadedProfiles: saved.agentProfiles,
                    loadedDefaultAgentProfileId: saved.defaultAgentProfileId,
                    editing: false,
                    editingProfileId: undefined,
                    draft: emptyDraft,
                    saving: false,
                });
                dispatch(new events.configSaved(saved));
            } catch (error: unknown) {
                updateState({
                    saving: false,
                    saveError: error instanceof Error ? error.message : String(error),
                });
            }
        };
        const editValidation = validateAgentProfileDraft({
            draft: state.draft,
            profiles: state.loadedProfiles,
            editingProfileId: state.editingProfileId,
        });
        const saveDraft = () => {
            if (editValidation) {
                updateState({
                    saveError: editValidation,
                });
                return;
            }
            void saveProfileFields((config) => {
                const profile: AgentProfile = {
                    id: state.editingProfileId || createCuid2(),
                    name: state.draft.name.trim(),
                    launchCommand: state.draft.launchCommand.trim(),
                    newSessionCommand: state.draft.newSessionCommand.trim(),
                };
                return {
                    agentProfiles: state.editingProfileId
                        ? config.agentProfiles.map((entry) =>
                              entry.id === state.editingProfileId ? profile : entry,
                          )
                        : [
                              ...config.agentProfiles,
                              profile,
                          ],
                    defaultAgentProfileId: config.defaultAgentProfileId,
                };
            });
        };
        const visibleProfiles = state.loadedProfiles.length
            ? state.loadedProfiles
            : inputs.profiles;
        const visibleDefaultId = state.loadedDefaultAgentProfileId || inputs.defaultAgentProfileId;

        return html`
            <${ViraModal.assign({
                open: inputs.open,
                modalTitle: 'Agent profiles',
            })}
                ${listen(ViraModal.events.modalClose, close)}
            >
                ${inputs.open
                    ? html`
                          <div class="body">
                              <div class="intro">
                                  Profiles name complete shell commands for any terminal-based agent
                                  harness or model configuration.
                              </div>
                              <div class="toolbar">
                                  <${ViraSelect.assign({
                                      label: 'Global default profile',
                                      options: visibleProfiles.map((profile) => {
                                          return {
                                              value: profile.id,
                                              label: profile.name,
                                          };
                                      }),
                                      value: visibleDefaultId,
                                      disabled: state.saving,
                                  })}
                                      class="default-select"
                                      ${listen(ViraSelect.events.valueChange, (event) => {
                                          if (event.detail === visibleDefaultId) {
                                              return;
                                          }
                                          void saveProfileFields((config) => {
                                              return {
                                                  agentProfiles: config.agentProfiles,
                                                  defaultAgentProfileId: event.detail,
                                              };
                                          });
                                      })}
                                  ></${ViraSelect}>
                                  <${ViraButton.assign({
                                      text: 'Add profile',
                                      color: ViraColorVariant.Positive,
                                      isDisabled: state.saving,
                                  })}
                                      ${listen('click', () =>
                                          updateState({
                                              editing: true,
                                              editingProfileId: undefined,
                                              draft: emptyDraft,
                                              saveError: undefined,
                                          }),
                                      )}
                                  ></${ViraButton}>
                              </div>
                              <div class="profiles">
                                  ${repeat(
                                      visibleProfiles,
                                      (profile) => profile.id,
                                      (profile) => html`
                                          <div class="profile-row">
                                              <div>
                                                  <div class="profile-name">${profile.name}</div>
                                                  <div
                                                      class="profile-command"
                                                      title=${profile.launchCommand}
                                                  >
                                                      ${profile.launchCommand}
                                                  </div>
                                              </div>
                                              <div class="row-actions">
                                                  <${ViraButton.assign({
                                                      text: 'Edit',
                                                      buttonEmphasis: ViraEmphasis.Subtle,
                                                      color: ViraColorVariant.Neutral,
                                                      isDisabled: state.saving,
                                                  })}
                                                      ${listen('click', () =>
                                                          updateState({
                                                              editing: true,
                                                              editingProfileId: profile.id,
                                                              draft: {
                                                                  name: profile.name,
                                                                  launchCommand:
                                                                      profile.launchCommand,
                                                                  newSessionCommand:
                                                                      profile.newSessionCommand,
                                                              },
                                                              saveError: undefined,
                                                          }),
                                                      )}
                                                  ></${ViraButton}>
                                                  <${ViraButton.assign({
                                                      text: 'Delete',
                                                      buttonEmphasis: ViraEmphasis.Subtle,
                                                      color: ViraColorVariant.Danger,
                                                      isDisabled:
                                                          state.saving ||
                                                          visibleProfiles.length <= 1,
                                                  })}
                                                      title=${visibleProfiles.length <= 1
                                                          ? 'The final profile cannot be deleted.'
                                                          : 'Delete profile'}
                                                      ${listen('click', () => {
                                                          if (
                                                              visibleProfiles.length <= 1 ||
                                                              !window.confirm(
                                                                  `Delete agent profile "${profile.name}"?`,
                                                              )
                                                          ) {
                                                              return;
                                                          }
                                                          void saveProfileFields((config) => {
                                                              const agentProfiles =
                                                                  config.agentProfiles.filter(
                                                                      (entry) =>
                                                                          entry.id !== profile.id,
                                                                  );
                                                              return {
                                                                  agentProfiles,
                                                                  defaultAgentProfileId:
                                                                      config.defaultAgentProfileId ===
                                                                      profile.id
                                                                          ? agentProfiles[0]?.id ||
                                                                            ''
                                                                          : config.defaultAgentProfileId,
                                                              };
                                                          });
                                                      })}
                                                  ></${ViraButton}>
                                              </div>
                                          </div>
                                      `,
                                  )}
                              </div>
                              ${state.editing
                                  ? html`
                                        <div class="editor">
                                            <div class="editor-title">
                                                ${state.editingProfileId
                                                    ? 'Edit profile'
                                                    : 'Add profile'}
                                            </div>
                                            <${ViraInput.assign({
                                                label: 'Profile name',
                                                value: state.draft.name,
                                                placeholder: 'Harness - model - mode',
                                                disabled: state.saving,
                                            })}
                                                ${listen(ViraInput.events.valueChange, (event) =>
                                                    updateState({
                                                        draft: {
                                                            ...state.draft,
                                                            name: event.detail,
                                                        },
                                                    }),
                                                )}
                                            ></${ViraInput}>
                                            <${ViraTextArea.assign({
                                                label: 'Launch command',
                                                value: state.draft.launchCommand,
                                                rows: 3,
                                                preventResize: true,
                                                disableBrowserHelps: true,
                                                disabled: state.saving,
                                            })}
                                                ${listen(ViraTextArea.events.valueChange, (event) =>
                                                    updateState({
                                                        draft: {
                                                            ...state.draft,
                                                            launchCommand: event.detail,
                                                        },
                                                    }),
                                                )}
                                            ></${ViraTextArea}>
                                            <${ViraTextArea.assign({
                                                label: 'New-session command (optional)',
                                                value: state.draft.newSessionCommand,
                                                rows: 3,
                                                preventResize: true,
                                                disableBrowserHelps: true,
                                                disabled: state.saving,
                                            })}
                                                ${listen(ViraTextArea.events.valueChange, (event) =>
                                                    updateState({
                                                        draft: {
                                                            ...state.draft,
                                                            newSessionCommand: event.detail,
                                                        },
                                                    }),
                                                )}
                                            ></${ViraTextArea}>
                                            <div class="row-actions">
                                                <${ViraButton.assign({
                                                    text: 'Cancel',
                                                    buttonEmphasis: ViraEmphasis.Subtle,
                                                    color: ViraColorVariant.Neutral,
                                                    isDisabled: state.saving,
                                                })}
                                                    ${listen('click', () =>
                                                        updateState({
                                                            editing: false,
                                                            editingProfileId: undefined,
                                                            draft: emptyDraft,
                                                            saveError: undefined,
                                                        }),
                                                    )}
                                                ></${ViraButton}>
                                                <${ViraButton.assign({
                                                    text: state.saving
                                                        ? 'Saving...'
                                                        : 'Save profile',
                                                    color: ViraColorVariant.Brand,
                                                    isDisabled: state.saving || !!editValidation,
                                                })}
                                                    ${listen('click', saveDraft)}
                                                ></${ViraButton}>
                                            </div>
                                        </div>
                                    `
                                  : ''}
                              <div class="notice">
                                  Profile edits do not interrupt running processes. Changed commands
                                  apply the next time a tab starts or restarts.
                              </div>
                              ${state.saveError
                                  ? html`
                                        <div class="error" role="alert">${state.saveError}</div>
                                    `
                                  : ''}
                              <div class="footer">
                                  <${ViraButton.assign({
                                      text: 'Close',
                                      color: ViraColorVariant.Neutral,
                                      isDisabled: state.saving,
                                  })}
                                      ${listen('click', close)}
                                  ></${ViraButton}>
                              </div>
                          </div>
                      `
                    : ''}
            </${ViraModal}>
        `;
    },
});
