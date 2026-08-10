import {PaneStatus} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {derivePetMood, PetMood} from './pet-mood.js';

describe(derivePetMood.name, () => {
    it('wants your attention even while panes are still churning', () => {
        assert.strictEquals(
            derivePetMood({
                attentionCount: 1,
                paneStatuses: [
                    PaneStatus.Busy,
                    PaneStatus.Idle,
                ],
            }),
            PetMood.NeedsYou,
        );
    });

    it('works while any pane is busy and nothing is waiting', () => {
        assert.strictEquals(
            derivePetMood({
                attentionCount: 0,
                paneStatuses: [
                    PaneStatus.Idle,
                    PaneStatus.Busy,
                ],
            }),
            PetMood.Working,
        );
    });

    it('rests when panes are alive but quiet', () => {
        assert.strictEquals(
            derivePetMood({
                attentionCount: 0,
                paneStatuses: [
                    PaneStatus.Idle,
                    PaneStatus.Exited,
                ],
            }),
            PetMood.Resting,
        );
    });

    it('sleeps when no pane is alive', () => {
        assert.deepEquals(
            [
                derivePetMood({
                    attentionCount: 0,
                    paneStatuses: [
                        PaneStatus.None,
                        PaneStatus.Exited,
                    ],
                }),
                derivePetMood({
                    attentionCount: 0,
                    paneStatuses: [],
                }),
            ],
            [
                PetMood.Asleep,
                PetMood.Asleep,
            ],
        );
    });
});
