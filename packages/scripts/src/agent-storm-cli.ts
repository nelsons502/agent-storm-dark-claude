/**
 * Read-only CLI for inspecting live agent-storm sessions from inside one of them.
 *
 * This exists so a session in one worktree can see what the others are doing. The daemon already
 * addresses every pane by `folder + kind + sessionId` and already reports all of them, so this is a
 * thin client over `daemon-client`, not new machinery.
 *
 * Deliberately read-only. Writing into another agent's terminal is a prompt-injection surface — a
 * monitored session can echo attacker-controlled text that the monitoring session would then act on
 * — so sending input is intentionally absent rather than merely unimplemented. Adding it later
 * should mean a distinct, visibly-tagged message channel with per-session opt-in, not raw stdin
 * bytes.
 */

import {PaneKind, PaneStatus} from '@agent-storm/common';
/**
 * Deep imports on purpose: `@agent-storm/server`'s entry point starts a Fastify server as a side
 * effect, so importing the package would boot one. Matches how `start.script.ts` reaches into it.
 */
import {attachPane, fetchPaneStatuses} from '@agent-storm/server/src/daemon/daemon-client.js';
import type {StatusEntry} from '@agent-storm/server/src/daemon/protocol.js';

const usage = `agent-storm — read-only view of live agent-storm sessions

Usage:
  storm ls [--json]                       List every live pane.
  storm whoami [--json]                   Identify the session this command is running inside.
  storm tail <folder> [options]           Print a pane's recent output and exit.

Tail options:
  --kind <ai|shell>    Which pane. Defaults to ai.
  --session <id>       Which session tab. Defaults to the folder+kind's only/first live one.
  --lines <n>          How many trailing lines to print. Defaults to 100.
  --plain              Strip terminal control sequences. Lossy, but readable.

Global:
  --json               Machine-readable output.
  --help               This text.

Inside a session, AGENT_STORM_FOLDER / _KIND / _SESSION_ID identify the current pane.
`;

/**
 * ANSI control sequences: CSI (`\x1b[...`), OSC (`\x1b]...` terminated by BEL or ST), and the short
 * two-character escapes. Raw pane output is dense with these, which is fine for a terminal and
 * close to unreadable for anything else — `--plain` exists so a monitoring session gets the text.
 */
const ansiSequences = new RegExp(
    [
        /** CSI: `ESC [` params intermediates final. */
        String.raw`\u001B\[[0-9;:?]*[ -/]*[@-~]`,
        /** OSC: `ESC ]` payload, terminated by BEL or ST. */
        String.raw`\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?`,
        /** Two-character escapes, plus charset selection. */
        String.raw`\u001B[@-Z\\-_]`,
        String.raw`\u001B[()][A-Za-z0-9]`,
    ].join('|'),
    'g',
);

/** Control bytes left over once the escape sequences are gone. Tab and newline are kept. */
const strayControlBytes = new RegExp(
    String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]`,
    'g',
);

/**
 * Flatten pane output to something readable off-terminal: drop control sequences, normalize line
 * endings, and collapse the runs of blank lines that redraw-heavy TUIs leave behind.
 *
 * Lossy by design. A TUI paints by moving the cursor, so its scrollback is a record of draw
 * operations rather than a transcript — stripping the sequences leaves the text roughly in the
 * order it was written, which is enough to tell what a session is doing but is not a faithful
 * screenshot.
 */
function toPlainText(output: string): string {
    return output
        .replace(ansiSequences, '')
        .replace(strayControlBytes, '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** A pane is only worth reading when a process is actually attached to it. */
function isLive(status: PaneStatus): boolean {
    return status === PaneStatus.Busy || status === PaneStatus.Idle;
}

function parseFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
}

function hasFlag(argv: ReadonlyArray<string>, name: string): boolean {
    return argv.includes(`--${name}`);
}

function describeEntry(entry: Readonly<StatusEntry>): string {
    return [
        entry.status.padEnd(6),
        entry.kind.padEnd(5),
        (entry.sessionId ?? 'default').padEnd(36),
        entry.folder,
    ].join('  ');
}

async function runLs(argv: ReadonlyArray<string>): Promise<number> {
    const panes = (await fetchPaneStatuses()).filter((entry) => isLive(entry.status));
    if (hasFlag(argv, 'json')) {
        process.stdout.write(`${JSON.stringify(panes, undefined, 2)}\n`);
        return 0;
    } else if (panes.length) {
        process.stdout.write(`${panes.map(describeEntry).join('\n')}\n`);
        return 0;
    } else {
        process.stdout.write('no live panes\n');
        return 0;
    }
}

function runWhoami(argv: ReadonlyArray<string>): number {
    const identity = {
        folder: process.env.AGENT_STORM_FOLDER,
        kind: process.env.AGENT_STORM_KIND,
        sessionId: process.env.AGENT_STORM_SESSION_ID,
    };
    if (hasFlag(argv, 'json')) {
        process.stdout.write(`${JSON.stringify(identity, undefined, 2)}\n`);
        return 0;
    } else if (identity.folder) {
        process.stdout.write(
            `folder:  ${identity.folder}\nkind:    ${identity.kind}\nsession: ${identity.sessionId}\n`,
        );
        return 0;
    } else {
        process.stdout.write(
            'not running inside an agent-storm pane (AGENT_STORM_FOLDER is unset)\n',
        );
        return 1;
    }
}

/**
 * Resolve the caller's folder/kind/session words to exactly one live pane.
 *
 * Matching against the daemon's live list first is what keeps this read-only: `attachPane` spawns a
 * PTY when none exists for the requested key, so tailing an unknown folder would silently start a
 * process instead of reporting nothing to read.
 */
function resolvePane(
    panes: ReadonlyArray<StatusEntry>,
    request: Readonly<{folder: string; kind: PaneKind; sessionId: string | undefined}>,
): StatusEntry | {error: string} {
    const folderMatches = panes.filter(
        (entry) =>
            isLive(entry.status) &&
            (entry.folder === request.folder || entry.folder.endsWith(`/${request.folder}`)),
    );
    if (!folderMatches.length) {
        return {
            error: `no live pane for folder "${request.folder}" — run \`storm ls\` to see what is running`,
        };
    }
    const distinctFolders = new Set(folderMatches.map((entry) => entry.folder));
    if (distinctFolders.size > 1) {
        return {
            error: `"${request.folder}" matches several folders:\n  ${Array.from(distinctFolders).join('\n  ')}`,
        };
    }
    const kindMatches = folderMatches.filter((entry) => entry.kind === request.kind);
    if (!kindMatches.length) {
        return {
            error: `no live ${request.kind} pane in ${Array.from(distinctFolders)[0]}`,
        };
    } else if (request.sessionId) {
        const exact = kindMatches.find(
            (entry) => (entry.sessionId ?? 'default') === request.sessionId,
        );
        return (
            exact ?? {
                error: `no live pane with session id "${request.sessionId}"`,
            }
        );
    } else {
        const [only] = kindMatches;
        if (kindMatches.length > 1) {
            return {
                error: `several ${request.kind} sessions are live; pass --session <id>:\n  ${kindMatches
                    .map((entry) => entry.sessionId ?? 'default')
                    .join('\n  ')}`,
            };
        }
        return (
            only ?? {
                error: 'no matching pane',
            }
        );
    }
}

/**
 * Collect a pane's replayed scrollback, then stop.
 *
 * The daemon sends the replay immediately after the attach handshake, in chunks. There is no
 * end-of-replay marker in the protocol, so settle on a short quiet period: once no further data has
 * arrived, the replay is done and anything after that would be live output we are not here for.
 */
async function readReplay(
    entry: Readonly<StatusEntry>,
    lines: number,
): Promise<{output: string} | {error: string}> {
    const quietPeriodMs = 250;
    const overallTimeoutMs = 10_000;
    const collected: string[] = [];

    return new Promise((resolve) => {
        const timers: {quiet: NodeJS.Timeout | undefined; overall: NodeJS.Timeout} = {
            quiet: undefined,
            overall: setTimeout(() => finish(), overallTimeoutMs),
        };
        const done = {
            settled: false,
        };
        const attachment: {current: {close: () => void} | undefined} = {
            current: undefined,
        };

        function finish(): void {
            if (done.settled) {
                return;
            }
            done.settled = true;
            if (timers.quiet) {
                clearTimeout(timers.quiet);
            }
            clearTimeout(timers.overall);
            attachment.current?.close();
            resolve({
                output: collected.join('').split('\n').slice(-lines).join('\n'),
            });
        }

        function onData(data: string): void {
            collected.push(data);
            if (timers.quiet) {
                clearTimeout(timers.quiet);
            }
            timers.quiet = setTimeout(() => finish(), quietPeriodMs);
        }

        attachPane({
            folder: entry.folder,
            kind: entry.kind,
            sessionId: entry.sessionId,
            scrollbackLimit: lines,
            onData,
            onExit: () => finish(),
        })
            .then((result) => {
                attachment.current = result;
                /**
                 * A brand-new pane means the resolve step raced with the pane exiting: we asked for
                 * something live and got a fresh spawn instead. Close it rather than leave a
                 * process this read-only command created.
                 */
                if (result.isNew) {
                    done.settled = true;
                    clearTimeout(timers.overall);
                    if (timers.quiet) {
                        clearTimeout(timers.quiet);
                    }
                    result.close();
                    resolve({
                        error: 'that pane is no longer live (it would have been spawned fresh)',
                    });
                    return;
                }
                /** No data at all is a legitimate answer for a pane that has produced none. */
                timers.quiet = setTimeout(() => finish(), quietPeriodMs);
            })
            .catch((error: unknown) => {
                done.settled = true;
                clearTimeout(timers.overall);
                resolve({
                    error: error instanceof Error ? error.message : String(error),
                });
            });
    });
}

async function runTail(argv: ReadonlyArray<string>): Promise<number> {
    const folder = argv[1];
    if (!folder || folder.startsWith('--')) {
        process.stderr.write('tail needs a folder — see `storm --help`\n');
        return 1;
    }
    const kindWord = parseFlag(argv, 'kind') ?? PaneKind.Ai;
    if (kindWord !== PaneKind.Ai && kindWord !== PaneKind.Shell) {
        process.stderr.write(`--kind must be "${PaneKind.Ai}" or "${PaneKind.Shell}"\n`);
        return 1;
    }
    const linesWord = parseFlag(argv, 'lines');
    const lines = linesWord ? Number(linesWord) : 100;
    if (!Number.isInteger(lines) || lines < 1) {
        process.stderr.write('--lines must be a positive integer\n');
        return 1;
    }

    const resolved = resolvePane(await fetchPaneStatuses(), {
        folder,
        kind: kindWord,
        sessionId: parseFlag(argv, 'session'),
    });
    if ('error' in resolved) {
        process.stderr.write(`${resolved.error}\n`);
        return 1;
    }

    const replay = await readReplay(resolved, lines);
    if ('error' in replay) {
        process.stderr.write(`${replay.error}\n`);
        return 1;
    }
    const output = hasFlag(argv, 'plain') ? toPlainText(replay.output) : replay.output;
    if (hasFlag(argv, 'json')) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    folder: resolved.folder,
                    kind: resolved.kind,
                    sessionId: resolved.sessionId ?? 'default',
                    status: resolved.status,
                    output,
                },
                undefined,
                2,
            )}\n`,
        );
        return 0;
    }
    process.stdout.write(`${output}\n`);
    return 0;
}

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    const command = argv[0];

    if (!command || hasFlag(argv, 'help') || command === 'help') {
        process.stdout.write(usage);
        return 0;
    } else if (command === 'ls' || command === 'status') {
        return await runLs(argv);
    } else if (command === 'whoami') {
        return runWhoami(argv);
    } else if (command === 'tail') {
        return await runTail(argv);
    } else {
        process.stderr.write(`unknown command "${command}" — see \`storm --help\`\n`);
        return 1;
    }
}

process.exitCode = await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
});
