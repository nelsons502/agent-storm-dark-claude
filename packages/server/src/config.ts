import {type Config, defaultConfig} from '@agent-storm/common';
import {randomBytes} from 'node:crypto';
import {mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {configPath} from './file-paths.js';
import {normalizePath} from './paths.js';

/**
 * Serialises overlapping `saveConfig` calls so two concurrent writers can't race on the same
 * file. Each call awaits the previous one's full write-and-rename sequence before starting its
 * own. Combined with the atomic rename in `saveConfig` below, this gives both intra-process
 * (multiple endpoints in flight) and inter-process (multiple backends — should be impossible
 * now that ports are fixed, but defence in depth) safety: the worst case is one writer's
 * intent gets overwritten by another, never a malformed JSON file.
 */
let writeChain: Promise<void> = Promise.resolve();


function normalizeConfig(config: Readonly<Config>): Config {
    return {
        ...config,
        repos: config.repos.map((repo) => ({
            ...repo,
            path: normalizePath(repo.path),
            // Legacy configs predate `worktrees` / `isWorktreeLayout`; fill in defaults so the
            // reconcile step can populate them on first load instead of crashing on undefined.
            worktrees: (repo.worktrees ?? []).map((worktree) => ({
                ...worktree,
                path: normalizePath(worktree.path),
                lastReviewedSha: worktree.lastReviewedSha ?? null,
                mergeStepValues: worktree.mergeStepValues ?? {},
            })),
            isWorktreeLayout: repo.isWorktreeLayout ?? false,
        })),
        hiddenAiPane: config.hiddenAiPane.map((path) => normalizePath(path)),
    };
}

export async function loadConfig(): Promise<Config> {
    const contents = await readFile(configPath, 'utf-8').catch(() => undefined);
    if (!contents) {
        await saveConfig(defaultConfig);
        return defaultConfig;
    }
    let parsed: Partial<Config>;
    try {
        parsed = JSON.parse(contents) as Partial<Config>;
    } catch (error) {
        /**
         * Corrupt config — most plausibly from a concurrent-write race during the period before
         * `saveConfig` was atomic. We back up the bad bytes (so the user can recover their repo
         * list manually if needed) and fall back to defaults rather than crashing every
         * endpoint that calls loadConfig until someone hand-edits the file. saveConfig is now
         * atomic via temp+rename and serialised through `writeChain`, so this shouldn't recur.
         */
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${configPath}.corrupt-${stamp}.bak`;
        await writeFile(backupPath, contents, 'utf-8').catch(() => {
            /* backup is best-effort — don't block recovery on it */
        });
        console.error(
            `agent-storm: config at ${configPath} is corrupt (${
                error instanceof Error ? error.message : String(error)
            }). Backed up to ${backupPath} and starting from defaults.`,
        );
        await saveConfig(defaultConfig);
        return defaultConfig;
    }
    const merged: Config = {
        ...defaultConfig,
        ...parsed,
        repos: parsed.repos || defaultConfig.repos,
        hiddenAiPane: parsed.hiddenAiPane || defaultConfig.hiddenAiPane,
    };
    return normalizeConfig(merged);
}

export async function saveConfig(config: Readonly<Config>): Promise<void> {
    // Chain onto any in-flight write so concurrent callers serialise instead of racing. The
    // chained-promise pattern keeps `saveConfig` non-blocking from the endpoint's perspective
    // (callers still get a single Promise to await) while guaranteeing FIFO ordering of the
    // underlying disk writes.
    const next = writeChain.then(() => writeConfigAtomic(config));
    writeChain = next.catch(() => {
        /* swallow so a failed write doesn't poison the chain for subsequent saves */
    });
    await next;
}

async function writeConfigAtomic(config: Readonly<Config>): Promise<void> {
    await mkdir(dirname(configPath), {recursive: true});
    const normalized = normalizeConfig(config);
    const body = JSON.stringify(normalized, undefined, 4);
    /**
     * Write to a sibling tmp file then `rename(tmp, configPath)` — POSIX `rename` is atomic
     * on the same filesystem, so a reader will either see the old complete file or the new
     * complete file, never a half-written one. The unique suffix prevents collision if a
     * second writer slips past the `writeChain` (e.g. across processes); the loser's tmp
     * file is cleaned up below.
     */
    const tmpPath = `${configPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        await writeFile(tmpPath, body, {encoding: 'utf-8', mode: 0o600});
        await rename(tmpPath, configPath);
    } catch (error) {
        await unlink(tmpPath).catch(() => {
            /* tmp file may not exist if writeFile itself failed — non-fatal */
        });
        throw error;
    }
}
