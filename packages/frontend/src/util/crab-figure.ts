// cspell:words honorspren, spren, Stormlight

/**
 * Geometry for the crab pet, drawn in the same 40x48 viewBox as the cloaked figure. The silhouette
 * is deliberately sparse — one shell, two tall eyestalks, claws and legs reduced to hints — because
 * the pet renders at 61x74 CSS pixels and anything finer than about 1.5px simply disappears.
 *
 * Mood is carried by the two parts that read at that size: the claws (raised → forward → lowered →
 * tucked) and the eyestalks (extended → scanning → half → retracted). The shell only shifts enough
 * to let the crab settle when it sleeps.
 */

import {PetMood} from './pet-mood.js';

export const petViewBox = {
    width: 40,
    height: 48,
    centerX: 20,
} as const;

/** -1 for the crab's left side, 1 for its right. Multiplying x by this mirrors any shape. */
export type CrabSide = -1 | 1;

export type CrabPose = Readonly<{
    shellCy: number;
    shellRx: number;
    shellRy: number;
    /** How far each eyestalk rises off the shell. */
    stalkLength: number;
    /** How far the tips lean outward; negative leans them inward, which reads as drowsy. */
    stalkSplay: number;
    eyeRadius: number;
    eyesOpen: boolean;
    /** Vertical center of each claw. Smaller is higher, since SVG y grows downward. */
    clawY: number;
    /** How far the claws sit from the center line. */
    clawOut: number;
    clawScale: number;
    /** How far the legs splay out from under the shell. */
    legSpread: number;
    figureAnimation: string;
}>;

export const crabPoses: Record<PetMood, CrabPose> = {
    /** Both claws up and eyestalks at full stretch: the crab is looking straight at you. */
    [PetMood.NeedsYou]: {
        shellCy: 31,
        shellRx: 10.4,
        shellRy: 7.6,
        stalkLength: 9.2,
        stalkSplay: 0,
        eyeRadius: 2.3,
        eyesOpen: true,
        clawY: 20.4,
        clawOut: 9.6,
        clawScale: 1,
        legSpread: 3.4,
        figureAnimation: 'crab-alert 0.9s ease-in-out infinite',
    },
    /** Claws forward and eyestalks sweeping outward, as if watching something happen. */
    [PetMood.Working]: {
        shellCy: 31,
        shellRx: 10.4,
        shellRy: 7.6,
        stalkLength: 7.4,
        stalkSplay: 1.8,
        eyeRadius: 2.1,
        eyesOpen: true,
        clawY: 25,
        clawOut: 10.8,
        clawScale: 0.95,
        legSpread: 4.2,
        figureAnimation: 'crab-scuttle 2.4s ease-in-out infinite',
    },
    [PetMood.Resting]: {
        shellCy: 31.6,
        shellRx: 10.4,
        shellRy: 7.6,
        stalkLength: 4.6,
        stalkSplay: 0.6,
        eyeRadius: 1.9,
        eyesOpen: true,
        clawY: 28.4,
        clawOut: 10.2,
        clawScale: 0.9,
        legSpread: 3,
        figureAnimation: 'crab-breathe 4.5s ease-in-out infinite',
    },
    /** Everything folds in: stalks down onto the shell, claws tucked under it, body settled. */
    [PetMood.Asleep]: {
        shellCy: 33.2,
        shellRx: 10.4,
        shellRy: 7.6,
        stalkLength: 1.4,
        stalkSplay: -0.8,
        eyeRadius: 1.7,
        eyesOpen: false,
        clawY: 31.4,
        clawOut: 8.6,
        clawScale: 0.8,
        legSpread: 2,
        figureAnimation: 'crab-slump 7s ease-in-out infinite',
    },
};

/** Where a stalk leaves the shell — inset from the center line, up on the dome. */
function stalkBase(side: CrabSide, pose: Readonly<CrabPose>) {
    return {
        x: petViewBox.centerX + side * 3.3,
        y: pose.shellCy - pose.shellRy * 0.84,
    };
}

export function crabEyeCenter({
    side,
    pose,
}: Readonly<{
    side: CrabSide;
    pose: Readonly<CrabPose>;
}>) {
    const base = stalkBase(side, pose);
    return {
        x: round(base.x + side * pose.stalkSplay),
        y: round(base.y - pose.stalkLength),
    };
}

/** A single stalk, bowed slightly outward so it reads as flesh rather than a stick. */
export function buildEyestalkPath({
    side,
    pose,
}: Readonly<{
    side: CrabSide;
    pose: Readonly<CrabPose>;
}>): string {
    const base = stalkBase(side, pose);
    const tip = crabEyeCenter({
        side,
        pose,
    });
    const controlX = round(base.x + side * (pose.stalkSplay * 0.35 + 0.5));
    const controlY = round(base.y - pose.stalkLength * 0.55);
    return `M${round(base.x)} ${round(base.y)}Q${controlX} ${controlY} ${tip.x} ${tip.y}`;
}

/**
 * One pincer, described once facing right and mirrored by multiplying x by `side`. Quadratic curves
 * rather than arcs specifically so mirroring is a sign flip and not an arc-sweep puzzle. The notch
 * in the middle of the outer edge is the pincer's gap.
 */
const clawOutline: ReadonlyArray<
    Readonly<{
        command: string;
        points: ReadonlyArray<
            [
                number,
                number,
            ]
        >;
    }>
> = [
    {
        command: 'M',
        points: [
            [
                -2.4,
                -2.6,
            ],
        ],
    },
    {
        command: 'Q',
        points: [
            [
                3.4,
                -3,
            ],
            [
                2.9,
                -0.9,
            ],
        ],
    },
    {
        command: 'L',
        points: [
            [
                0.2,
                -0.2,
            ],
        ],
    },
    {
        command: 'L',
        points: [
            [
                2.9,
                1.2,
            ],
        ],
    },
    {
        command: 'Q',
        points: [
            [
                3.4,
                3,
            ],
            [
                -2.4,
                2.6,
            ],
        ],
    },
    {
        command: 'Q',
        points: [
            [
                -3.6,
                0,
            ],
            [
                -2.4,
                -2.6,
            ],
        ],
    },
];

export function buildClawPath({
    side,
    pose,
}: Readonly<{
    side: CrabSide;
    pose: Readonly<CrabPose>;
}>): string {
    const centerX = petViewBox.centerX + side * pose.clawOut;
    return (
        clawOutline
            .map(({command, points}) => {
                const rendered = points
                    .map(
                        ([
                            x,
                            y,
                        ]) =>
                            `${round(centerX + side * x * pose.clawScale)} ${round(pose.clawY + y * pose.clawScale)}`,
                    )
                    .join(' ');
                return `${command}${rendered}`;
            })
            .join('') + 'Z'
    );
}

/**
 * Two legs per side, as short strokes reaching down and out from under the shell. Any more than
 * this turns into a smudge at render size.
 */
export function crabLegPaths(pose: Readonly<CrabPose>): string[] {
    const sides: ReadonlyArray<CrabSide> = [
        -1,
        1,
    ];
    return sides.flatMap((side) =>
        [
            0,
            1,
        ].map((index) => {
            const startX = petViewBox.centerX + side * (pose.shellRx * 0.62 + index * 1.2);
            const startY = pose.shellCy + 1.6 + index * 2.6;
            const endX = startX + side * (pose.legSpread + index * 0.4);
            const endY = startY + 3.6 - index * 0.6;
            return `M${round(startX)} ${round(startY)}L${round(endX)} ${round(endY)}`;
        }),
    );
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
