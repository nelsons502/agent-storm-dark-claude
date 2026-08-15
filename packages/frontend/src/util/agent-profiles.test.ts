import {type AgentProfile, type SessionMeta} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    buildAgentProfilePickerOptions,
    getSessionAgentProfilePresentation,
    validateAgentProfileDraft,
} from './agent-profiles.js';

const profiles: AgentProfile[] = [
    {
        id: 'claude',
        name: 'Claude Code - Opus',
        launchCommand: 'claude launch',
        newSessionCommand: 'claude fresh',
    },
    {
        id: 'opencode',
        name: 'OpenCode - GPT',
        launchCommand: 'opencode launch',
        newSessionCommand: '',
    },
];

describe(validateAgentProfileDraft.name, () => {
    it('validates trimmed unique profile drafts', () => {
        const validate = (
            draft: Parameters<typeof validateAgentProfileDraft>[0]['draft'],
            editingProfileId?: string,
        ): string => {
            return validateAgentProfileDraft({
                draft,
                profiles,
                editingProfileId,
            });
        };

        assert.deepEquals(
            {
                blankName: validate({
                    name: '   ',
                    launchCommand: 'cursor-agent',
                    newSessionCommand: '',
                }),
                blankLaunch: validate({
                    name: 'Cursor Agent - Grok',
                    launchCommand: '   ',
                    newSessionCommand: '',
                }),
                duplicateName: validate({
                    name: '  opencode - gpt  ',
                    launchCommand: 'different command',
                    newSessionCommand: '',
                }),
                editingSameName: validate(
                    {
                        name: ' OpenCode - GPT ',
                        launchCommand: 'opencode launch',
                        newSessionCommand: '',
                    },
                    'opencode',
                ),
                validVariant: validate({
                    name: 'OpenCode - GPT - review',
                    launchCommand: 'opencode review',
                    newSessionCommand: 'opencode fresh review',
                }),
            },
            {
                blankName: 'Profile name is required.',
                blankLaunch: 'Launch command is required.',
                duplicateName: 'Profile names must be unique.',
                editingSameName: '',
                validVariant: '',
            },
        );
    });
});

describe(buildAgentProfilePickerOptions.name, () => {
    it('builds inheritance and explicit picker options with the effective profile named', () => {
        assert.deepEquals(
            buildAgentProfilePickerOptions({
                profiles,
                inheritedProfileId: 'opencode',
                inheritLabel: 'Inherit folder default',
            }),
            [
                {
                    value: '',
                    label: 'Inherit folder default - OpenCode - GPT',
                },
                {
                    value: 'claude',
                    label: 'Claude Code - Opus',
                },
                {
                    value: 'opencode',
                    label: 'OpenCode - GPT',
                },
            ],
        );
    });
});

describe(getSessionAgentProfilePresentation.name, () => {
    it('presents dangling session ids as inherited and labels tabs with configured profiles', () => {
        const sessions: SessionMeta[] = [
            {
                id: 'numbered',
                name: '',
                agentProfileId: 'claude',
                newSessionPending: false,
            },
            {
                id: 'named',
                name: 'review',
                agentProfileId: 'deleted-profile',
                newSessionPending: false,
            },
        ];

        assert.deepEquals(
            sessions.map((session, index) =>
                getSessionAgentProfilePresentation({
                    session,
                    index,
                    profiles,
                    inheritedProfileId: 'opencode',
                }),
            ),
            [
                {
                    sessionLabel: '1',
                    profileName: 'Claude Code - Opus',
                    isExplicit: true,
                },
                {
                    sessionLabel: 'review',
                    profileName: 'OpenCode - GPT',
                    isExplicit: false,
                },
            ],
        );
    });
});
