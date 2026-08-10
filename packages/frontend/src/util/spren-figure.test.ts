// cspell:words honorspren, spren, Stormlight

import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {PetMood} from './pet-mood.js';
import {
    petBoxHeight,
    sprenBandPaths,
    sprenHeadCenter,
    sprenPoses,
    sprenShardPath,
    sprenStrandEndY,
    sprenStrandPaths,
} from './spren-figure.js';

const allMoods: ReadonlyArray<PetMood> = [
    PetMood.NeedsYou,
    PetMood.Working,
    PetMood.Resting,
    PetMood.Asleep,
];

function pathCoordinates(path: string): number[] {
    return (path.match(/-?\d+(\.\d+)?/g) || []).map(Number);
}

describe('sprenPoses', () => {
    it('covers every mood', () => {
        assert.deepEquals(Object.keys(sprenPoses).toSorted(), [...allMoods].toSorted());
    });

    it('dims the glow monotonically as the spren winds down', () => {
        const glows = allMoods.map((mood) => sprenPoses[mood].glow);

        assert.deepEquals(
            glows.toSorted((a, b) => b - a),
            glows,
        );
    });

    it('shortens the strands monotonically as the spren winds down', () => {
        const lengths = allMoods.map((mood) => sprenPoses[mood].strandLength);

        assert.deepEquals(
            lengths.toSorted((a, b) => b - a),
            lengths,
        );
    });

    it('slows the strand motion down as the spren winds down', () => {
        const durations = allMoods.map((mood) => sprenPoses[mood].strandDurationSeconds);

        assert.deepEquals(
            durations.toSorted((a, b) => a - b),
            durations,
        );
    });

    /**
     * Working and NeedsYou share a posture, so without a lean they are indistinguishable in any
     * still frame — only their animation speeds differ. The lean is what makes Working read as
     * streaming rather than just being a faster version of waiting.
     */
    it('leans the strands further when working than when waiting on you', () => {
        assert.isAbove(
            Math.abs(sprenPoses[PetMood.Working].strandLean),
            Math.abs(sprenPoses[PetMood.NeedsYou].strandLean),
        );
    });

    /**
     * A ribbon has no posture to slump, so asleep is expressed by sinking the whole figure, pulling
     * the strands in, and going dim. These assertions keep that from being lost in a later tweak.
     */
    it('sinks the head and stills the strands when asleep', () => {
        const asleep = sprenPoses[PetMood.Asleep];

        allMoods
            .filter((mood) => mood !== PetMood.Asleep)
            .forEach((mood) => {
                assert.isAbove(
                    sprenHeadCenter(asleep).y,
                    sprenHeadCenter(sprenPoses[mood]).y,
                    `asleep head should sit below the ${mood} head`,
                );
                assert.isBelow(
                    asleep.strandSway,
                    sprenPoses[mood].strandSway,
                    `asleep strands should sway less than ${mood}`,
                );
            });
    });
});

describe(sprenShardPath.name, () => {
    it('closes the shard so it can be filled', () => {
        allMoods.forEach((mood) => {
            const path = sprenShardPath(sprenPoses[mood]);
            assert.isTrue(path.startsWith('M'), `${mood} shard should start with a move`);
            assert.isTrue(path.endsWith('z'), `${mood} shard should close`);
        });
    });

    it('is centered on the view box', () => {
        assert.strictEquals(sprenHeadCenter(sprenPoses[PetMood.NeedsYou]).x, 20);
    });
});

describe(sprenBandPaths.name, () => {
    it('emits exactly the pose’s band count', () => {
        allMoods.forEach((mood) => {
            assert.strictEquals(
                sprenBandPaths(sprenPoses[mood]).length,
                sprenPoses[mood].bandCount,
                `${mood} should emit its declared number of bands`,
            );
        });
    });

    /** The alternating faces are what make this read as a band rather than a stack of bars. */
    it('alternates light and dark faces, starting light', () => {
        assert.deepEquals(
            sprenBandPaths(sprenPoses[PetMood.NeedsYou]).map((band) => band.isLightFace),
            [
                true,
                false,
                true,
            ],
        );
    });

    it('staggers the band delays so the squeeze travels downward', () => {
        const delays = sprenBandPaths(sprenPoses[PetMood.NeedsYou]).map(
            (band) => band.delaySeconds,
        );

        assert.deepEquals(
            delays.toSorted((a, b) => a - b),
            delays,
        );
        assert.isAbove(delays.at(-1) ?? 0, 0, 'later bands should lag the first');
    });

    it('stacks the bands without gaps or overlap', () => {
        const pose = sprenPoses[PetMood.NeedsYou];
        const bands = sprenBandPaths(pose);

        bands.forEach((band, index) => {
            const previous = bands[index - 1];
            if (previous) {
                assert.strictEquals(
                    band.topY,
                    previous.bottomY,
                    'each band should start where the previous one ended',
                );
            }
        });
        assert.strictEquals(bands[0]?.topY, pose.bandTop);
        assert.strictEquals(bands.at(-1)?.bottomY, pose.bandBottom);
    });
});

describe(sprenStrandPaths.name, () => {
    it('starts every strand exactly where the bands end, so there is no seam', () => {
        allMoods.forEach((mood) => {
            const pose = sprenPoses[mood];
            sprenStrandPaths(pose).forEach((strand) => {
                assert.isTrue(
                    strand.path.startsWith(`M20 ${pose.bandBottom}`),
                    `${mood} strand should begin at the band's bottom edge`,
                );
            });
        });
    });

    it('gives the strands different weights and phases so they never move as one sheet', () => {
        const strands = sprenStrandPaths(sprenPoses[PetMood.Working]);

        assert.strictEquals(
            new Set(strands.map((strand) => strand.delaySeconds)).size,
            strands.length,
            'every strand should have its own phase',
        );
        assert.strictEquals(
            new Set(strands.map((strand) => strand.strokeWidth)).size,
            strands.length,
            'every strand should have its own weight',
        );
    });

    it('keeps every strand inside the view box', () => {
        allMoods.forEach((mood) => {
            const pose = sprenPoses[mood];
            assert.isBelow(
                sprenStrandEndY(pose),
                petBoxHeight,
                `${mood} strands should not run past the bottom of the box`,
            );
            sprenStrandPaths(pose).forEach((strand) => {
                pathCoordinates(strand.path).forEach((value) => {
                    assert.isAbove(value, 0, `${mood} strand escaped the view box`);
                    assert.isBelow(value, petBoxHeight, `${mood} strand escaped the view box`);
                });
            });
        });
    });
});
