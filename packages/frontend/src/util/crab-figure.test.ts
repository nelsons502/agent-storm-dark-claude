// cspell:words honorspren, spren, Stormlight

import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    buildClawPath,
    buildEyestalkPath,
    crabEyeCenter,
    crabLegPaths,
    crabPoses,
    petViewBox,
    type CrabSide,
} from './crab-figure.js';
import {PetMood} from './pet-mood.js';

const allMoods: ReadonlyArray<PetMood> = [
    PetMood.NeedsYou,
    PetMood.Working,
    PetMood.Resting,
    PetMood.Asleep,
];

/** Every number the geometry emits has to land inside the 40x48 box the pet renders into. */
function pathCoordinates(path: string): number[] {
    return (path.match(/-?\d+(\.\d+)?/g) || []).map(Number);
}

describe('crabPoses', () => {
    it('covers every mood', () => {
        assert.deepEquals(Object.keys(crabPoses).toSorted(), [...allMoods].toSorted());
    });

    it('retracts the eyestalks monotonically as the crab winds down', () => {
        const lengths = allMoods.map((mood) => crabPoses[mood].stalkLength);

        assert.deepEquals(
            lengths.toSorted((a, b) => b - a),
            lengths,
            'eyestalk length should fall from NeedsYou through Asleep',
        );
    });

    it('lowers the claws monotonically as the crab winds down', () => {
        /** SVG y grows downward, so "lower" means a larger number. */
        const clawYs = allMoods.map((mood) => crabPoses[mood].clawY);

        assert.deepEquals(
            clawYs.toSorted((a, b) => a - b),
            clawYs,
            'claws should fall from raised through tucked',
        );
    });

    it('only closes the eyes when asleep', () => {
        assert.deepEquals(
            allMoods.map((mood) => crabPoses[mood].eyesOpen),
            [
                true,
                true,
                true,
                false,
            ],
        );
    });

    it('raises the claws clear of the shell when it needs you, and tucks them behind it asleep', () => {
        const alert = crabPoses[PetMood.NeedsYou];
        const asleep = crabPoses[PetMood.Asleep];

        assert.isBelow(
            alert.clawY,
            alert.shellCy - alert.shellRy,
            'raised claws should sit above the top of the shell',
        );
        assert.isAbove(
            asleep.clawY,
            asleep.shellCy - asleep.shellRy,
            'tucked claws should sit within the shell, not above it',
        );
    });
});

describe(buildEyestalkPath.name, () => {
    it('mirrors the two stalks about the center line', () => {
        const pose = crabPoses[PetMood.Working];
        const left = crabEyeCenter({
            side: -1,
            pose,
        });
        const right = crabEyeCenter({
            side: 1,
            pose,
        });

        assert.strictEquals(
            Math.round((left.x + right.x) * 100) / 100,
            petViewBox.centerX * 2,
            'mirrored eye centers should average to the center line',
        );
        assert.strictEquals(left.y, right.y);
    });

    it('puts the eye above the shell for every mood but asleep', () => {
        allMoods.forEach((mood) => {
            const pose = crabPoses[mood];
            const eye = crabEyeCenter({
                side: 1,
                pose,
            });
            const shellTop = pose.shellCy - pose.shellRy;
            if (mood === PetMood.Asleep) {
                assert.isAbove(eye.y, shellTop - 2, `${mood} eyes should have sunk to the shell`);
            } else {
                assert.isBelow(eye.y, shellTop, `${mood} eyes should clear the shell`);
            }
        });
    });

    it('stays inside the view box', () => {
        allMoods.forEach((mood) => {
            const sides: ReadonlyArray<CrabSide> = [
                -1,
                1,
            ];
            sides.forEach((side) => {
                pathCoordinates(
                    buildEyestalkPath({
                        side,
                        pose: crabPoses[mood],
                    }),
                ).forEach((value) => {
                    assert.isAbove(value, -1, `${mood} eyestalk coordinate escaped the view box`);
                    assert.isBelow(
                        value,
                        petViewBox.height,
                        `${mood} eyestalk coordinate escaped the view box`,
                    );
                });
            });
        });
    });
});

describe(buildClawPath.name, () => {
    it('closes the shape so it can be filled', () => {
        const path = buildClawPath({
            side: 1,
            pose: crabPoses[PetMood.NeedsYou],
        });

        assert.isTrue(path.startsWith('M'), 'claw path should start with a move');
        assert.isTrue(path.endsWith('Z'), 'claw path should close');
    });

    it('mirrors left and right claws about the center line', () => {
        const pose = crabPoses[PetMood.NeedsYou];
        const left = pathCoordinates(
            buildClawPath({
                side: -1,
                pose,
            }),
        );
        const right = pathCoordinates(
            buildClawPath({
                side: 1,
                pose,
            }),
        );
        /** Every x pair should straddle the center line by the same distance. */
        const xPairs = left
            .filter((_unused, index) => index % 2 === 0)
            .map((leftX, index) => leftX + (right[index * 2] ?? 0));

        xPairs.forEach((sum) => {
            assert.strictEquals(
                Math.round(sum * 100) / 100,
                petViewBox.centerX * 2,
                'mirrored claw x coordinates should average to the center line',
            );
        });
    });
});

describe('crabLegPaths', () => {
    it('gives the crab the same number of legs on each side', () => {
        const paths = crabLegPaths(crabPoses[PetMood.Working]);

        assert.strictEquals(paths.length % 2, 0, 'legs should come in mirrored pairs');
        assert.isAbove(paths.length, 0);
    });
});
