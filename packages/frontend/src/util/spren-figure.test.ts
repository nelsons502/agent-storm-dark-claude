// cspell:words honorspren, spren, Stormlight

import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {PetMood} from './pet-mood.js';
import {
    buildSprenRibbonPath,
    sprenCoilArcs,
    sprenHeadPoint,
    sprenPoses,
    sprenRibbonSamples,
} from './spren-figure.js';

const allMoods: ReadonlyArray<PetMood> = [
    PetMood.NeedsYou,
    PetMood.Working,
    PetMood.Resting,
    PetMood.Asleep,
];

describe('sprenPoses', () => {
    it('covers every mood', () => {
        assert.deepEquals(Object.keys(sprenPoses).toSorted(), [...allMoods].toSorted());
    });

    it('dims the head glow monotonically as the spren winds down', () => {
        const glows = allMoods.map((mood) => sprenPoses[mood].glow);

        assert.deepEquals(
            glows.toSorted((a, b) => b - a),
            glows,
            'glow should fall from NeedsYou through Asleep',
        );
    });

    /**
     * The plan flagged this as the open question for a bodiless ribbon: there is no posture to
     * slump. The answer is that the ribbon coils tight and sinks — many turns, almost no width,
     * head dropped near the floor — which is why these two assertions are the interesting ones.
     */
    it('coils the asleep pose tighter and narrower than any waking pose', () => {
        const asleep = sprenPoses[PetMood.Asleep];

        allMoods
            .filter((mood) => mood !== PetMood.Asleep)
            .forEach((mood) => {
                assert.isAbove(
                    asleep.coils,
                    sprenPoses[mood].coils,
                    `asleep should coil tighter than ${mood}`,
                );
                assert.isBelow(
                    asleep.amplitude,
                    sprenPoses[mood].amplitude,
                    `asleep should be narrower than ${mood}`,
                );
            });
    });

    it('sinks the asleep head far below every waking head', () => {
        const asleep = sprenHeadPoint(sprenPoses[PetMood.Asleep]);

        allMoods
            .filter((mood) => mood !== PetMood.Asleep)
            .forEach((mood) => {
                assert.isAbove(
                    asleep.y,
                    sprenHeadPoint(sprenPoses[mood]).y + 10,
                    `asleep head should sit well below the ${mood} head`,
                );
            });
    });
});

describe(buildSprenRibbonPath.name, () => {
    it('starts at the head point so the bright end and the ribbon never separate', () => {
        allMoods.forEach((mood) => {
            const pose = sprenPoses[mood];
            const head = sprenHeadPoint(pose);
            assert.isTrue(
                buildSprenRibbonPath(pose).startsWith(`M${head.x} ${head.y}`),
                `${mood} ribbon should begin at its head point`,
            );
        });
    });

    it('stays inside the view box for every mood', () => {
        allMoods.forEach((mood) => {
            sprenRibbonSamples(sprenPoses[mood]).forEach((point) => {
                assert.isAbove(point.x, 0, `${mood} ribbon escaped the view box`);
                assert.isBelow(point.x, 40, `${mood} ribbon escaped the view box`);
                assert.isAbove(point.y, 0, `${mood} ribbon escaped the view box`);
                assert.isBelow(point.y, 48, `${mood} ribbon escaped the view box`);
            });
        });
    });

    it('descends without ever doubling back upward', () => {
        allMoods.forEach((mood) => {
            const samples = sprenRibbonSamples(sprenPoses[mood]);
            samples.forEach((point, index) => {
                const previous = samples[index - 1];
                if (previous) {
                    assert.isAbove(point.y, previous.y, `${mood} ribbon should fall monotonically`);
                }
            });
        });
    });
});

/**
 * A single wavy line reads as a tadpole rather than a descending ribbon. What supplies the depth is
 * drawing the coil's near half-turns bright and its far half-turns dim, so these tests pin the
 * near/far split — it is the reason this geometry exists at all.
 */
describe(sprenCoilArcs.name, () => {
    it('alternates near and far half-turns', () => {
        const {near, far} = sprenCoilArcs(sprenPoses[PetMood.Working]);

        assert.isAbove(near.length, 0);
        assert.isAbove(far.length, 0);
        assert.isBelow(
            Math.abs(near.length - far.length),
            2,
            'near and far turns should interleave, so their counts differ by at most one',
        );
    });

    it('gives the tightly-coiled asleep pose more half-turns than any waking pose', () => {
        const asleepTurns = countTurns(PetMood.Asleep);

        allMoods
            .filter((mood) => mood !== PetMood.Asleep)
            .forEach((mood) => {
                assert.isAbove(
                    asleepTurns,
                    countTurns(mood),
                    `asleep should coil more than ${mood}`,
                );
            });
    });

    it('emits arcs, not straight lines — a coil drawn with lines reads as a zigzag', () => {
        allMoods.forEach((mood) => {
            const {near, far} = sprenCoilArcs(sprenPoses[mood]);
            [
                ...near,
                ...far,
            ].forEach((arc) => {
                assert.isTrue(arc.startsWith('M'), `${mood} arc should start with a move`);
                assert.isTrue(arc.includes('A'), `${mood} arc should be an elliptical arc`);
            });
        });
    });

    it('stays inside the view box for every mood', () => {
        allMoods.forEach((mood) => {
            const {near, far} = sprenCoilArcs(sprenPoses[mood]);
            [
                ...near,
                ...far,
            ].forEach((arc) => {
                (arc.match(/-?\d+(\.\d+)?/g) || []).map(Number).forEach((value) => {
                    assert.isAbove(value, -1, `${mood} coil escaped the view box`);
                    assert.isBelow(value, 48, `${mood} coil escaped the view box`);
                });
            });
        });
    });
});

function countTurns(mood: PetMood): number {
    const {near, far} = sprenCoilArcs(sprenPoses[mood]);
    return near.length + far.length;
}
