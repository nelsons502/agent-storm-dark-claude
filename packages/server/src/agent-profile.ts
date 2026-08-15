import {type AgentProfile, type Config} from '@agent-storm/common';
import {normalizePath} from './paths.js';

export type AgentProfileResolutionParams = Readonly<{
    config: Config;
    folder: string;
    parentRepoPath?: string | undefined;
    sessionAgentProfileId?: string | undefined;
}>;

export function resolveAgentProfile({
    config,
    folder,
    parentRepoPath,
    sessionAgentProfileId,
}: AgentProfileResolutionParams): AgentProfile {
    const profileById = new Map(
        config.agentProfiles.map((profile) => [
            profile.id,
            profile,
        ]),
    );
    const folderIds = new Map(
        config.folderAgentProfileIds.map((entry) => [
            normalizePath(entry.folder),
            entry.agentProfileId,
        ]),
    );
    const candidateIds = [
        sessionAgentProfileId?.trim(),
        folderIds.get(normalizePath(folder)),
        parentRepoPath ? folderIds.get(normalizePath(parentRepoPath)) : undefined,
        config.defaultAgentProfileId,
    ];
    for (const candidateId of candidateIds) {
        const profile = candidateId ? profileById.get(candidateId) : undefined;
        if (profile) {
            return profile;
        }
    }
    const firstProfile = config.agentProfiles[0];
    if (!firstProfile) {
        throw new Error('At least one agent profile is required.');
    }
    return firstProfile;
}

export function resolveAgentProfileCommand(
    params: AgentProfileResolutionParams & Readonly<{fresh: boolean}>,
): {profile: AgentProfile; command: string} {
    const profile = resolveAgentProfile(params);
    return {
        profile,
        command:
            params.fresh && profile.newSessionCommand
                ? profile.newSessionCommand
                : profile.launchCommand,
    };
}
