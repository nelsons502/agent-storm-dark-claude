import {type AgentProfile} from '@agent-storm/common';
import {css, defineElement, defineElementEvent, html, listen} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraEmphasis, ViraModal, ViraSelect} from 'vira';
import {buildAgentProfilePickerOptions} from '../../util/agent-profiles.js';

export const VirAgentProfilePickerModal = defineElement<{
    open: boolean;
    profiles: ReadonlyArray<AgentProfile>;
    inheritedProfileId: string;
    selectedProfileId: string;
    inheritLabel: string;
    modalTitle: string;
    saveLabel: string;
    message: string;
}>()({
    tagName: 'vir-agent-profile-picker-modal',
    events: {
        closeRequested: defineElementEvent<void>(),
        selectionConfirmed: defineElementEvent<string>(),
    },
    state() {
        return {
            wasOpen: false,
            selection: '',
        };
    },
    styles: css`
        :host {
            font-family: var(--app-font-sans, ui-sans-serif, system-ui, sans-serif);
        }

        .body {
            display: flex;
            flex-direction: column;
            gap: 14px;
            width: min(480px, calc(100dvw - 64px));
            max-width: 100%;
            box-sizing: border-box;
        }

        .message {
            color: var(--app-muted);
            font-size: 13px;
            line-height: 1.45;
        }

        .footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            padding-top: 12px;
            border-top: 1px solid var(--app-border);
        }

        @media (max-width: 640px) {
            .body {
                width: calc(100dvw - 32px);
            }

            .footer {
                flex-wrap: wrap;
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        if (state.wasOpen !== inputs.open) {
            updateState({
                wasOpen: inputs.open,
                selection: inputs.selectedProfileId,
            });
        }
        return html`
            <${ViraModal.assign({
                open: inputs.open,
                modalTitle: inputs.modalTitle,
            })}
                ${listen(ViraModal.events.modalClose, () => dispatch(new events.closeRequested()))}
            >
                ${inputs.open
                    ? html`
                          <div class="body">
                              <${ViraSelect.assign({
                                  label: 'Agent profile',
                                  options: buildAgentProfilePickerOptions({
                                      profiles: inputs.profiles,
                                      inheritedProfileId: inputs.inheritedProfileId,
                                      inheritLabel: inputs.inheritLabel,
                                  }),
                                  value: state.selection,
                              })}
                                  ${listen(ViraSelect.events.valueChange, (event) =>
                                      updateState({
                                          selection: event.detail,
                                      }),
                                  )}
                              ></${ViraSelect}>
                              <div class="message">${inputs.message}</div>
                              <div class="footer">
                                  <${ViraButton.assign({
                                      text: 'Cancel',
                                      buttonEmphasis: ViraEmphasis.Subtle,
                                      color: ViraColorVariant.Neutral,
                                  })}
                                      ${listen('click', () =>
                                          dispatch(new events.closeRequested()),
                                      )}
                                  ></${ViraButton}>
                                  <${ViraButton.assign({
                                      text: inputs.saveLabel,
                                      color: ViraColorVariant.Brand,
                                  })}
                                      ${listen('click', () =>
                                          dispatch(new events.selectionConfirmed(state.selection)),
                                      )}
                                  ></${ViraButton}>
                              </div>
                          </div>
                      `
                    : ''}
            </${ViraModal}>
        `;
    },
});
