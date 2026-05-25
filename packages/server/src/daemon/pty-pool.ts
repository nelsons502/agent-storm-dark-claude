import {PaneKind, PaneStatus} from '@agent-storm/common';
import {omitObjectKeys} from '@augment-vir/common';
import {spawn, type IPty} from 'node-pty';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import type {StatusEntry} from './protocol.js';

const idleThresholdMs = 2000;

/**
 * Characters in Claude's TUI whose per-character count changing between polls signals "Claude
 * is rendering something right now". Each one is tracked independently — a change in ANY of
 * the per-character counters re-arms the busy hold. Picked because they appear in Claude's
 * spinner / status frames but are rare in plain user input (typing into the prompt without
 * submitting doesn't move them). Add or remove markers here as Claude's TUI evolves; each
 * marker must be a single UTF-16 code unit (which covers everything in the Unicode BMP,
 * including the symbols below) so `String#split(marker)` counts occurrences correctly.
 */
const aiBusyMarkerChars: ReadonlyArray<string> = [
    '✻', // U+273B teardrop-spoked asterisk
    '✽', // U+273D heavy teardrop-spoked asterisk
    '✶', // U+2736 six-pointed black star
    '✳', // U+2733 eight-spoked asterisk
    '✢', // U+2722 four-teardrop / balloon-spoked asterisk
];

/**
 * After we detect that any AI busy-marker count moved, the pane stays Busy for this long even
 * if no further change is seen. Sized at 4s rather than tied tightly to the 1s poll cadence so
 * a single-poll blip (a quiet tool-result wait, a paused spinner) doesn't flap the sidebar back
 * to "needs attention" — only ~4s of true silence drops the pane to Idle. The 1s poll then
 * keeps this responsive: as soon as Claude renders another marker, the hold extends by another
 * 4s.
 */
const aiBusyHoldMs = 4_000;

const aiCommand = process.env.AGENT_STORM_AI_CMD || 'claude';

/**
 * RFC 4122 DNS namespace UUID. Combined with the worktree's absolute path via UUIDv5, this gives
 * us a stable session ID per worktree — the same path always hashes to the same UUID, so the AI
 * pane can be relaunched with `--resume <uuid>` after an app crash and pick up exactly where it
 * left off.
 */
const claudeSessionNamespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function uuidv5(name: string, namespace: string): string {
    const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
    const hash = createHash('sha1').update(namespaceBytes).update(name).digest();
    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5 marker
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Claude stores per-project sessions under `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
 * The cwd encoding is just `/` → `-`. Checking the file's existence is how we decide whether
 * to launch with `--resume <uuid>` (file already present from a prior run) or `--session-id
 * <uuid>` (first time for this worktree — pin the UUID so the *next* launch can resume it).
 */
function claudeSessionFilePath(folder: string, sessionId: string): string {
    // Claude encodes project dirs by replacing both `/` AND `.` with `-`
    // (e.g. `/home/x/app.foo.ai` → `-home-x-app-foo-ai`). Matching that exactly
    // is what lets us decide --resume vs --session-id correctly for worktrees
    // whose path contains a dot.
    const encoded = folder.replace(/[/.]/g, '-');
    return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, String.raw`'\''`)}'`;
}

/**
 * Compose the AI command for a worktree:
 *   - Deterministic UUIDv5 from the worktree path is the session ID.
 *   - `--name <basename>` labels the session so the user sees a meaningful entry in claude's
 *     `/resume` picker (worktree name matches the branch name in this user's setup).
 *   - `--resume` when claude's storage already has that session file, otherwise `--session-id`
 *     to pin the UUID for next time. This is what makes app-crash recovery automatic.
 */
function buildAiCommand(folder: string): string {
    const sessionId = uuidv5(folder, claudeSessionNamespace);
    const sessionName = basename(folder);
    const nameArg = `--name ${shellSingleQuote(sessionName)}`;
    const sessionArg = existsSync(claudeSessionFilePath(folder, sessionId))
        ? `--resume ${sessionId}`
        : `--session-id ${sessionId}`;
    return `${aiCommand} ${sessionArg} ${nameArg}`;
}

/**
 * AI pane runs through a login + interactive shell so `.zprofile` / `.zshrc` get sourced (those are
 * where managed-Claude installers usually inject their PATH lines). When the AI command exits (user
 * typed `/exit`, ran a one-shot, crashed, etc.) the trailing `exec <shell> -li` replaces the
 * wrapper with another login+interactive copy of the user's preferred shell, so the pty stays alive
 * and the user lands in a normal shell prompt instead of an `[exited with code …]` dead pane.
 */
const paneCommands: Record<PaneKind, (folder: string) => string[]> = {
    [PaneKind.Ai]: (folder) => [
        process.env.SHELL || '/bin/zsh',
        '-lic',
        buildAiCommand(folder),
    ],
    [PaneKind.Shell]: () => [
        process.env.SHELL || '/bin/bash',
        '-l',
    ],
    /**
     * Services pane runs `npm start` for the worktree. We launch it through the user's login
     * shell (`-lic 'npm start'`) so PATH and node version managers (nvm/asdf) are sourced —
     * `spawn('npm', …)` directly would inherit only the daemon's PATH, which on systems where
     * node is provided by nvm is empty of `npm` until `.zshrc` loads it in.
     */
    [PaneKind.Services]: () => [
        process.env.SHELL || '/bin/zsh',
        '-lic',
        'npm start',
    ],
};

type PaneSize = {
    cols: number;
    rows: number;
};

type Subscriber = {
    onData: (data: string) => void;
    onExit: (exitCode: number | undefined) => void;
    /**
     * Most-recent viewport size reported by this client. Undefined until the client sends its first
     * resize. Used to compute the pane-wide min size below.
     */
    size: PaneSize | undefined;
};

type PaneEntry = {
    pty: IPty | undefined;
    /**
     * Wall-clock of the most recent activity in either direction — pty output OR user input.
     * Counting input is what makes the sidebar flip to "Working" the instant the user starts
     * typing, even before the TUI has had a chance to echo characters back. Used only for the
     * shell pane's busy heuristic; the AI pane uses `asteriskCount` below instead.
     */
    lastActivityAt: number;
    /**
     * Monotonic per-character count of busy-marker occurrences the pty has emitted since
     * spawn. Keyed by the marker string itself (one entry per `aiBusyMarkerChars` value);
     * each count climbs independently as that specific character lands in pty output. The
     * AI Busy check compares each per-marker count against its previous-poll snapshot
     * (`busyMarkerCountsAtLastCheck`) so a change in ANY of the tracked characters triggers
     * the busy hold.
     */
    busyMarkerCounts: Map<string, number>;
    /**
     * `busyMarkerCounts` snapshotted (per-key) at the last `entryStatus` query. A mismatch on
     * any key re-arms `lastBusyMarkerChangeAt`.
     */
    busyMarkerCountsAtLastCheck: Map<string, number>;
    /**
     * Wall-clock of the most recent poll at which any per-marker count changed. The AI pane
     * reports Busy for `aiBusyHoldMs` after this timestamp — that's the "4-second hold", so
     * a single-poll quiet spell mid-turn doesn't flap the sidebar back to idle.
     */
    lastBusyMarkerChangeAt: number;
    exitCode: number | undefined;
    subscribers: Set<Subscriber>;
    /** Bounded scrollback used to replay output to a newly attaching client. */
    scrollbackChunks: string[];
    scrollbackBytes: number;
};

/** Roughly 1 MB of scrollback per pane, which is several thousand lines of typical output. */
const maxScrollbackBytes = 1_000_000;

/**
 * Fresh zero-initialized map for every entry in `aiBusyMarkerChars`. Used both at pane spawn
 * and on restart so per-marker counts always start from a known baseline.
 */
function newBusyMarkerCounts(): Map<string, number> {
    return new Map(aiBusyMarkerChars.map((marker) => [marker, 0]));
}

/**
 * Increment each tracked counter in `counts` by the number of times its marker appears in
 * `data`. `String#includes` first skips the common no-marker chunk without allocating; `split`
 * on a single-UTF-16-code-unit marker (all of `aiBusyMarkerChars` qualify) gives an accurate
 * occurrence count without any code-point-aware iteration.
 */
function accumulateBusyMarkers(counts: Map<string, number>, data: string): void {
    for (const marker of aiBusyMarkerChars) {
        if (!data.includes(marker)) {
            continue;
        }
        const previous = counts.get(marker) ?? 0;
        counts.set(marker, previous + data.split(marker).length - 1);
    }
}

function appendScrollback(entry: PaneEntry, data: string): void {
    entry.scrollbackChunks.push(data);
    entry.scrollbackBytes += data.length;
    while (entry.scrollbackBytes > maxScrollbackBytes && entry.scrollbackChunks.length > 1) {
        const dropped = entry.scrollbackChunks.shift();
        if (dropped) {
            entry.scrollbackBytes -= dropped.length;
        }
    }
}

function clearScrollback(entry: PaneEntry): void {
    entry.scrollbackChunks = [];
    entry.scrollbackBytes = 0;
}

const panes = new Map<string, PaneEntry>();

function normalizePath(path: string): string {
    const expanded =
        path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
    return resolve(expanded);
}

function paneKey(folder: string, kind: PaneKind): string {
    return `${folder}:${kind}`;
}

function ensureEntry(folder: string, kind: PaneKind): PaneEntry {
    const key = paneKey(folder, kind);
    const existing = panes.get(key);
    if (existing) {
        return existing;
    }
    const entry: PaneEntry = {
        pty: undefined,
        lastActivityAt: 0,
        busyMarkerCounts: newBusyMarkerCounts(),
        busyMarkerCountsAtLastCheck: newBusyMarkerCounts(),
        lastBusyMarkerChangeAt: 0,
        exitCode: undefined,
        subscribers: new Set(),
        scrollbackChunks: [],
        scrollbackBytes: 0,
    };
    panes.set(key, entry);
    return entry;
}

/**
 * Build the env we hand to a freshly spawned shell. Critically, we DROP `PATH` so the spawned
 * login+interactive shell rebuilds it from /etc/paths and the user's rc files — exactly the way
 * Terminal.app does. Inheriting `PATH` from the daemon process pollutes the start with npm-injected
 * `node_modules/.bin` entries (because `npm start` was the daemon's grandparent), which push the
 * user's `.zprofile` PATH prepends into late positions and can mask the preferred copy of `claude`
 * (or any other binary they expect to find first).
 */
function spawnEnv(): NodeJS.ProcessEnv {
    return omitObjectKeys(process.env, ['PATH']);
}

/**
 * Compute the smallest viewport across all currently-attached subscribers and resize the PTY to
 * match. Subscribers that haven't reported a size yet are skipped. When no subscriber has a size,
 * the pty keeps whatever dimensions it had (either the spawn default or the last applied min); this
 * matters mostly during the brief window between a new socket attaching and its first resize
 * message arriving.
 */
function applyMinSize(entry: PaneEntry): void {
    if (!entry.pty) {
        return;
    }
    const sizes = Array.from(entry.subscribers, (subscriber) => subscriber.size).filter(
        (size): size is PaneSize => size !== undefined,
    );
    if (sizes.length === 0) {
        return;
    }
    const cols = sizes.reduce((min, size) => Math.min(min, size.cols), Number.POSITIVE_INFINITY);
    const rows = sizes.reduce((min, size) => Math.min(min, size.rows), Number.POSITIVE_INFINITY);
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
        entry.pty.resize(cols, rows);
    }
}

function startPty(folder: string, kind: PaneKind, entry: PaneEntry): void {
    const [
        command,
        ...args
    ] = paneCommands[kind](folder);
    if (!command) {
        return;
    }
    const cwd = normalizePath(folder);
    try {
        const pty = spawn(command, args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 32,
            cwd,
            env: spawnEnv() as Record<string, string>,
        });
        entry.pty = pty;
        entry.exitCode = undefined;
        entry.lastActivityAt = Date.now();
        pty.onData((data) => {
            entry.lastActivityAt = Date.now();
            accumulateBusyMarkers(entry.busyMarkerCounts, data);
            appendScrollback(entry, data);
            entry.subscribers.forEach((subscriber) => {
                subscriber.onData(data);
            });
        });
        pty.onExit(({exitCode}) => {
            /**
             * If this pty was already replaced by a restart, `entry.pty` now points at the new
             * pty. Swallow the exit so we don't tear down still-attached subscribers — they will
             * keep receiving from the fresh pty without seeing a `[connection closed]` blip.
             */
            if (entry.pty !== pty) {
                return;
            }
            entry.exitCode = exitCode;
            entry.pty = undefined;
            const message = `[pty ${kind} for ${folder} exited with code ${exitCode}]\r\n`;
            appendScrollback(entry, message);
            entry.subscribers.forEach((subscriber) => {
                subscriber.onData(message);
                subscriber.onExit(exitCode);
            });
        });
        /**
         * If a restart happens while clients are still attached (each carrying their last reported
         * size), pull the fresh pty down to the existing min before any data flows.
         */
        applyMinSize(entry);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const message = `[pty ${kind} failed to spawn: ${reason}]\r\n`;
        entry.exitCode = -1;
        appendScrollback(entry, message);
        entry.subscribers.forEach((subscriber) => {
            subscriber.onData(message);
            subscriber.onExit(-1);
        });
    }
}

export function attachPane({
    folder,
    kind,
    onData,
    onExit,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    onData: (data: string) => void;
    onExit: (exitCode: number | undefined) => void;
}>): {
    isNew: boolean;
    scrollback: string;
    setSize: (cols: number, rows: number) => void;
    detach: () => void;
} {
    const entry = ensureEntry(folder, kind);
    const isNew = !entry.pty;
    if (!entry.pty) {
        startPty(folder, kind, entry);
    }
    const subscriber: Subscriber = {
        onData,
        onExit,
        size: undefined,
    };
    entry.subscribers.add(subscriber);
    const scrollback = entry.scrollbackChunks.join('');
    return {
        isNew,
        scrollback,
        setSize(cols, rows) {
            if (cols < 1 || rows < 1) {
                return;
            }
            subscriber.size = {
                cols,
                rows,
            };
            applyMinSize(entry);
        },
        detach() {
            entry.subscribers.delete(subscriber);
            /**
             * Detaching may have removed the smallest viewport — recompute so the pty grows back up
             * to whatever the remaining clients allow.
             */
            applyMinSize(entry);
        },
    };
}

export function writeToPane({
    folder,
    kind,
    data,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    data: string;
}>): void {
    const entry = panes.get(paneKey(folder, kind));
    if (!entry?.pty) {
        return;
    }
    // Count the user's keystroke as activity so the sidebar flips to "Working" right away,
    // without waiting for the TUI to echo characters back.
    entry.lastActivityAt = Date.now();
    entry.pty.write(data);
}

export function restartPane({folder, kind}: Readonly<{folder: string; kind: PaneKind}>): void {
    const entry = ensureEntry(folder, kind);
    entry.pty?.kill();
    entry.pty = undefined;
    entry.exitCode = undefined;
    entry.lastActivityAt = 0;
    entry.busyMarkerCounts = newBusyMarkerCounts();
    entry.busyMarkerCountsAtLastCheck = newBusyMarkerCounts();
    entry.lastBusyMarkerChangeAt = 0;
    clearScrollback(entry);
    /**
     * ESC c — full terminal reset. Wipes the screen + cursor state on attached xterms so the
     * incoming fresh session doesn't render on top of the killed session's last frame.
     */
    entry.subscribers.forEach((subscriber) => {
        subscriber.onData('\x1bc');
    });
    startPty(folder, kind, entry);
}

export function killFolderPanes({folder}: Readonly<{folder: string}>): void {
    Object.values(PaneKind).forEach((kind) => {
        const key = paneKey(folder, kind);
        const entry = panes.get(key);
        if (entry?.pty) {
            entry.pty.kill();
            entry.pty = undefined;
        }
        panes.delete(key);
    });
}

function entryStatus(entry: PaneEntry | undefined, kind: PaneKind): PaneStatus {
    if (!entry) {
        return PaneStatus.None;
    } else if (!entry.pty) {
        return entry.exitCode == undefined ? PaneStatus.None : PaneStatus.Exited;
    }
    if (kind === PaneKind.Ai) {
        // AI Busy logic: each poll (~1s) we snapshot the per-marker counters. A delta on
        // ANY tracked character re-arms `lastBusyMarkerChangeAt`, and the pane reports
        // Busy for `aiBusyHoldMs` (4s) after that timestamp. Combining count-change
        // detection with a hold window means a single quiet poll doesn't flap the sidebar
        // back to Idle; genuine end-of-turn silence still surfaces within 4s. We always
        // copy the current counts into the snapshot at the end so the next poll has a
        // fresh baseline for comparison.
        let changed = false;
        for (const marker of aiBusyMarkerChars) {
            const current = entry.busyMarkerCounts.get(marker) ?? 0;
            const previous = entry.busyMarkerCountsAtLastCheck.get(marker) ?? 0;
            if (current !== previous) {
                changed = true;
                entry.busyMarkerCountsAtLastCheck.set(marker, current);
            }
        }
        if (changed) {
            entry.lastBusyMarkerChangeAt = Date.now();
        }
        return Date.now() - entry.lastBusyMarkerChangeAt < aiBusyHoldMs
            ? PaneStatus.Busy
            : PaneStatus.Idle;
    }
    return Date.now() - entry.lastActivityAt < idleThresholdMs ? PaneStatus.Busy : PaneStatus.Idle;
}

export function listAllPaneStatuses(): StatusEntry[] {
    return Array.from(panes.entries()).map(
        ([
            key,
            entry,
        ]) => {
            const separator = key.lastIndexOf(':');
            const kind = key.slice(separator + 1) as PaneKind;
            return {
                folder: key.slice(0, separator),
                kind,
                status: entryStatus(entry, kind),
            };
        },
    );
}
