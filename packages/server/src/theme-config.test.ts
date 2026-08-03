import {configJsonSchema, defaultConfig, Theme, type Config} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';

/**
 * `loadConfig` merges a parsed config over `defaultConfig` (`{...defaultConfig, ...parsed}`), so
 * the backward-compat behavior of the new `theme` field is entirely governed by
 * `defaultConfig.theme` plus that merge. These tests lock the contract that adding `theme` can't
 * change how older configs (written before the field existed) render: a missing value must resolve
 * to light.
 */
describe('config theme', () => {
    it('offers Dark Codex as a persisted theme choice', () => {
        assert.deepEquals(configJsonSchema.properties.theme.enum.map(String), [
            'light',
            'dark',
            'dark-claude',
            'dark-codex',
            'auto',
        ]);
    });

    it('defaults to light', () => {
        assert.strictEquals(defaultConfig.theme, Theme.Light);
    });

    it('keeps light for a legacy config missing the theme field', () => {
        // A config object as written before `theme` existed — no `theme` key at all.
        const legacy: Partial<Config> = {
            aiCmd: 'claude',
            repos: [],
        };

        const merged: Config = {
            ...defaultConfig,
            ...legacy,
        };

        assert.strictEquals(merged.theme, Theme.Light);
    });

    it('preserves an explicit theme choice over the default', () => {
        const stored: Partial<Config> = {
            theme: Theme.DarkClaude,
        };

        const merged: Config = {
            ...defaultConfig,
            ...stored,
        };

        assert.strictEquals(merged.theme, Theme.DarkClaude);
    });

    it("preserves electrovir's plain dark choice over the default", () => {
        const stored: Partial<Config> = {
            theme: Theme.Dark,
        };

        const merged: Config = {
            ...defaultConfig,
            ...stored,
        };

        assert.strictEquals(merged.theme, Theme.Dark);
    });
});
