import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {parseUrl} from 'url-vir';

describe('router search sanitization', () => {
    it('accepts native tabs, removes code, and sanitizes session indexes', async () => {
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: parseUrl('http://localhost/'),
        });
        Object.defineProperties(globalThis, {
            addEventListener: {
                configurable: true,
                value: () => undefined,
            },
            removeEventListener: {
                configurable: true,
                value: () => undefined,
            },
        });
        const {router} = await import('./router.js');
        assert.deepEquals(
            [
                router.sanitizeRoute({
                    paths: ['repo'],
                    search: {
                        tab: ['diff'],
                        aiSession: ['2'],
                        shellSession: ['0'],
                    },
                    hash: undefined,
                }).search,
                router.sanitizeRoute({
                    paths: ['repo'],
                    search: {
                        tab: ['github'],
                        aiSession: ['1.5'],
                        shellSession: ['3'],
                    },
                    hash: undefined,
                }).search,
                router.sanitizeRoute({
                    paths: ['repo'],
                    search: {
                        tab: ['code'],
                    },
                    hash: undefined,
                }).search,
            ],
            [
                {
                    tab: ['diff'],
                    aiSession: ['2'],
                },
                {
                    tab: ['github'],
                    shellSession: ['3'],
                },
                undefined,
            ],
        );
    });
});
