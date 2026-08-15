import {type AgentProfile, type SessionMeta} from '@agent-storm/common';

export type AgentProfileDraft = Readonly<
    Pick<AgentProfile, 'name' | 'launchCommand' | 'newSessionCommand'>
>;

export function validateAgentProfileDraft({
    draft,
    profiles,
    editingProfileId,
}: Readonly<{
    draft: AgentProfileDraft;
    profiles: ReadonlyArray<AgentProfile>;
    editingProfileId?: string | undefined;
}>): string {
    const name = draft.name.trim();
    if (!name) {
        return 'Profile name is required.';
    } else if (!draft.launchCommand.trim()) {
        return 'Launch command is required.';
    } else if (
        profiles.some(
            (profile) =>
                profile.id !== editingProfileId &&
                profile.name.trim().toLowerCase() === name.toLowerCase(),
        )
    ) {
        return 'Profile names must be unique.';
    } else {
        return '';
    }
}

export function resolveAgentProfileForPresentation({
    profiles,
    inheritedProfileId,
    explicitProfileId,
}: Readonly<{
    profiles: ReadonlyArray<AgentProfile>;
    inheritedProfileId: string;
    explicitProfileId?: string | undefined;
}>): AgentProfile {
    const explicit = explicitProfileId
        ? profiles.find((profile) => profile.id === explicitProfileId)
        : undefined;
    const inherited = profiles.find((profile) => profile.id === inheritedProfileId);
    const resolved = explicit || inherited || profiles[0];
    if (!resolved) {
        throw new Error('At least one agent profile is required.');
    }
    return resolved;
}

export function buildAgentProfilePickerOptions({
    profiles,
    inheritedProfileId,
    inheritLabel,
}: Readonly<{
    profiles: ReadonlyArray<AgentProfile>;
    inheritedProfileId: string;
    inheritLabel: string;
}>): ReadonlyArray<{value: string; label: string}> {
    const inheritedProfile = resolveAgentProfileForPresentation({
        profiles,
        inheritedProfileId,
    });
    return [
        {
            value: '',
            label: `${inheritLabel} - ${inheritedProfile.name}`,
        },
        ...profiles.map((profile) => {
            return {
                value: profile.id,
                label: profile.name,
            };
        }),
    ];
}

export function getSessionAgentProfilePresentation({
    session,
    index,
    profiles,
    inheritedProfileId,
}: Readonly<{
    session: SessionMeta;
    index: number;
    profiles: ReadonlyArray<AgentProfile>;
    inheritedProfileId: string;
}>): {sessionLabel: string; profileName: string; isExplicit: boolean} {
    const explicitProfile = session.agentProfileId
        ? profiles.find((profile) => profile.id === session.agentProfileId)
        : undefined;
    const profile = resolveAgentProfileForPresentation({
        profiles,
        inheritedProfileId,
        explicitProfileId: session.agentProfileId,
    });
    return {
        sessionLabel: session.name || String(index + 1),
        profileName: profile.name,
        isExplicit: !!explicitProfile,
    };
}
