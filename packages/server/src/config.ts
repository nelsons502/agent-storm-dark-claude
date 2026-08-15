// cspell:words unpark, upserts

import {
    defaultConfig,
    manualMergeStepKeys,
    MergeStepKey,
    type AgentProfile,
    type Config,
    type ManualMergeStepKey,
} from '@agent-storm/common';
import {log} from '@augment-vir/common';
import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {basename, dirname} from 'node:path';
import {configPath} from './file-paths.js';
import {normalizePath} from './paths.js';

type LegacyAgentConfig = {
    aiCmd?: string | undefined;
    resetAiSessionCmd?: string | undefined;
    folderAiCmds?:
        | ReadonlyArray<{
              folder?: string | undefined;
              aiCmd?: string | undefined;
              resetAiSessionCmd?: string | undefined;
          }>
        | undefined;
};

const legacyAgentConfigKeys = new Set([
    'aiCmd',
    'resetAiSessionCmd',
    'folderAiCmds',
]);

function profilePairKey({
    launchCommand,
    newSessionCommand,
}: Readonly<{launchCommand: string; newSessionCommand: string}>): string {
    return `${launchCommand}\0${newSessionCommand}`;
}

function createMigratedProfileId({
    launchCommand,
    newSessionCommand,
}: Readonly<{launchCommand: string; newSessionCommand: string}>): string {
    return `migrated-${createHash('sha256')
        .update(
            profilePairKey({
                launchCommand,
                newSessionCommand,
            }),
        )
        .digest('hex')
        .slice(0, 16)}`;
}

function stripShellQuotes(value: string): string {
    const first = value[0];
    return first && first === value.at(-1) && (first === '"' || first === "'")
        ? value.slice(1, -1)
        : value;
}

function profileBaseName(command: string): string {
    const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    let tokenIndex = stripShellQuotes(tokens[0] || '') === 'env' ? 1 : 0;
    while (/^[A-Za-z_]\w*=/.test(stripShellQuotes(tokens[tokenIndex] || ''))) {
        tokenIndex++;
    }
    const executable = basename(stripShellQuotes(tokens[tokenIndex] || 'agent'));
    return (
        executable
            .split(/[-_]+/)
            .filter(Boolean)
            .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
            .join(' ') || 'Agent'
    );
}

/** Convert the command-string config shape without writing it back to disk. */
export function migrateLegacyConfig(config: Readonly<Record<string, unknown>>): Config {
    const legacy = config as Readonly<Record<string, unknown> & LegacyAgentConfig>;
    const globalLaunchCommand = legacy.aiCmd?.trim() || 'claude';
    const globalNewSessionCommand = legacy.resetAiSessionCmd?.trim() || '';
    const profiles: AgentProfile[] = [];
    const profileIdsByPair = new Map<string, string>();
    const profileNameCounts = new Map<string, number>();

    const getOrCreateProfileId = ({
        launchCommand,
        newSessionCommand,
    }: Readonly<{launchCommand: string; newSessionCommand: string}>): string => {
        const pairKey = profilePairKey({
            launchCommand,
            newSessionCommand,
        });
        const existingId = profileIdsByPair.get(pairKey);
        if (existingId) {
            return existingId;
        }
        const baseName = profileBaseName(launchCommand);
        const nameCount = (profileNameCounts.get(baseName) || 0) + 1;
        profileNameCounts.set(baseName, nameCount);
        const id = createMigratedProfileId({
            launchCommand,
            newSessionCommand,
        });
        profiles.push({
            id,
            name: nameCount === 1 ? baseName : `${baseName} (${nameCount})`,
            launchCommand,
            newSessionCommand,
        });
        profileIdsByPair.set(pairKey, id);
        return id;
    };

    const defaultAgentProfileId = getOrCreateProfileId({
        launchCommand: globalLaunchCommand,
        newSessionCommand: globalNewSessionCommand,
    });
    const folderAgentProfileIds = (legacy.folderAiCmds || []).flatMap((entry) => {
        const launchCommand = entry.aiCmd?.trim() || globalLaunchCommand;
        const newSessionCommand = entry.resetAiSessionCmd?.trim() || globalNewSessionCommand;
        const agentProfileId = getOrCreateProfileId({
            launchCommand,
            newSessionCommand,
        });
        return entry.folder && agentProfileId !== defaultAgentProfileId
            ? [
                  {
                      folder: normalizePath(entry.folder),
                      agentProfileId,
                  },
              ]
            : [];
    });
    const unrelatedConfig = Object.fromEntries(
        Object.entries(config).filter(([key]) => !legacyAgentConfigKeys.has(key)),
    );

    return {
        ...unrelatedConfig,
        agentProfiles: profiles,
        defaultAgentProfileId,
        folderAgentProfileIds,
    } as Config;
}

export function normalizeAgentProfileConfig(config: Readonly<Config>): Config {
    if (!config.agentProfiles.length) {
        throw new Error('At least one agent profile is required.');
    }
    const agentProfiles = config.agentProfiles.map((profile) => {
        return {
            id: profile.id.trim(),
            name: profile.name.trim(),
            launchCommand: profile.launchCommand.trim(),
            newSessionCommand: profile.newSessionCommand.trim(),
        };
    });
    if (agentProfiles.some((profile) => !profile.id)) {
        throw new Error('Agent profile IDs cannot be blank.');
    } else if (agentProfiles.some((profile) => !profile.name)) {
        throw new Error('Agent profile names cannot be blank.');
    } else if (agentProfiles.some((profile) => !profile.launchCommand)) {
        throw new Error('Agent profile launch commands cannot be blank.');
    } else if (new Set(agentProfiles.map((profile) => profile.id)).size !== agentProfiles.length) {
        throw new Error('Agent profile IDs must be unique.');
    } else if (
        new Set(agentProfiles.map((profile) => profile.name.toLowerCase())).size !==
        agentProfiles.length
    ) {
        throw new Error('Agent profile names must be unique case-insensitively.');
    }

    const validIds = new Set(agentProfiles.map((profile) => profile.id));
    return {
        ...config,
        agentProfiles,
        defaultAgentProfileId: validIds.has(config.defaultAgentProfileId)
            ? config.defaultAgentProfileId
            : agentProfiles[0]?.id || '',
        folderAgentProfileIds: config.folderAgentProfileIds
            .map((entry) => {
                return {
                    folder: normalizePath(entry.folder),
                    agentProfileId: entry.agentProfileId.trim(),
                };
            })
            .filter((entry) => validIds.has(entry.agentProfileId)),
    };
}

function normalizeConfig(config: Readonly<Config>): Config {
    const profileConfig = normalizeAgentProfileConfig(config);
    return {
        ...profileConfig,
        repos: profileConfig.repos.map((repo) => {
            return {
                ...repo,
                path: normalizePath(repo.path),
            };
        }),
        hiddenAiPane: profileConfig.hiddenAiPane.map((path) => normalizePath(path)),
        /** De-duplicated so repeated parks of the same folder can't stack up entries. */
        parkedFolders: Array.from(
            new Set((profileConfig.parkedFolders || []).map((path) => normalizePath(path))),
        ),
        /** Entries with nothing ticked and no reviewed commit carry no information. */
        mergeSteps: profileConfig.mergeSteps
            .filter((entry) => entry.doneSteps.length || entry.lastReviewedSha)
            .map((entry) => {
                return {
                    ...entry,
                    folder: normalizePath(entry.folder),
                };
            }),
    };
}

export function getFolderMergeSteps({
    config,
    folder,
}: Readonly<{
    config: Config;
    folder: string;
}>): {doneSteps: ManualMergeStepKey[]; lastReviewedSha: string | null} {
    const entry = config.mergeSteps.find((candidate) => candidate.folder === normalizePath(folder));
    return {
        doneSteps: (entry?.doneSteps || []).filter((step) => manualMergeStepKeys.includes(step)),
        lastReviewedSha: entry?.lastReviewedSha || null,
    };
}

/**
 * Tick or untick one manual merge step for a folder. `lastReviewedSha` is recorded alongside a
 * self-review tick so the attestation can expire when the branch moves on; it is cleared when the
 * tick is removed, since a recorded commit with no tick would silently re-approve the step if the
 * user ever re-ticked it from an older client.
 */
export function setFolderMergeStep({
    config,
    folder,
    step,
    done,
    commitHash,
}: Readonly<{
    config: Config;
    folder: string;
    step: ManualMergeStepKey;
    done: boolean;
    commitHash: string | null;
}>): Config {
    const normalizedFolder = normalizePath(folder);
    const existing = config.mergeSteps.find((entry) => entry.folder === normalizedFolder);
    const doneSteps = [
        ...(existing?.doneSteps || []).filter((candidate) => candidate !== step),
        ...(done ? [step] : []),
    ];
    const lastReviewedSha =
        step === MergeStepKey.SelfReview
            ? done
                ? commitHash || ''
                : ''
            : existing?.lastReviewedSha || '';

    return normalizeConfig({
        ...config,
        mergeSteps: [
            ...config.mergeSteps.filter((entry) => entry.folder !== normalizedFolder),
            {
                folder: normalizedFolder,
                doneSteps,
                ...(lastReviewedSha
                    ? {
                          lastReviewedSha,
                      }
                    : {}),
            },
        ],
    });
}

export function isFolderParked({
    config,
    folder,
}: Readonly<{
    config: Config;
    folder: string;
}>): boolean {
    return (config.parkedFolders || []).includes(normalizePath(folder));
}

/** Park or unpark a folder for the sidebar's "Do later" section. */
export function setFolderParked({
    config,
    folder,
    parked,
}: Readonly<{
    config: Config;
    folder: string;
    parked: boolean;
}>): Config {
    const normalizedFolder = normalizePath(folder);
    const withoutFolder = (config.parkedFolders || []).filter(
        (path) => normalizePath(path) !== normalizedFolder,
    );
    return normalizeConfig({
        ...config,
        parkedFolders: parked
            ? [
                  ...withoutFolder,
                  normalizedFolder,
              ]
            : withoutFolder,
    });
}

/** Set an explicit folder profile, or clear it with an empty id to restore inheritance. */
export function setFolderAgentProfileId({
    config,
    folder,
    agentProfileId,
}: Readonly<{
    config: Config;
    folder: string;
    agentProfileId: string;
}>): Config {
    const normalizedFolder = normalizePath(folder);
    const trimmedProfileId = agentProfileId.trim();
    const withoutFolder = config.folderAgentProfileIds.filter(
        (entry) => normalizePath(entry.folder) !== normalizedFolder,
    );
    return normalizeConfig({
        ...config,
        folderAgentProfileIds: trimmedProfileId
            ? [
                  ...withoutFolder,
                  {
                      folder: normalizedFolder,
                      agentProfileId: trimmedProfileId,
                  },
              ]
            : withoutFolder,
    });
}

export async function loadConfig(): Promise<Config> {
    /**
     * Use `stat` to distinguish "file doesn't exist yet" from any other read failure. The old code
     * collapsed both into "save defaults", which meant a transient read error (or — worse — a brief
     * empty-file window caused by a non-atomic `writeFile`) would silently overwrite the user's
     * config with defaults. Now we ONLY auto-create the file on a true `ENOENT`. Anything else
     * (read failure, empty file, JSON parse error) throws and the caller decides what to do —
     * load-modify-save callers catch and skip their save so the existing file is preserved.
     */
    const exists = await stat(configPath)
        .then(() => true)
        .catch(() => false);
    if (!exists) {
        await saveConfig(defaultConfig);
        return defaultConfig;
    }
    const contents = await readFile(configPath, 'utf-8');
    if (!contents.trim()) {
        throw new Error(
            `Config file at ${configPath} exists but is empty; refusing to overwrite with defaults.`,
        );
    }
    const raw = JSON.parse(contents) as Record<string, unknown>;
    const parsed = Object.prototype.hasOwnProperty.call(raw, 'agentProfiles')
        ? (raw as Partial<Config>)
        : migrateLegacyConfig(raw);
    const merged: Config = {
        ...defaultConfig,
        ...parsed,
        repos: parsed.repos || defaultConfig.repos,
        agentProfiles: parsed.agentProfiles || defaultConfig.agentProfiles,
        folderAgentProfileIds: parsed.folderAgentProfileIds || defaultConfig.folderAgentProfileIds,
        hiddenAiPane: parsed.hiddenAiPane || defaultConfig.hiddenAiPane,
    };
    return normalizeConfig(merged);
}

/**
 * Write the config atomically: stage to a temp file inside the same directory as the target, then
 * `rename` over the destination. `rename` is atomic on POSIX (and on macOS) when both paths are on
 * the same filesystem — readers either see the prior version or the new version, never an empty or
 * partially-written file. This eliminates the empty-file race that previously caused concurrent
 * `loadConfig` calls (from `/repos/touch`, GitHub-polling auto-disable, etc.) to fall through to
 * the "save defaults" path and wipe the user's settings.
 */
export async function saveConfig(config: Readonly<Config>): Promise<Config> {
    await mkdir(dirname(configPath), {
        recursive: true,
    });
    const normalized = normalizeConfig(config);
    const tempPath = `${configPath}.tmp.${process.pid}`;
    try {
        await writeFile(tempPath, JSON.stringify(normalized, undefined, 4), 'utf-8');
        await rename(tempPath, configPath);
        return normalized;
    } catch (error) {
        log.warning(`Failed to save config: ${String(error)}`);
        throw error;
    }
}
