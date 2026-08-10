// cspell:words honorspren, spren, Stormlight

/**
 * Geometry for the honorspren pet: no body at all, just a ribbon of Stormlight spiralling down from
 * a bright head-point, drawn in the same 40x48 viewBox as the other species.
 *
 * The ribbon is sampled rather than hand-authored because its shape is a function of the mood — a
 * fixed path could not coil tighter or narrow as the spren settles.
 */

import {PetMood} from './pet-mood.js';

const ribbonSampleCount = 30;
const centerX = 20;

export type SprenPose = Readonly<{
    /** How many turns the ribbon makes on its way down. */
    coils: number;
    /** Half-width of the widest turn. */
    amplitude: number;
    /** Where the bright end starts. */
    headY: number;
    /** Where the ribbon runs out. */
    tailY: number;
    /** Brightness of the head-point and its halo, 0–1. */
    glow: number;
    strokeWidth: number;
    /** Stroke width of the near half-turns; the far ones are drawn thinner. */
    coilWidth: number;
    headRadius: number;
    ribbonAnimation: string;
}>;

export const sprenPoses: Record<PetMood, SprenPose> = {
    /** Wide, slow turns and full brightness: the spren is holding itself up in front of you. */
    [PetMood.NeedsYou]: {
        coils: 2.6,
        amplitude: 7,
        headY: 5,
        tailY: 41,
        glow: 1,
        coilWidth: 2.2,
        strokeWidth: 1.5,
        headRadius: 2.9,
        ribbonAnimation: 'spren-flare 0.9s ease-in-out infinite',
    },
    /** More turns, slightly narrower: the same light, busier. */
    [PetMood.Working]: {
        coils: 3.4,
        amplitude: 5.6,
        headY: 6.5,
        tailY: 42,
        glow: 0.85,
        coilWidth: 1.9,
        strokeWidth: 1.35,
        headRadius: 2.5,
        ribbonAnimation: 'spren-stream 2.6s ease-in-out infinite',
    },
    /** Loose, lazy turns — the widest-pitched spiral, and dimmer. */
    [PetMood.Resting]: {
        coils: 1.8,
        amplitude: 3.6,
        headY: 9,
        tailY: 43,
        glow: 0.6,
        coilWidth: 1.5,
        strokeWidth: 1.2,
        headRadius: 2.2,
        ribbonAnimation: 'spren-drift 4.5s ease-in-out infinite',
    },
    /**
     * A ribbon has no posture to slump, which the plan flagged as the open question for this
     * species. The answer: it coils tight and sinks. Many turns, almost no width, and the head
     * dropped near the floor reads unmistakably as a light that has settled and gone quiet.
     */
    [PetMood.Asleep]: {
        coils: 4.6,
        amplitude: 1.8,
        headY: 26,
        tailY: 44.5,
        glow: 0.3,
        coilWidth: 1.1,
        strokeWidth: 1.05,
        headRadius: 1.7,
        ribbonAnimation: 'spren-settle 7s ease-in-out infinite',
    },
};

export function sprenHeadPoint(pose: Readonly<SprenPose>) {
    return {
        x: centerX,
        y: round(pose.headY),
    };
}

/**
 * The ribbon's centerline, top to bottom. The turn width tapers toward both ends — zero at the head
 * so the ribbon leaves the bright point cleanly, and near-zero at the tail so it dissolves rather
 * than stopping mid-swing.
 */
export function sprenRibbonSamples(pose: Readonly<SprenPose>): Array<{x: number; y: number}> {
    return Array.from(
        {
            length: ribbonSampleCount,
        },
        (_unused, index) => {
            const progress = index / (ribbonSampleCount - 1);
            const taper = Math.sin(Math.PI * Math.min(1, progress * 1.15));
            return {
                x: round(
                    centerX +
                        Math.sin(progress * pose.coils * Math.PI * 2) * pose.amplitude * taper,
                ),
                y: round(pose.headY + progress * (pose.tailY - pose.headY)),
            };
        },
    );
}

/**
 * The ribbon as a coil, which is the only construction that actually reads as a spiral at this
 * size. A coil seen from the side is a sequence of half-turns alternating between the near side and
 * the far side of the axis; drawing the near ones bright and thick and the far ones dim and thin is
 * what supplies the depth. Offsetting a single wavy line sideways cannot do this — where the line
 * swings fastest, a sideways offset collapses and self-intersects.
 */
export function sprenCoilArcs(pose: Readonly<SprenPose>): {
    near: string[];
    far: string[];
} {
    const halfTurns = Math.max(2, Math.round(pose.coils * 2));
    const pitch = (pose.tailY - pose.headY) / halfTurns;
    const near: string[] = [];
    const far: string[] = [];

    for (let index = 0; index < halfTurns; index++) {
        const startY = pose.headY + index * pitch;
        const endY = startY + pitch;
        /**
         * Turns narrow toward both ends so the coil emerges from the head and dissolves at the
         * tail.
         */
        const startWidth = pose.amplitude * taperAt(index / halfTurns);
        const endWidth = pose.amplitude * taperAt((index + 1) / halfTurns);
        const isNear = index % 2 === 0;
        const startX = centerX + (isNear ? -startWidth : startWidth);
        const endX = centerX + (isNear ? endWidth : -endWidth);
        const radiusX = round(Math.max(0.35, (startWidth + endWidth) / 2));
        const radiusY = round(Math.max(0.35, pitch * 0.62));
        const arc = `M${round(startX)} ${round(startY)}A${radiusX} ${radiusY} 0 0 ${isNear ? 1 : 0} ${round(endX)} ${round(endY)}`;
        (isNear ? near : far).push(arc);
    }

    return {
        near,
        far,
    };
}

/** Zero-ish at both ends, full in the middle. Shared by the coil and the centerline sampling. */
function taperAt(progress: number): number {
    return Math.sin(Math.PI * Math.min(1, progress * 1.08)) * 0.88 + 0.12;
}

/**
 * The sampled centerline as a smooth path. Midpoint-quadratic smoothing keeps the spiral from
 * reading as a polygon at this sample count, and costs nothing at render time.
 */
export function buildSprenRibbonPath(pose: Readonly<SprenPose>): string {
    const samples = sprenRibbonSamples(pose);
    const [start] = samples;
    if (!start) {
        return '';
    }
    return samples.slice(1).reduce((path, point, index) => {
        const previous = samples[index];
        if (!previous) {
            return path;
        }
        const midX = round((previous.x + point.x) / 2);
        const midY = round((previous.y + point.y) / 2);
        return `${path}Q${previous.x} ${previous.y} ${midX} ${midY}`;
    }, `M${start.x} ${start.y}`);
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
