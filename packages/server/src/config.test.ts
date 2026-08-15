// cspell:words opencode, unparked, unparks

import {defaultConfig, Theme, type Config} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    isFolderParked,
    migrateLegacyConfig,
    normalizeAgentProfileConfig,
    setFolderParked,
} from './config.js';

type ProfileConfigFields = {
    agentProfiles: {
        id: string;
        name: string;
        launchCommand: string;
        newSessionCommand: string;
    }[];
    defaultAgentProfileId: string;
    folderAgentProfileIds: {folder: string; agentProfileId: string}[];
};

function asProfileConfig(config: Config): Config & ProfileConfigFields {
    return config as Config & ProfileConfigFields;
}

function getThrownMessage(run: () => unknown): string {
    try {
        run();
        return '';
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

describe(migrateLegacyConfig.name, () => {
    const legacyConfig = {
        aiCmd: '  claude --model opus  ',
        resetAiSessionCmd: '  claude --fresh  ',
        folderAiCmds: [
            {
                folder: '/tmp/repo/',
                aiCmd: 'claude --model opus',
            },
            {
                folder: '/tmp/repo/opencode-a',
                aiCmd: 'env NAME=value opencode --model gpt',
                resetAiSessionCmd: 'opencode --fresh',
            },
            {
                folder: '/tmp/repo/opencode-b',
                aiCmd: 'env NAME=value opencode --model gpt',
                resetAiSessionCmd: 'opencode --fresh',
            },
            {
                folder: '/tmp/repo/sonnet',
                aiCmd: 'claude --model sonnet',
            },
        ],
        repos: [
            {
                path: '/tmp/repo/',
                postWorktreeCmd: 'npm install',
            },
        ],
        mergeSteps: [
            {
                folder: '/tmp/repo/opencode-a',
                doneSteps: [],
                lastReviewedSha: 'abc123',
            },
        ],
        theme: Theme.DarkCodex,
    };

    it('migrates legacy command pairs into deduplicated named profiles', () => {
        const migrated = asProfileConfig(migrateLegacyConfig(legacyConfig));

        assert.deepEquals(
            {
                agentProfiles: migrated.agentProfiles,
                defaultAgentProfileId: migrated.defaultAgentProfileId,
                folderAgentProfileIds: migrated.folderAgentProfileIds,
                repos: migrated.repos,
                mergeSteps: migrated.mergeSteps,
                theme: migrated.theme,
            },
            {
                agentProfiles: [
                    {
                        id: 'migrated-2dc3497d2a56c866',
                        name: 'Claude',
                        launchCommand: 'claude --model opus',
                        newSessionCommand: 'claude --fresh',
                    },
                    {
                        id: 'migrated-b7ed6caaf048c77a',
                        name: 'Opencode',
                        launchCommand: 'env NAME=value opencode --model gpt',
                        newSessionCommand: 'opencode --fresh',
                    },
                    {
                        id: 'migrated-13011b45c694ee2e',
                        name: 'Claude (2)',
                        launchCommand: 'claude --model sonnet',
                        newSessionCommand: 'claude --fresh',
                    },
                ],
                defaultAgentProfileId: 'migrated-2dc3497d2a56c866',
                folderAgentProfileIds: [
                    {
                        folder: '/tmp/repo/opencode-a',
                        agentProfileId: 'migrated-b7ed6caaf048c77a',
                    },
                    {
                        folder: '/tmp/repo/opencode-b',
                        agentProfileId: 'migrated-b7ed6caaf048c77a',
                    },
                    {
                        folder: '/tmp/repo/sonnet',
                        agentProfileId: 'migrated-13011b45c694ee2e',
                    },
                ],
                repos: [
                    {
                        path: '/tmp/repo/',
                        postWorktreeCmd: 'npm install',
                    },
                ],
                mergeSteps: [
                    {
                        folder: '/tmp/repo/opencode-a',
                        doneSteps: [],
                        lastReviewedSha: 'abc123',
                    },
                ],
                theme: Theme.DarkCodex,
            },
        );
    });

    it('returns identical migrated profile ids across repeated migration calls', () => {
        const first = asProfileConfig(migrateLegacyConfig(legacyConfig));
        const second = asProfileConfig(migrateLegacyConfig(legacyConfig));

        assert.deepEquals(
            first.agentProfiles.map((profile) => profile.id),
            second.agentProfiles.map((profile) => profile.id),
        );
        assert.deepEquals(
            first.agentProfiles.map((profile) => profile.id),
            [
                'migrated-2dc3497d2a56c866',
                'migrated-b7ed6caaf048c77a',
                'migrated-13011b45c694ee2e',
            ],
        );
    });
});

describe(normalizeAgentProfileConfig.name, () => {
    const profileConfig = asProfileConfig({
        ...defaultConfig,
        agentProfiles: [
            {
                id: 'first',
                name: 'First',
                launchCommand: 'first',
                newSessionCommand: '',
            },
            {
                id: 'second',
                name: 'Second',
                launchCommand: 'second',
                newSessionCommand: 'second --fresh',
            },
        ],
        defaultAgentProfileId: 'missing',
        folderAgentProfileIds: [
            {
                folder: '/tmp/valid/',
                agentProfileId: 'second',
            },
            {
                folder: '/tmp/missing',
                agentProfileId: 'deleted',
            },
        ],
    } as Config);

    it('normalizes missing profile references without affecting valid overrides', () => {
        const normalized = asProfileConfig(normalizeAgentProfileConfig(profileConfig));

        assert.deepEquals(
            {
                defaultAgentProfileId: normalized.defaultAgentProfileId,
                folderAgentProfileIds: normalized.folderAgentProfileIds,
            },
            {
                defaultAgentProfileId: 'first',
                folderAgentProfileIds: [
                    {
                        folder: '/tmp/valid',
                        agentProfileId: 'second',
                    },
                ],
            },
        );
    });

    it('rejects blank commands, blank names, duplicate ids, and case-insensitive duplicate names', () => {
        const withProfiles = (profiles: ProfileConfigFields['agentProfiles']): Config => {
            return {
                ...profileConfig,
                agentProfiles: profiles,
            } as Config;
        };

        assert.deepEquals(
            [
                getThrownMessage(() =>
                    normalizeAgentProfileConfig(
                        withProfiles([
                            {
                                id: 'one',
                                name: '   ',
                                launchCommand: 'one',
                                newSessionCommand: '',
                            },
                        ]),
                    ),
                ),
                getThrownMessage(() =>
                    normalizeAgentProfileConfig(
                        withProfiles([
                            {
                                id: 'one',
                                name: 'One',
                                launchCommand: '   ',
                                newSessionCommand: '',
                            },
                        ]),
                    ),
                ),
                getThrownMessage(() =>
                    normalizeAgentProfileConfig(
                        withProfiles([
                            {
                                id: 'same',
                                name: 'One',
                                launchCommand: 'one',
                                newSessionCommand: '',
                            },
                            {
                                id: 'same',
                                name: 'Two',
                                launchCommand: 'two',
                                newSessionCommand: '',
                            },
                        ]),
                    ),
                ),
                getThrownMessage(() =>
                    normalizeAgentProfileConfig(
                        withProfiles([
                            {
                                id: 'one',
                                name: 'OpenCode',
                                launchCommand: 'one',
                                newSessionCommand: '',
                            },
                            {
                                id: 'two',
                                name: ' opencode ',
                                launchCommand: 'two',
                                newSessionCommand: '',
                            },
                        ]),
                    ),
                ),
            ],
            [
                'Agent profile names cannot be blank.',
                'Agent profile launch commands cannot be blank.',
                'Agent profile IDs must be unique.',
                'Agent profile names must be unique case-insensitively.',
            ],
        );
    });
});

describe(setFolderParked.name, () => {
    it('parks, unparks, and normalizes paths without duplicating entries', () => {
        const parked = setFolderParked({
            config: defaultConfig,
            folder: '/tmp/project-a/',
            parked: true,
        });
        const parkedAgain = setFolderParked({
            config: parked,
            folder: '/tmp/project-a',
            parked: true,
        });
        const unparked = setFolderParked({
            config: parkedAgain,
            folder: '/tmp/project-a',
            parked: false,
        });

        assert.deepEquals(
            {
                parked: parked.parkedFolders,
                parkedAgain: parkedAgain.parkedFolders,
                unparked: unparked.parkedFolders,
                isParked: isFolderParked({
                    config: parked,
                    folder: '/tmp/project-a',
                }),
                isNotParked: isFolderParked({
                    config: unparked,
                    folder: '/tmp/project-a',
                }),
            },
            {
                parked: ['/tmp/project-a'],
                parkedAgain: ['/tmp/project-a'],
                unparked: [],
                isParked: true,
                isNotParked: false,
            },
        );
    });
});
