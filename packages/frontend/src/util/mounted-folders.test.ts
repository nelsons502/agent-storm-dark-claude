import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {admitMountedFolder, maxMountedFolders} from './mounted-folders.js';

describe(admitMountedFolder.name, () => {
    it('appends a folder that was not mounted', () => {
        assert.deepEquals(
            admitMountedFolder({
                openedFolders: ['/a'],
                folder: '/b',
                activeFolder: '/b',
                limit: 4,
            }),
            [
                '/a',
                '/b',
            ],
        );
    });

    it('reports no change when re-admitting the newest folder', () => {
        assert.isUndefined(
            admitMountedFolder({
                openedFolders: [
                    '/a',
                    '/b',
                ],
                folder: '/b',
                activeFolder: '/b',
                limit: 4,
            }),
        );
    });

    it('moves an already-mounted folder to most-recently-used', () => {
        assert.deepEquals(
            admitMountedFolder({
                openedFolders: [
                    '/a',
                    '/b',
                    '/c',
                ],
                folder: '/a',
                activeFolder: '/a',
                limit: 4,
            }),
            [
                '/b',
                '/c',
                '/a',
            ],
        );
    });

    it('evicts the least-recently-used folder past the limit', () => {
        assert.deepEquals(
            admitMountedFolder({
                openedFolders: [
                    '/a',
                    '/b',
                ],
                folder: '/c',
                activeFolder: '/c',
                limit: 2,
            }),
            [
                '/b',
                '/c',
            ],
        );
    });

    it('evicts more than one when the list starts over the limit', () => {
        assert.deepEquals(
            admitMountedFolder({
                openedFolders: [
                    '/a',
                    '/b',
                    '/c',
                    '/d',
                ],
                folder: '/e',
                activeFolder: '/e',
                limit: 2,
            }),
            [
                '/d',
                '/e',
            ],
        );
    });

    it('never evicts the active folder', () => {
        /**
         * The active folder is the pane on screen. Evicting it would dispose the terminal the user
         * is looking at, so it is retained even when it is the least-recently-admitted entry.
         */
        const next = admitMountedFolder({
            openedFolders: [
                '/active',
                '/b',
                '/c',
            ],
            folder: '/d',
            activeFolder: '/active',
            limit: 2,
        });
        assert.isDefined(next);
        assert.isTrue(next.includes('/active'));
        assert.isTrue(next.includes('/d'));
    });

    it('keeps the admitted folder even at a limit of one', () => {
        assert.deepEquals(
            admitMountedFolder({
                openedFolders: [
                    '/a',
                    '/b',
                ],
                folder: '/c',
                activeFolder: undefined,
                limit: 1,
            }),
            ['/c'],
        );
    });

    it('treats a limit below one as one rather than emptying the list', () => {
        assert.deepEquals(
            admitMountedFolder({
                openedFolders: ['/a'],
                folder: '/b',
                activeFolder: undefined,
                limit: 0,
            }),
            ['/b'],
        );
    });

    it('bounds growth to the default limit over many folders', () => {
        const result = Array.from({
            length: 50,
        }).reduce<string[]>((openedFolders, _unused, index) => {
            const folder = `/folder-${index}`;
            return (
                admitMountedFolder({
                    openedFolders,
                    folder,
                    activeFolder: folder,
                }) ?? openedFolders
            );
        }, []);
        assert.strictEquals(result.length, maxMountedFolders);
        /** The survivors are the most recent ones, oldest-first. */
        assert.strictEquals(result[result.length - 1], '/folder-49');
    });
});
