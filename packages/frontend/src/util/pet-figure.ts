/**
 * Geometry for the pet's mistcloak, drawn in a 40x48 viewBox. A mistcloak isn't one piece of cloth
 * — it's many ribbonlike strips sewn to a mantle at the shoulders that otherwise hang free and
 * stream like overlapping streamers, so each strip is generated and animated independently.
 */

export const ribbonCount = 15;

const mantleLeftX = 12;
const mantleRightX = 28;
const spineLength = 13;

/**
 * Per-strip length offsets. Uniform strips read as a mop fringe rather than cloth, so the cloak is
 * deliberately ragged; the table is fixed so the silhouette doesn't reshuffle on every render.
 */
const raggedness: ReadonlyArray<number> = [
    0.9,
    -1.4,
    1.6,
    -0.6,
    1.2,
    -1.7,
    0.4,
    1.8,
    -0.9,
    1.1,
    -1.5,
    0.7,
    -1.2,
    1.4,
    -0.5,
];

export type RibbonPose = Readonly<{
    index: number;
    /** How far the outer strips fan away from the body. */
    spread: number;
    /** How far every strip streams in one direction, as if caught by the mists. */
    curl: number;
}>;

/** -1 at the far left strip, 0 at the spine, 1 at the far right. */
function centerOffset(index: number): number {
    return (index - (ribbonCount - 1) / 2) / ((ribbonCount - 1) / 2);
}

function ribbonTopX(index: number): number {
    return mantleLeftX + ((mantleRightX - mantleLeftX) * index) / (ribbonCount - 1);
}

/** Strips leave the mantle along its curved hem, so the outer ones start higher on the shoulder. */
export function ribbonTopY(index: number): number {
    return 19.8 + 1.6 * (1 - Math.abs(centerOffset(index)));
}

/**
 * Longest at the edges, shortest over the spine. A cloak that is longest in the middle fills the
 * silhouette and reads as a skirt; hanging it open lets the figure's body and legs show through.
 */
export function ribbonLength(index: number): number {
    return spineLength + Math.abs(centerOffset(index)) * 6 + (raggedness[index] ?? 0);
}

export function ribbonEndPoint({index, spread, curl}: RibbonPose) {
    return {
        x: ribbonTopX(index) + spread * centerOffset(index) + curl,
        y: ribbonTopY(index) + ribbonLength(index),
    };
}

export function buildRibbonPath({index, spread, curl}: RibbonPose): string {
    const end = ribbonEndPoint({
        index,
        spread,
        curl,
    });
    const controlX = ribbonTopX(index) + (spread * centerOffset(index)) / 2 - curl * 0.35;
    const controlY = ribbonTopY(index) + ribbonLength(index) * 0.55;

    return `M${round(ribbonTopX(index))} ${round(ribbonTopY(index))}Q${round(controlX)} ${round(controlY)} ${round(end.x)} ${round(end.y)}`;
}

/** Strips nearer the spine are drawn heavier, so the cloak reads as layered rather than flat. */
export function ribbonOpacity(index: number): number {
    return round(0.85 - Math.abs(centerOffset(index)) * 0.3);
}

/**
 * Staggered so the strips ripple in sequence rather than moving as one rigid sheet. Offset from the
 * spine outward, which reads as the motion travelling through the cloth.
 */
export function ribbonDelaySeconds(index: number): number {
    return round(Math.abs(centerOffset(index)) * 0.35 + (index % 3) * 0.06);
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
