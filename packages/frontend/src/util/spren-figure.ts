// cspell:words honorspren, spren, Stormlight

/**
 * Geometry for the honorspren pet, drawn in the same 40x48 viewBox as the other species.
 *
 * The figure is three parts: a crystalline shard of light for the head, a short two-tone band under
 * it, and trailing strands that fall the rest of the way. The band's faces alternate light and dark
 * so it reads as a ribbon turning rather than a stack of bars, and each band and strand carries its
 * own animation phase so a wave travels down the figure instead of it moving as one rigid sheet.
 *
 * Everything here is pose data and path strings — the motion itself is CSS in `vir-pet`, using the
 * same staggered-delay approach the original mistcloak strips already use. No path morphing, so it
 * behaves the same in every browser and collapses cleanly under `prefers-reduced-motion`.
 */

import {PetMood} from './pet-mood.js';

export const petBoxHeight = 48;
const centerX = 20;

export type SprenPose = Readonly<{
    /** Top point of the shard. Sinking this is how the whole figure settles when asleep. */
    headTop: number;
    headHeight: number;
    /** Half-width of the shard at its widest. */
    headWidth: number;
    bandTop: number;
    bandBottom: number;
    /** Half-width of the widest band. */
    bandWidth: number;
    bandCount: number;
    /** Length of the longest strand, before each strand's own scaling. */
    strandLength: number;
    /** How far the strands wander from the center line. Near zero reads as hanging limp. */
    strandSway: number;
    /**
     * A constant sideways drift applied down the strands, growing toward the tips. Waiting is
     * symmetric; working leans, which is what distinguishes the two in a still frame.
     */
    strandLean: number;
    /** Brightness of the shard and its halo, 0–1. */
    glow: number;
    bandDurationSeconds: number;
    strandDurationSeconds: number;
    headDurationSeconds: number;
}>;

export const sprenPoses: Record<PetMood, SprenPose> = {
    /** Held high and bright, strands streaming: the spren is in front of you and waiting. */
    [PetMood.NeedsYou]: {
        headTop: 3.4,
        headHeight: 7.6,
        headWidth: 4.1,
        bandTop: 11.5,
        bandBottom: 18,
        bandWidth: 5.6,
        bandCount: 3,
        strandLength: 25.5,
        strandSway: 5.2,
        strandLean: 0,
        glow: 1,
        bandDurationSeconds: 1.8,
        strandDurationSeconds: 2.1,
        headDurationSeconds: 2.6,
    },
    /** Same posture, quicker: the band squeezes and the strands whip faster. */
    [PetMood.Working]: {
        headTop: 3.6,
        headHeight: 7.4,
        headWidth: 3.9,
        bandTop: 11.6,
        bandBottom: 18,
        bandWidth: 5.3,
        bandCount: 3,
        strandLength: 24.5,
        strandSway: 4.4,
        strandLean: 2.2,
        glow: 0.85,
        bandDurationSeconds: 1.4,
        strandDurationSeconds: 2.4,
        headDurationSeconds: 3,
    },
    [PetMood.Resting]: {
        headTop: 5,
        headHeight: 7,
        headWidth: 3.6,
        bandTop: 12.6,
        bandBottom: 18.4,
        bandWidth: 4.7,
        bandCount: 3,
        strandLength: 22,
        strandSway: 2.8,
        strandLean: -0.9,
        glow: 0.6,
        bandDurationSeconds: 3.4,
        strandDurationSeconds: 4.2,
        headDurationSeconds: 5,
    },
    /**
     * Asleep: the whole figure sinks, the band compresses, the strands pull in and hang almost
     * straight, and the light goes low. This species has no posture to slump, so settling and going
     * quiet is what stands in for it.
     */
    [PetMood.Asleep]: {
        headTop: 12.5,
        headHeight: 6.2,
        headWidth: 3.1,
        bandTop: 19,
        bandBottom: 23.4,
        bandWidth: 3.8,
        bandCount: 3,
        strandLength: 17,
        strandSway: 1.1,
        strandLean: 0.4,
        glow: 0.3,
        bandDurationSeconds: 6,
        strandDurationSeconds: 7,
        headDurationSeconds: 8,
    },
};

export function sprenHeadCenter(pose: Readonly<SprenPose>) {
    return {
        x: centerX,
        y: round(pose.headTop + pose.headHeight / 2),
    };
}

/** The shard: a tall diamond, which is the part that reads as "alive" at 61px. */
export function sprenShardPath(pose: Readonly<SprenPose>): string {
    const half = pose.headHeight / 2;
    return (
        `M${centerX} ${round(pose.headTop)}` +
        `l${round(pose.headWidth)} ${round(half)}` +
        `L${centerX} ${round(pose.headTop + pose.headHeight)}` +
        `l${round(-pose.headWidth)} ${round(-half)}z`
    );
}

/** The lit half of the shard, drawn over the whole so the crystal has a bright facet. */
export function sprenShardFacetPath(pose: Readonly<SprenPose>): string {
    const half = pose.headHeight / 2;
    return (
        `M${centerX} ${round(pose.headTop)}` +
        `l${round(pose.headWidth)} ${round(half)}` +
        `L${centerX} ${round(pose.headTop + pose.headHeight)}z`
    );
}

export type SprenBand = Readonly<{
    path: string;
    /** Alternating faces are what make the stack read as one ribbon turning. */
    isLightFace: boolean;
    delaySeconds: number;
    topY: number;
    bottomY: number;
}>;

/**
 * The band, sliced top to bottom. Each slice tapers slightly toward the ends so the stack reads as
 * a ribbon rather than a barrel, and each is delayed a little more than the one above it so the
 * squeeze travels downward.
 */
export function sprenBandPaths(pose: Readonly<SprenPose>): SprenBand[] {
    const span = (pose.bandBottom - pose.bandTop) / pose.bandCount;
    return Array.from(
        {
            length: pose.bandCount,
        },
        (_unused, index) => {
            const topY = round(pose.bandTop + index * span);
            const bottomY = round(pose.bandTop + (index + 1) * span);
            const taper =
                1 - (Math.abs(index - (pose.bandCount - 1) / 2) / (pose.bandCount + 0.6)) * 0.5;
            const width = pose.bandWidth * taper;
            /** Slightly narrower at the bottom edge, so consecutive slices imply a turn. */
            const bottomWidth = width * 0.86;
            return {
                path:
                    `M${round(centerX - width)} ${topY}` +
                    `L${round(centerX + width)} ${topY}` +
                    `L${round(centerX + bottomWidth)} ${bottomY}` +
                    `L${round(centerX - bottomWidth)} ${bottomY}z`,
                isLightFace: index % 2 === 0,
                delaySeconds: round(index * 0.15),
                topY,
                bottomY,
            };
        },
    );
}

/**
 * Relative shape of each strand. Distinct weights, phases and lengths per strand so the three never
 * swing together — that synchrony is what made an earlier attempt look like one flapping sheet.
 */
const strandSpecs: ReadonlyArray<
    Readonly<{
        /** Multipliers on the pose's sway, at the control points and the tip. */
        swayControl: number;
        swayMid: number;
        swayTip: number;
        lengthScale: number;
        strokeWidth: number;
        opacity: number;
        delaySeconds: number;
    }>
> = [
    {
        swayControl: 1,
        swayMid: 0.5,
        swayTip: -0.3,
        lengthScale: 1,
        strokeWidth: 1.7,
        opacity: 0.85,
        delaySeconds: 0,
    },
    {
        swayControl: -0.85,
        swayMid: -0.4,
        swayTip: 0.26,
        lengthScale: 0.92,
        strokeWidth: 1.15,
        opacity: 0.5,
        delaySeconds: 0.3,
    },
    {
        swayControl: 0.5,
        swayMid: -0.54,
        swayTip: -0.18,
        lengthScale: 0.84,
        strokeWidth: 0.85,
        opacity: 0.33,
        delaySeconds: 0.62,
    },
];

export type SprenStrand = Readonly<{
    path: string;
    strokeWidth: number;
    opacity: number;
    delaySeconds: number;
}>;

/** The lowest point any strand reaches, so callers can prove the figure fits its box. */
export function sprenStrandEndY(pose: Readonly<SprenPose>): number {
    return round(
        pose.bandBottom +
            pose.strandLength * Math.max(...strandSpecs.map((spec) => spec.lengthScale)),
    );
}

/**
 * The strands, each an S-curve leaving the bottom edge of the band. They start exactly at
 * `bandBottom` so the figure has no seam between its band and its tail.
 */
export function sprenStrandPaths(pose: Readonly<SprenPose>): SprenStrand[] {
    return strandSpecs.map((spec) => {
        const length = pose.strandLength * spec.lengthScale;
        const midY = round(pose.bandBottom + length * 0.55);
        const tipY = round(pose.bandBottom + length);
        /** The lean grows with depth, so the strands bend away rather than shifting bodily. */
        const leanAt = (progress: number) => pose.strandLean * progress * progress;
        return {
            path:
                `M${centerX} ${round(pose.bandBottom)}` +
                `Q${round(centerX + pose.strandSway * spec.swayControl + leanAt(0.28))} ${round(pose.bandBottom + length * 0.28)} ` +
                `${round(centerX + pose.strandSway * spec.swayMid + leanAt(0.55))} ${midY}` +
                `Q${round(centerX + pose.strandSway * spec.swayTip * 2 + leanAt(0.8))} ${round(pose.bandBottom + length * 0.8)} ` +
                `${round(centerX + pose.strandSway * spec.swayTip + leanAt(1))} ${tipY}`,
            strokeWidth: spec.strokeWidth,
            opacity: spec.opacity,
            delaySeconds: spec.delaySeconds,
        };
    });
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
