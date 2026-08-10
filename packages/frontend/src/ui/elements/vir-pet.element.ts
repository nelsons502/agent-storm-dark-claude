// cspell:words honorspren, spren, Stormlight

import {css, defineElement, defineElementEvent, html, listen, svg} from 'element-vir';
import {
    buildClawPath,
    buildEyestalkPath,
    crabEyeCenter,
    crabLegPaths,
    crabPoses,
    type CrabSide,
} from '../../util/crab-figure.js';
import {
    buildRibbonPath,
    ribbonCount,
    ribbonDelaySeconds,
    ribbonOpacity,
} from '../../util/pet-figure.js';
import {PetMood} from '../../util/pet-mood.js';
import {PetSpecies} from '../../util/pet-species.js';
import {sprenCoilArcs, sprenHeadPoint, sprenPoses} from '../../util/spren-figure.js';

/**
 * Mood labels and accent colors are species-agnostic on purpose: the pet says the same thing
 * whichever creature is saying it, and every species takes its color from the active theme's
 * variables rather than from per-species literals.
 */
const moodLabels: Record<PetMood, string> = {
    [PetMood.NeedsYou]: 'Waiting on you',
    [PetMood.Working]: 'Working',
    [PetMood.Resting]: 'Idle',
    [PetMood.Asleep]: 'Nothing running',
};

const moodAccentVars: Record<PetMood, string> = {
    [PetMood.NeedsYou]: '--app-accent',
    [PetMood.Working]: '--app-accent',
    [PetMood.Resting]: '--app-muted',
    [PetMood.Asleep]: '--app-subtle',
};

const crabSides: ReadonlyArray<CrabSide> = [
    -1,
    1,
];

/** The crab: one shell, two eyestalks, two claws. Mood lives in the claws and the stalks. */
function renderCrab(mood: PetMood) {
    const pose = crabPoses[mood];
    const shellColor = 'var(--app-accent)';
    const limbColor = 'var(--app-muted)';
    const eyeColor = `var(${moodAccentVars[mood]})`;

    return svg`
        <g class="figure" style="animation: ${pose.figureAnimation}">
            ${crabLegPaths(pose).map(
                (path) => svg`
                    <path
                        d="${path}"
                        stroke="${limbColor}"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        opacity="0.55"
                    />
                `,
            )}
            ${crabSides.map(
                (side) => svg`
                    <path
                        class="claw"
                        d="${buildClawPath({
                            side,
                            pose,
                        })}"
                        fill="${shellColor}"
                        opacity="0.8"
                    />
                `,
            )}
            <ellipse
                cx="20"
                cy="${pose.shellCy}"
                rx="${pose.shellRx}"
                ry="${pose.shellRy}"
                fill="${shellColor}"
            />
            ${crabSides.map((side) => {
                const eye = crabEyeCenter({
                    side,
                    pose,
                });
                return svg`
                    <path
                        d="${buildEyestalkPath({
                            side,
                            pose,
                        })}"
                        stroke="${shellColor}"
                        stroke-width="1.7"
                        stroke-linecap="round"
                        fill="none"
                    />
                    <circle cx="${eye.x}" cy="${eye.y}" r="${pose.eyeRadius}" fill="${shellColor}" />
                    ${
                        pose.eyesOpen
                            ? svg`
                                <circle
                                    class="eye"
                                    cx="${eye.x}"
                                    cy="${eye.y}"
                                    r="${pose.eyeRadius * 0.45}"
                                    fill="${eyeColor}"
                                    color="${eyeColor}"
                                />
                            `
                            : svg`
                                <path
                                    d="M${eye.x - pose.eyeRadius * 0.6} ${eye.y}h${pose.eyeRadius * 1.2}"
                                    stroke="var(--app-bg)"
                                    stroke-width="0.9"
                                    stroke-linecap="round"
                                />
                            `
                    }
                `;
            })}
        </g>
    `;
}

/**
 * The honorspren: a ribbon of light falling from a bright head-point, with no body. Asleep coils it
 * tight and sinks it, which is this species' answer to having no posture to slump.
 */
function renderSpren(mood: PetMood) {
    const pose = sprenPoses[mood];
    const head = sprenHeadPoint(pose);
    const {near, far} = sprenCoilArcs(pose);
    const lightColor = 'var(--app-accent)';

    return svg`
        <g class="figure" style="animation: ${pose.ribbonAnimation}">
            ${far.map(
                (arc) => svg`
                    <path
                        d="${arc}"
                        stroke="${lightColor}"
                        stroke-width="${pose.coilWidth * 0.55}"
                        stroke-linecap="round"
                        fill="none"
                        opacity="${0.18 + pose.glow * 0.18}"
                    />
                `,
            )}
            ${near.map(
                (arc) => svg`
                    <path
                        d="${arc}"
                        stroke="${lightColor}"
                        stroke-width="${pose.coilWidth * 1.9}"
                        stroke-linecap="round"
                        fill="none"
                        opacity="${pose.glow * 0.22}"
                    />
                    <path
                        d="${arc}"
                        stroke="${lightColor}"
                        stroke-width="${pose.coilWidth}"
                        stroke-linecap="round"
                        fill="none"
                        opacity="${0.5 + pose.glow * 0.5}"
                    />
                `,
            )}
            <circle
                cx="${head.x}"
                cy="${head.y}"
                r="${pose.headRadius * 1.9}"
                fill="${lightColor}"
                opacity="${pose.glow * 0.22}"
            />
            <circle
                class="eye"
                cx="${head.x}"
                cy="${head.y}"
                r="${pose.headRadius}"
                fill="${lightColor}"
                color="${lightColor}"
                opacity="${0.5 + pose.glow * 0.5}"
            />
        </g>
    `;
}

/** Cloaked-figure-only visual values. The crab and the spren own their own pose tables. */
type PetSpec = Readonly<{
    /** How far the cloak's strips fan away from the body. */
    spread: number;
    /** How far they all stream in one direction. */
    curl: number;
    ribbonDuration: string;
    figureAnimation: string;
    /** Static posture, applied outside the animated group so the two transforms don't collide. */
    poseTransform: string;
    legs: string;
    eyesOpen: boolean;
    /** Ground mist, shared by every species so all three sit on the same floor. */
    mistOpacity: number;
}>;

const petSpecs: Record<PetMood, PetSpec> = {
    [PetMood.NeedsYou]: {
        poseTransform: 'translate(0 -1)',
        legs: 'M17.5 33h2.1v9h-2.1zM20.4 33h2.1v9h-2.1z',
        spread: 4.5,
        curl: 1.5,
        ribbonDuration: '0.7s',
        figureAnimation: 'pet-alert 0.9s ease-in-out infinite',
        eyesOpen: true,
        mistOpacity: 0.15,
    },
    [PetMood.Working]: {
        poseTransform: 'rotate(6 20 42)',
        legs: 'M18.1 33h2.1l-2.3 8.9h-2.1zM20.2 33h2.1l2.3 8.9h-2.1z',
        spread: 2,
        curl: 5,
        ribbonDuration: '1.4s',
        figureAnimation: 'pet-lean 2.6s ease-in-out infinite',
        eyesOpen: true,
        mistOpacity: 0.3,
    },
    [PetMood.Resting]: {
        poseTransform: 'rotate(-4 20 42)',
        legs: 'M17.8 33h2.1v9h-2.1zM20.2 33h2.1v9h-2.1z',
        spread: 1,
        curl: 0.8,
        ribbonDuration: '3.2s',
        figureAnimation: 'pet-breathe 4.5s ease-in-out infinite',
        eyesOpen: true,
        mistOpacity: 0.5,
    },
    [PetMood.Asleep]: {
        poseTransform: 'translate(0 5.5)',
        legs: 'M17.3 33h2.1v5.4h-2.1zM20.6 33h2.1v5.4h-2.1z',
        spread: 0.4,
        curl: 0,
        ribbonDuration: '6s',
        figureAnimation: 'pet-slump 7s ease-in-out infinite',
        eyesOpen: false,
        mistOpacity: 0.75,
    },
};

const ribbonIndexes = Array.from(
    {
        length: ribbonCount,
    },
    (_unused, index) => index,
);

export const VirPet = defineElement<{
    mood: PetMood;
    /** Which creature to draw. A pure function of the active theme; see `pet-species.ts`. */
    species: PetSpecies;
    waitingCount: number;
    detail: string;
}>()({
    tagName: 'vir-pet',
    events: {
        /** The user poked the pet; the parent decides which waiting session to jump to. */
        petPoked: defineElementEvent<void>(),
    },
    styles: css`
        :host {
            position: fixed;
            right: 18px;
            bottom: 18px;
            z-index: 40;
            font-family: var(--app-font-sans, ui-sans-serif, system-ui, sans-serif);
        }

        button {
            position: relative;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 16px 8px 12px;
            border: 1px solid var(--app-border);
            border-radius: var(--app-radius-lg, 22px);
            background: var(--app-surface-raised, var(--app-surface));
            box-shadow: var(--app-pane-shadow);
            color: var(--app-text);
            cursor: pointer;
            font: inherit;
            font-size: 13px;
            transition:
                transform 0.15s ease,
                border-color 0.15s ease;
        }

        button:hover {
            transform: translateY(-2px);
            border-color: var(--app-border-strong);
        }

        .creature {
            display: block;
            width: 61px;
            height: 74px;
            overflow: visible;
        }

        .figure {
            transform-box: fill-box;
            transform-origin: 50% 90%;
        }

        .ribbon {
            transform-box: fill-box;
            transform-origin: top center;
            animation: ribbon-drift var(--ribbon-duration) ease-in-out infinite alternate;
        }

        .eye {
            filter: drop-shadow(0 0 3px currentColor);
        }

        .detail {
            max-width: 0;
            overflow: hidden;
            white-space: nowrap;
            opacity: 0;
            color: var(--app-muted);
            transition:
                max-width 0.2s ease,
                opacity 0.2s ease;
        }

        :host([data-mood='needs-you']) .detail,
        button:hover .detail {
            max-width: 200px;
            opacity: 1;
        }

        .badge {
            position: absolute;
            top: -4px;
            right: -4px;
            min-width: 20px;
            height: 20px;
            padding: 0 5px;
            box-sizing: border-box;
            border-radius: 999px;
            background: var(--app-accent);
            color: var(--vira-default-bg, #fff);
            font-size: 12px;
            font-weight: 600;
            line-height: 20px;
            text-align: center;
        }

        @keyframes ribbon-drift {
            from {
                transform: rotate(-3deg) scaleY(0.98);
            }
            to {
                transform: rotate(3deg) scaleY(1.02);
            }
        }

        @keyframes pet-alert {
            0%,
            100% {
                transform: translateY(0);
            }
            50% {
                transform: translateY(-3.5px);
            }
        }

        @keyframes pet-lean {
            0%,
            100% {
                transform: rotate(-3deg);
            }
            50% {
                transform: rotate(3deg);
            }
        }

        @keyframes pet-breathe {
            0%,
            100% {
                transform: scale(1);
            }
            50% {
                transform: scale(1.025);
            }
        }

        @keyframes pet-slump {
            0%,
            100% {
                transform: translateY(0) rotate(-1.5deg);
            }
            50% {
                transform: translateY(1.5px) rotate(-3deg);
            }
        }

        @keyframes mist-drift {
            0%,
            100% {
                transform: translateX(-1.5px);
            }
            50% {
                transform: translateX(1.5px);
            }
        }

        .mist {
            transform-box: fill-box;
            animation: mist-drift 5s ease-in-out infinite;
        }

        @keyframes crab-alert {
            0%,
            100% {
                transform: translateY(0);
            }
            50% {
                transform: translateY(-3px);
            }
        }

        /* Side-to-side rather than up-and-down: a crab's motion is lateral. */
        @keyframes crab-scuttle {
            0%,
            100% {
                transform: translateX(-2px) rotate(-1.5deg);
            }
            50% {
                transform: translateX(2px) rotate(1.5deg);
            }
        }

        @keyframes crab-breathe {
            0%,
            100% {
                transform: scale(1);
            }
            50% {
                transform: scale(1.03);
            }
        }

        @keyframes crab-slump {
            0%,
            100% {
                transform: translateY(0);
            }
            50% {
                transform: translateY(1.2px) scaleY(0.985);
            }
        }

        @keyframes spren-flare {
            0%,
            100% {
                opacity: 1;
                transform: translateY(0);
            }
            50% {
                opacity: 0.82;
                transform: translateY(-2.5px);
            }
        }

        @keyframes spren-stream {
            0%,
            100% {
                transform: translateX(-1.5px) scaleY(1);
            }
            50% {
                transform: translateX(1.5px) scaleY(1.02);
            }
        }

        @keyframes spren-drift {
            0%,
            100% {
                transform: translateX(-1px);
            }
            50% {
                transform: translateX(1px);
            }
        }

        @keyframes spren-settle {
            0%,
            100% {
                opacity: 0.9;
            }
            50% {
                opacity: 0.65;
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .figure,
            .ribbon,
            .mist {
                animation: none !important;
            }
        }
    `,
    render({inputs, host, dispatch, events}) {
        host.setAttribute('data-mood', inputs.mood);
        host.setAttribute('data-species', inputs.species);
        const spec = petSpecs[inputs.mood];
        const label = moodLabels[inputs.mood];
        const summary = inputs.detail ? `${label}: ${inputs.detail}` : label;

        const ribbonDurationStyle = `--ribbon-duration: ${spec.ribbonDuration}`;

        /** Each species owns its whole geometry; only the ground mist and the chrome are shared. */
        const creature =
            inputs.species === PetSpecies.Crab
                ? renderCrab(inputs.mood)
                : inputs.species === PetSpecies.Spren
                  ? renderSpren(inputs.mood)
                  : renderCloaked(inputs.mood);

        return html`
            <button
                type="button"
                title=${summary}
                aria-label=${`Agent Storm pet: ${label}`}
                ${listen('click', () => dispatch(new events.petPoked()))}
            >
                ${svg`
                    <svg
                        class="creature"
                        viewBox="0 0 40 48"
                        fill="none"
                        aria-hidden="true"
                        style="${ribbonDurationStyle}"
                    >
                        <g class="mist" opacity="${spec.mistOpacity}">
                            <ellipse cx="20" cy="44.5" rx="13" ry="1.7" fill="var(--app-subtle)" opacity="0.4" />
                            <ellipse cx="14" cy="42" rx="7" ry="1.1" fill="var(--app-subtle)" opacity="0.3" />
                            <ellipse cx="26" cy="41" rx="6" ry="1" fill="var(--app-subtle)" opacity="0.25" />
                        </g>
                        ${creature}
                    </svg>
                `}
                <span class="detail">${summary}</span>
                ${inputs.waitingCount > 1
                    ? html`
                          <span class="badge">${inputs.waitingCount}</span>
                      `
                    : ''}
            </button>
        `;
    },
});

/** The original figure, unchanged, for the two themes that have no species of their own. */
function renderCloaked(mood: PetMood) {
    const spec = petSpecs[mood];
    const eyeColor = `var(${moodAccentVars[mood]})`;
    const ribbons = ribbonIndexes.map((index) => {
        return svg`
            <path
                class="ribbon"
                style="animation-delay: ${ribbonDelaySeconds(index)}s"
                d="${buildRibbonPath({
                    index,
                    spread: spec.spread,
                    curl: spec.curl,
                })}"
                stroke="var(--app-muted)"
                stroke-width="1.05"
                stroke-linecap="round"
                opacity="${ribbonOpacity(index)}"
            />
        `;
    });
    const eyes = spec.eyesOpen
        ? svg`
            <circle class="eye" cx="18.5" cy="11.2" r="0.95" fill="${eyeColor}" color="${eyeColor}" />
            <circle class="eye" cx="21.5" cy="11.2" r="0.95" fill="${eyeColor}" color="${eyeColor}" />
        `
        : svg`
            <path
                d="M17.6 11.4h1.8M20.6 11.4h1.8"
                stroke="${eyeColor}"
                stroke-width="1.1"
                stroke-linecap="round"
            />
        `;

    return svg`
                        <g transform="${spec.poseTransform}">
                            <g class="figure" style="animation: ${spec.figureAnimation}">
                            <path d="${spec.legs}" fill="var(--app-muted)" opacity="0.5" />
                            <path
                                d="M16.4 19.5h7.2v14h-7.2z"
                                fill="var(--app-muted)"
                                opacity="0.45"
                            />
                            ${ribbons}
                            <path
                                d="M12 22.9C12 19.1 15.6 16.9 20 16.9s8 2.2 8 6z"
                                fill="var(--app-muted)"
                                opacity="0.95"
                            />
                            <path
                                d="M20 4.4c3 0 4.55 2.4 4.7 5.1.15 2.1-.25 4.1-1.15 5.5-.78 1.2-2 1.9-3.55 1.9s-2.77-.7-3.55-1.9c-.9-1.4-1.3-3.4-1.15-5.5C15.45 6.8 17 4.4 20 4.4z"
                                fill="var(--app-muted)"
                            />
                            <ellipse
                                cx="20"
                                cy="11.2"
                                rx="3"
                                ry="3.1"
                                fill="var(--app-bg)"
                                opacity="0.9"
                            />
                            ${eyes}
                            </g>
                        </g>
    `;
}
