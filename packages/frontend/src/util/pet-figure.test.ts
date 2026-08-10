import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    buildRibbonPath,
    ribbonCount,
    ribbonEndPoint,
    ribbonLength,
    ribbonTopY,
} from './pet-figure.js';

const calmDrape = {
    spread: 0,
    curl: 0,
} as const;

const everyIndex = Array.from(
    {
        length: ribbonCount,
    },
    (_unused, index) => index,
);
const middleIndex = Math.floor(ribbonCount / 2);

describe(ribbonLength.name, () => {
    it('gives the strips ragged lengths so the cloak never reads as an even fringe', () => {
        const neighborGaps = everyIndex
            .slice(1)
            .map((index) => Math.abs(ribbonLength(index) - ribbonLength(index - 1)));

        assert.isTrue(
            neighborGaps.every((gap) => gap > 0.2),
            `every adjacent pair should differ in length, got gaps ${neighborGaps.join(', ')}`,
        );
    });

    it('hangs shortest over the spine so the figure inside the cloak stays visible', () => {
        assert.isBelow(ribbonLength(middleIndex), ribbonLength(0));
        assert.isBelow(ribbonLength(middleIndex), ribbonLength(ribbonCount - 1));
    });
});

describe(ribbonTopY.name, () => {
    it('hangs the outer strips from higher on the shoulder than the center ones', () => {
        assert.isBelow(ribbonTopY(0), ribbonTopY(middleIndex));
    });
});

describe(ribbonEndPoint.name, () => {
    it('fans the outer strips away from the center as spread grows', () => {
        assert.isAbove(
            ribbonEndPoint({
                index: ribbonCount - 1,
                spread: 8,
                curl: 0,
            }).x,
            ribbonEndPoint({
                index: ribbonCount - 1,
                ...calmDrape,
            }).x,
        );
        assert.isBelow(
            ribbonEndPoint({
                index: 0,
                spread: 8,
                curl: 0,
            }).x,
            ribbonEndPoint({
                index: 0,
                ...calmDrape,
            }).x,
        );
    });

    it('streams every strip the same direction under curl, mimicking wind', () => {
        const streamed = everyIndex.map(
            (index) =>
                ribbonEndPoint({
                    index,
                    spread: 0,
                    curl: 6,
                }).x >
                ribbonEndPoint({
                    index,
                    ...calmDrape,
                }).x,
        );

        assert.isTrue(streamed.every(Boolean), 'curl should push every strip the same way');
    });
});

describe(buildRibbonPath.name, () => {
    it('emits a quadratic path anchored at the mantle', () => {
        const path = buildRibbonPath({
            index: 0,
            ...calmDrape,
        });

        assert.isTrue(path.startsWith('M'), `expected a moveto, got ${path}`);
        assert.isTrue(path.includes('Q'), `expected a quadratic curve, got ${path}`);
    });

    it('never emits NaN for any strip in any pose', () => {
        const paths = [
            calmDrape,
            {
                spread: 8,
                curl: 2,
            },
            {
                spread: 3,
                curl: 7,
            },
        ].flatMap((pose) =>
            everyIndex.map((index) =>
                buildRibbonPath({
                    index,
                    ...pose,
                }),
            ),
        );

        assert.isFalse(paths.some((path) => path.includes('NaN')));
    });
});
