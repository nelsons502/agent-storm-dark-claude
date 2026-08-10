import {MergeStepState, type FolderInfo} from '@agent-storm/common';
import {css, defineElement, defineElementEvent, html, listen, type CSSResult} from 'element-vir';
import {createSizedIcon, lucideIcons, viraThemeByKeys, type ViraIconSvg} from 'vira';
import {calculateMergeSteps, type MergeStep, type MergeStepAction} from '../../util/merge-steps.js';
import {ScreenSize} from '../../util/screen-size.js';

/**
 * State colors come from the vira theme rather than literals so the clay (`dark-claude`) and blue
 * (`dark-codex`) retints of the scales carry through, matching how the GitHub pane colors checks.
 */
const stateColors: Readonly<Record<MergeStepState, CSSResult>> = {
    [MergeStepState.Todo]: viraThemeByKeys.grey.foreground.header.foreground.value,
    [MergeStepState.Loading]: viraThemeByKeys.yellow.foreground.header.foreground.value,
    [MergeStepState.Failed]: viraThemeByKeys.red.foreground.header.foreground.value,
    [MergeStepState.Done]: viraThemeByKeys.green.foreground.header.foreground.value,
};

const stateIcons: Readonly<Record<MergeStepState, ViraIconSvg | undefined>> = {
    [MergeStepState.Todo]: undefined,
    [MergeStepState.Loading]: undefined,
    [MergeStepState.Failed]: createSizedIcon(lucideIcons.CircleAlert, 14),
    [MergeStepState.Done]: createSizedIcon(lucideIcons.Check, 14),
};

export type MergeStepActionDetail = {
    folder: string;
    step: MergeStep;
    action: MergeStepAction;
};

export const VirProgressTracker = defineElement<{
    folder: Readonly<FolderInfo>;
    screenSize: ScreenSize;
}>()({
    tagName: 'vir-progress-tracker',
    events: {
        /** The parent owns every side effect — switching tabs, writing the attestation. */
        stepActionRequested: defineElementEvent<MergeStepActionDetail>(),
    },
    styles: css`
        :host {
            display: block;
            padding: 6px 12px;
            border-bottom: 1px solid var(--app-border);
            background: var(--app-chrome-bg, var(--app-surface));
            font-family: var(--app-font-sans, ui-sans-serif, system-ui, sans-serif);
            font-size: 12px;
            /** Long step lists scroll rather than pushing the panes out of the viewport. */
            overflow-x: auto;
        }

        .steps {
            display: flex;
            align-items: center;
            min-width: max-content;
        }

        .step {
            display: flex;
            align-items: center;
            gap: 6px;
            position: relative;
        }

        .connector {
            width: 18px;
            height: 1px;
            margin: 0 4px;
            background: var(--app-border);
            flex: none;
        }

        .marker {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            border: 1px solid currentColor;
            font-size: 10px;
            flex: none;
        }

        .step[data-state='loading'] .marker {
            /**
             * A rotating dashed ring reads as motion without a spinner asset, and stays legible at
             * 20px in every theme because it borrows the step's own state color.
             */
            border-style: dashed;
            animation: spin 1.6s linear infinite;
        }

        @keyframes spin {
            to {
                transform: rotate(360deg);
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .step[data-state='loading'] .marker {
                animation: none;
            }
        }

        button.step {
            border: none;
            background: none;
            padding: 2px 4px;
            color: inherit;
            font: inherit;
            cursor: pointer;
            border-radius: var(--app-radius-sm, 6px);
        }

        button.step:hover,
        button.step:focus-visible {
            background: var(--app-hover);
        }

        .popover {
            position: absolute;
            top: calc(100% + 4px);
            left: 0;
            z-index: 20;
            display: none;
            flex-direction: column;
            min-width: 140px;
            padding: 4px;
            border: 1px solid var(--app-border);
            border-radius: var(--app-radius-md, 8px);
            background: var(--app-surface-raised, var(--app-surface));
            box-shadow: var(--app-overlay-shadow);
        }

        .step:hover .popover,
        .step:focus-within .popover {
            display: flex;
        }

        .popover button {
            border: none;
            background: none;
            padding: 6px 8px;
            text-align: left;
            color: var(--app-text);
            font: inherit;
            font-size: 12px;
            cursor: pointer;
            border-radius: var(--app-radius-sm, 6px);
        }

        .popover button:hover,
        .popover button:focus-visible {
            background: var(--app-hover);
        }

        /**
         * Mobile collapses to a dot row plus the one label that matters, mirroring how the sidebar
         * becomes a modal rather than simply hiding.
         */
        .steps[data-mobile] .label {
            display: none;
        }

        .steps[data-mobile] .current-label {
            display: inline;
            margin-left: 8px;
            color: var(--app-muted);
        }

        .current-label {
            display: none;
        }
    `,
    render({inputs, dispatch, events}) {
        const steps = calculateMergeSteps(inputs.folder);
        const isMobile = inputs.screenSize === ScreenSize.Mobile;
        /**
         * The step the user is actually on: the first thing not yet done. Everything done means the
         * work has landed, so fall back to the last step's label rather than showing nothing.
         */
        const currentStep =
            steps.find((step) => step.state !== MergeStepState.Done) || steps.at(-1);

        function fire(step: MergeStep, action: MergeStepAction): void {
            dispatch(
                new events.stepActionRequested({
                    folder: inputs.folder.path,
                    step,
                    action,
                }),
            );
        }

        return html`
            <div class="steps" ?data-mobile=${isMobile} role="list">
                ${steps.map((step, index) => {
                    const icon = stateIcons[step.state];
                    const marker = html`
                        <span
                            class="marker"
                            style=${css`
                                color: ${stateColors[step.state]};
                            `}
                            aria-hidden="true"
                        >
                            ${icon ? icon.svgTemplate : String(index + 1)}
                        </span>
                        <span class="label">${step.label}</span>
                    `;

                    const body = step.popoverActions.length
                        ? /**
                           * A step with a popover is inert on direct click: otherwise one click both opens the menu and
                           * fires the step's own action.
                           */
                          html`
                              <div
                                  class="step"
                                  data-state=${step.state}
                                  role="listitem"
                                  tabindex="0"
                              >
                                  ${marker}
                                  <div class="popover">
                                      ${step.popoverActions.map(
                                          (popoverAction) => html`
                                              <button
                                                  type="button"
                                                  ${listen('click', () =>
                                                      fire(step, popoverAction.action),
                                                  )}
                                              >
                                                  ${popoverAction.label}
                                              </button>
                                          `,
                                      )}
                                  </div>
                              </div>
                          `
                        : html`
                              <div class="step" data-state=${step.state} role="listitem">
                                  ${marker}
                              </div>
                          `;

                    return html`
                        ${index
                            ? html`
                                  <span class="connector"></span>
                              `
                            : ''}
                        ${body}
                    `;
                })}
                <span class="current-label">${currentStep?.label || ''}</span>
            </div>
        `;
    },
});
