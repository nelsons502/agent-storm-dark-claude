// cspell:words honorspren, spren, Stormlight

import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {PetSpecies, petSpeciesForTheme} from './pet-species.js';
import {type ResolvedTheme} from './theme.js';

describe(petSpeciesForTheme.name, () => {
    it('gives each themed look its own species and leaves the plain themes alone', () => {
        const themes: ReadonlyArray<ResolvedTheme> = [
            'light',
            'dark',
            'dark-claude',
            'dark-codex',
        ];

        assert.deepEquals(
            themes.map((theme) => petSpeciesForTheme(theme)),
            [
                PetSpecies.Cloaked,
                PetSpecies.Cloaked,
                PetSpecies.Crab,
                PetSpecies.Spren,
            ],
        );
    });
});
