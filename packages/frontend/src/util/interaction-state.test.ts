import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {moveTabGroup, sanitizeTabOrder, shouldSurfaceAttention} from './interaction-state.js';

describe(shouldSurfaceAttention.name, () => {
    it('suppresses attention only while that AI pane is visibly focused', () => {
        assert.deepEquals(
            [
                {
                    sameFolder: true,
                    aiPaneVisible: true,
                    pageVisible: true,
                    pageFocused: true,
                },
                {
                    sameFolder: false,
                    aiPaneVisible: true,
                    pageVisible: true,
                    pageFocused: true,
                },
                {
                    sameFolder: true,
                    aiPaneVisible: false,
                    pageVisible: true,
                    pageFocused: true,
                },
                {
                    sameFolder: true,
                    aiPaneVisible: true,
                    pageVisible: false,
                    pageFocused: false,
                },
            ].map(shouldSurfaceAttention),
            [
                false,
                true,
                true,
                true,
            ],
        );
    });
});

describe('persisted tab order', () => {
    it('accepts only a complete, unique tab order', () => {
        assert.deepEquals(
            [
                sanitizeTabOrder([
                    'code',
                    'ai',
                    'shell',
                ]),
                sanitizeTabOrder([
                    'ai',
                    'ai',
                    'code',
                ]),
                sanitizeTabOrder('invalid'),
            ],
            [
                [
                    'code',
                    'ai',
                    'shell',
                ],
                [
                    'ai',
                    'shell',
                    'code',
                ],
                [
                    'ai',
                    'shell',
                    'code',
                ],
            ],
        );
    });

    it('moves individual and grouped tabs before or after a target', () => {
        const order = [
            'ai',
            'shell',
            'code',
        ] as const;
        assert.deepEquals(
            [
                moveTabGroup(order, ['code'], ['ai'], 'before'),
                moveTabGroup(
                    order,
                    [
                        'ai',
                        'shell',
                    ],
                    ['code'],
                    'after',
                ),
            ],
            [
                [
                    'code',
                    'ai',
                    'shell',
                ],
                [
                    'code',
                    'ai',
                    'shell',
                ],
            ],
        );
    });
});
