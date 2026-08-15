import {type PaneKind} from '@agent-storm/common';
import {wrapInTry} from '@augment-vir/common';
import {createConnection, type Socket} from 'node:net';
import {daemonSocketPath} from '../file-paths.js';
import {
    DaemonAction,
    encodeControlFrame,
    encodeDataFrame,
    FrameDecoder,
    FrameType,
    type AttachResponse,
    type ClientHandshake,
    type ErrorResponse,
    type ExitNotification,
    type ResizeNotification,
    type SimpleResponse,
    type StatusEntry,
    type StatusResponse,
} from './protocol.js';

function connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(daemonSocketPath);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

async function singleShot<Response extends {ok: true}>(
    handshake: ClientHandshake,
): Promise<Response> {
    const socket = await connect();
    const decoder = new FrameDecoder();
    return new Promise<Response>((resolve, reject) => {
        socket.on('data', (chunk) => {
            /**
             * Decoding throws on a desynced stream. Reject rather than let it escape the handler:
             * an unhandled throw inside a socket callback is an uncaught exception, which would
             * take the backend process down over one bad daemon connection.
             */
            const frames = wrapInTry(
                () => decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
                {
                    fallbackValue: undefined,
                },
            );
            if (!frames) {
                socket.destroy();
                reject(new Error('daemon frame stream desynced'));
                return;
            }
            const controlFrame = frames.find((frame) => frame.type === FrameType.Control);
            if (!controlFrame) {
                return;
            }
            const parsed = JSON.parse(controlFrame.payload.toString('utf-8')) as
                | Response
                | ErrorResponse;
            if (parsed.ok) {
                resolve(parsed);
            } else {
                reject(new Error(parsed.error));
            }
            socket.end();
        });
        socket.on('error', reject);
        socket.write(encodeControlFrame(handshake));
    });
}

export async function fetchPaneStatuses(): Promise<StatusEntry[]> {
    const response = await singleShot<StatusResponse>({
        action: DaemonAction.Status,
    });
    return response.panes;
}

/**
 * Read the running daemon's wire-contract version. Probes with `Status` because that is the only
 * introspection action every historical daemon understands — a version-1 daemon treats any
 * unrecognized action as "shutdown" and would kill every pane before we learned anything. A daemon
 * that answers without the field is version 1.
 */
export async function fetchDaemonProtocolVersion(): Promise<number> {
    const response = await singleShot<StatusResponse>({
        action: DaemonAction.Status,
    });
    return response.protocolVersion ?? 1;
}

export async function restartPane(
    params: Readonly<{
        folder: string;
        kind: PaneKind;
        sessionId?: string | undefined;
        aiCmd?: string | undefined;
    }>,
): Promise<void> {
    await singleShot<SimpleResponse>({
        action: DaemonAction.Restart,
        folder: params.folder,
        kind: params.kind,
        sessionId: params.sessionId,
        aiCmd: params.aiCmd,
    });
}

export async function killPaneSession(
    params: Readonly<{
        folder: string;
        kind: PaneKind;
        sessionId: string;
    }>,
): Promise<void> {
    await singleShot<SimpleResponse>({
        action: DaemonAction.SessionKill,
        folder: params.folder,
        kind: params.kind,
        sessionId: params.sessionId,
    });
}

export async function killFolderPanes(params: Readonly<{folder: string}>): Promise<void> {
    await singleShot<SimpleResponse>({
        action: DaemonAction.Kill,
        folder: params.folder,
    });
}

export async function shutdownDaemon(): Promise<void> {
    await singleShot<SimpleResponse>({
        action: DaemonAction.Shutdown,
    });
}

export type PaneAttachment = {
    isNew: boolean;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    close(): void;
};

export async function attachPane({
    folder,
    kind,
    sessionId,
    aiCmd,
    scrollbackLimit,
    onData,
    onExit,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    /** Which session tab to attach to. Empty/omitted resolves to the folder+kind's default. */
    sessionId?: string | undefined;
    /**
     * Resolved launch command for this AI session — forwarded to the daemon's attach handshake so a
     * fresh PTY honors its configured profile rather than whatever was in env when the daemon
     * started.
     */
    aiCmd?: string | undefined;
    /**
     * Client-requested cap on replayed scrollback lines, forwarded to the daemon's attach
     * handshake. The daemon truncates the buffered scrollback to the last N lines before replaying
     * it.
     */
    scrollbackLimit?: number | undefined;
    onData: (data: string) => void;
    onExit: (exitCode: number | undefined) => void;
}>): Promise<PaneAttachment> {
    const socket = await connect();
    const decoder = new FrameDecoder();

    socket.write(
        encodeControlFrame({
            action: DaemonAction.Attach,
            folder,
            kind,
            sessionId,
            aiCmd,
            scrollbackLimit,
        }),
    );

    const handshakeState = {
        resolved: false,
    };

    const handshakeResult = await new Promise<AttachResponse>((resolve, reject) => {
        const handler = (chunk: Buffer | string) => {
            /**
             * Same guard as `singleShot`, and it matters more here: this handler outlives the
             * handshake promise, so past resolution there is no promise left to catch a throw at
             * all.
             */
            const frames = wrapInTry(
                () => decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
                {
                    fallbackValue: undefined,
                },
            );
            if (!frames) {
                socket.destroy();
                if (!handshakeState.resolved) {
                    handshakeState.resolved = true;
                    reject(new Error('daemon frame stream desynced'));
                }
                return;
            }
            frames.forEach((frame) => {
                if (handshakeState.resolved) {
                    routeFrame(frame);
                } else if (frame.type === FrameType.Control) {
                    handshakeState.resolved = true;
                    const parsed = JSON.parse(frame.payload.toString('utf-8')) as
                        | AttachResponse
                        | ErrorResponse;
                    if (parsed.ok) {
                        resolve(parsed);
                    } else {
                        socket.end();
                        reject(new Error(parsed.error));
                    }
                }
            });
        };
        const routeFrame = (frame: {type: FrameType; payload: Buffer}) => {
            if (frame.type === FrameType.Data) {
                onData(frame.payload.toString('utf-8'));
                return;
            }
            const parsed = JSON.parse(frame.payload.toString('utf-8')) as ExitNotification;
            onExit(parsed.exitCode);
        };
        socket.on('data', handler);
        socket.once('error', reject);
        socket.once('close', () => {
            if (handshakeState.resolved) {
                onExit(undefined);
            } else {
                reject(new Error('Daemon socket closed before handshake response.'));
            }
        });
    });

    return {
        isNew: handshakeResult.isNew,
        write(data) {
            socket.write(encodeDataFrame(data));
        },
        resize(cols, rows) {
            const notification: ResizeNotification = {
                type: 'resize',
                cols,
                rows,
            };
            socket.write(encodeControlFrame(notification));
        },
        close() {
            socket.end();
        },
    };
}
