// cspell:words honorspren, spren, Stormlight

import {type ResolvedTheme} from './theme.js';

/**
 * Which creature the pet renders as. A pure function of the resolved theme, so no new state is
 * needed anywhere — `Theme.Auto` has already collapsed to `light` or `dark` by the time it gets
 * here.
 */
export enum PetSpecies {
    /** The original cloaked figure. Unchanged, and what the two story-less themes keep. */
    Cloaked = 'cloaked',
    /** An honorspren: a ribbon of Stormlight, for the Codex theme. */
    Spren = 'spren',
    /** A little crab, in the spirit of the Claude Code crab. */
    Crab = 'crab',
}

export function petSpeciesForTheme(theme: ResolvedTheme): PetSpecies {
    if (theme === 'dark-claude') {
        return PetSpecies.Crab;
    } else if (theme === 'dark-codex') {
        return PetSpecies.Spren;
    } else {
        /**
         * `light` and `dark` have no fiction attached to them, and inventing one so they could have
         * a species too would be scope creep. They keep the figure they have always had.
         */
        return PetSpecies.Cloaked;
    }
}
