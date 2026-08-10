import {PaneStatus} from '@agent-storm/common';

/** What the desktop pet is currently emoting, in descending order of urgency. */
export enum PetMood {
    NeedsYou = 'needs-you',
    Working = 'working',
    Resting = 'resting',
    Asleep = 'asleep',
}

export type PetMoodInputs = Readonly<{
    attentionCount: number;
    paneStatuses: ReadonlyArray<PaneStatus>;
}>;

const moodPrecedence: ReadonlyArray<
    Readonly<{mood: PetMood; matches: (inputs: PetMoodInputs) => boolean}>
> = [
    {
        mood: PetMood.NeedsYou,
        matches: ({attentionCount}) => attentionCount > 0,
    },
    {
        mood: PetMood.Working,
        matches: ({paneStatuses}) => paneStatuses.includes(PaneStatus.Busy),
    },
    {
        mood: PetMood.Resting,
        matches: ({paneStatuses}) => paneStatuses.includes(PaneStatus.Idle),
    },
];

export function derivePetMood(inputs: PetMoodInputs): PetMood {
    return moodPrecedence.find((entry) => entry.matches(inputs))?.mood || PetMood.Asleep;
}
