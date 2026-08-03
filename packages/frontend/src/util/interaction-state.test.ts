import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {moveTabGroup, sanitizeTabOrder, shouldSurfaceAttention} from './interaction-state.js';

describe(shouldSurfaceAttention.name, () => {
    it('suppresses attention only while that AI pane is visibly focused', () => {
        assert.deepEquals(
            [
                {
                    sameFolder: true,
                    sameSession: true,
                    aiPaneVisible: true,
                    pageVisible: true,
                    pageFocused: true,
                },
                {
                    sameFolder: false,
                    sameSession: true,
                    aiPaneVisible: true,
                    pageVisible: true,
                    pageFocused: true,
                },
                {
                    sameFolder: true,
                    sameSession: true,
                    aiPaneVisible: false,
                    pageVisible: true,
                    pageFocused: true,
                },
                {
                    sameFolder: true,
                    sameSession: true,
                    aiPaneVisible: true,
                    pageVisible: false,
                    pageFocused: false,
                },
                {
                    sameFolder: true,
                    sameSession: false,
                    aiPaneVisible: true,
                    pageVisible: true,
                    pageFocused: true,
                },
            ].map(shouldSurfaceAttention),
            [
                false,
                true,
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
                    'github',
                ]),
                sanitizeTabOrder('invalid'),
            ],
            [
                [
                    'ai',
                    'shell',
                    'diff',
                    'github',
                ],
                [
                    'ai',
                    'shell',
                    'diff',
                    'github',
                ],
                [
                    'ai',
                    'shell',
                    'diff',
                    'github',
                ],
            ],
        );
    });

    it('moves individual and grouped tabs before or after a target', () => {
        const order = [
            'ai',
            'shell',
            'diff',
            'github',
        ] as const;
        assert.deepEquals(
            [
                moveTabGroup({
                    order,
                    draggedTabs: ['github'],
                    targetTabs: ['ai'],
                    position: 'before',
                }),
                moveTabGroup({
                    order,
                    draggedTabs: [
                        'ai',
                        'shell',
                    ],
                    targetTabs: ['diff'],
                    position: 'after',
                }),
            ],
            [
                [
                    'github',
                    'ai',
                    'shell',
                    'diff',
                ],
                [
                    'diff',
                    'ai',
                    'shell',
                    'github',
                ],
            ],
        );
    });
});
