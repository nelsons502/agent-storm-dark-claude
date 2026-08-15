import {defaultConfig, type AgentProfile, type Config} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {resolveAgentProfile, resolveAgentProfileCommand} from './agent-profile.js';

const profiles = [
    {
        id: 'recovery',
        name: 'Recovery',
        launchCommand: 'recovery launch',
        newSessionCommand: '',
    },
    {
        id: 'global',
        name: 'Global',
        launchCommand: 'global launch',
        newSessionCommand: 'global fresh',
    },
    {
        id: 'repo',
        name: 'Repo',
        launchCommand: 'repo launch',
        newSessionCommand: 'repo fresh',
    },
    {
        id: 'folder',
        name: 'Folder',
        launchCommand: 'folder launch',
        newSessionCommand: '',
    },
    {
        id: 'session',
        name: 'Session',
        launchCommand: 'session launch',
        newSessionCommand: 'session fresh',
    },
] as const satisfies ReadonlyArray<AgentProfile>;

const config: Config = {
    ...defaultConfig,
    agentProfiles: [...profiles],
    defaultAgentProfileId: 'global',
    folderAgentProfileIds: [
        {
            folder: '/tmp/repo',
            agentProfileId: 'repo',
        },
        {
            folder: '/tmp/repo/folder',
            agentProfileId: 'folder',
        },
    ],
};

describe(resolveAgentProfile.name, () => {
    it('resolves session then folder then repo then global profile', () => {
        const resolveId = (
            params: Omit<Parameters<typeof resolveAgentProfile>[0], 'config'>,
        ): string => {
            return resolveAgentProfile({
                config,
                ...params,
            }).id;
        };

        assert.deepEquals(
            {
                session: resolveId({
                    folder: '/tmp/repo/folder',
                    parentRepoPath: '/tmp/repo',
                    sessionAgentProfileId: 'session',
                }),
                folder: resolveId({
                    folder: '/tmp/repo/folder/',
                    parentRepoPath: '/tmp/repo',
                }),
                repo: resolveId({
                    folder: '/tmp/repo/other',
                    parentRepoPath: '/tmp/repo/',
                }),
                global: resolveId({
                    folder: '/tmp/standalone',
                }),
                pinnedToInheritedValue: resolveId({
                    folder: '/tmp/repo/other',
                    parentRepoPath: '/tmp/repo',
                    sessionAgentProfileId: 'repo',
                }),
            },
            {
                session: 'session',
                folder: 'folder',
                repo: 'repo',
                global: 'global',
                pinnedToInheritedValue: 'repo',
            },
        );
    });

    it('skips dangling ids and falls back to the first profile', () => {
        const corruptConfig: Config = {
            ...config,
            defaultAgentProfileId: 'deleted-default',
            folderAgentProfileIds: [
                {
                    folder: '/tmp/repo',
                    agentProfileId: 'deleted-repo',
                },
                {
                    folder: '/tmp/repo/folder',
                    agentProfileId: 'deleted-folder',
                },
            ],
        };

        assert.strictEquals(
            resolveAgentProfile({
                config: corruptConfig,
                folder: '/tmp/repo/folder',
                parentRepoPath: '/tmp/repo',
                sessionAgentProfileId: 'deleted-session',
            }).id,
            'recovery',
        );
    });
});

describe(resolveAgentProfileCommand.name, () => {
    it('uses the new-session command only for a requested fresh launch', () => {
        const resolveCommand = (sessionAgentProfileId: string, fresh: boolean): string => {
            return resolveAgentProfileCommand({
                config,
                folder: '/tmp/repo/folder',
                parentRepoPath: '/tmp/repo',
                sessionAgentProfileId,
                fresh,
            }).command;
        };

        assert.deepEquals(
            {
                ordinary: resolveCommand('session', false),
                fresh: resolveCommand('session', true),
                blankFreshFallback: resolveCommand('folder', true),
            },
            {
                ordinary: 'session launch',
                fresh: 'session fresh',
                blankFreshFallback: 'folder launch',
            },
        );
    });
});
