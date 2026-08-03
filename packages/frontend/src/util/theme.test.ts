import {Theme} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {resolveActiveRowBackground} from './theme.js';

describe(resolveActiveRowBackground.name, () => {
    it('adds a distinct clay background only to the dark-Claude active row', () => {
        assert.deepEquals(
            [
                resolveActiveRowBackground(Theme.DarkClaude),
                resolveActiveRowBackground(Theme.Dark),
                resolveActiveRowBackground(Theme.DarkCodex),
                resolveActiveRowBackground(Theme.Light),
            ],
            [
                'rgba(217, 119, 87, 0.16)',
                undefined,
                undefined,
                undefined,
            ],
        );
    });
});
