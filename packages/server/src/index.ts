import {agentStormService, defaultConfig, PaneKind} from '@agent-storm/common';
import {HttpMethod, log} from '@augment-vir/common';
import {HttpStatus, implementService, silentServiceLogger} from '@rest-vir/implement-service';
import {attachService} from '@rest-vir/run-service';
import fastify from 'fastify';
import {appendFileSync, writeFileSync} from 'node:fs';
import {parseUrl} from 'url-vir';
import {initAuth, verifyAuthToken} from './auth.js';
import {loadConfig, saveConfig} from './config.js';
import {addWorktreeToConfig, removeWorktreeFromConfig} from './worktree-reconcile.js';
import {normalizePath} from './paths.js';
import {
    attachPane,
    killFolderPanes,
    killVscode,
    restartPane,
    shutdownDaemon,
    type PaneAttachment,
} from './daemon/daemon-client.js';
import {ensureDaemon, waitForDaemonGone} from './daemon/ensure-daemon.js';
import {serverLogPath} from './file-paths.js';
import {appendClientError, resetClientErrorLog} from './client-errors.js';
import {
    getCachedFolders,
    publishTargets,
    publishTargetsFromConfig,
    refreshFolderInfoNow,
    startFolderInfoRefreshLoop,
} from './folder-info.js';
import {pickFolder} from './folder-picker.js';
import {
    addWorktree,
    convertRepoToWorktreeLayout,
    getGitInfo,
    inspectRepoPath,
    removeWorktree,
} from './git.js';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {saveUpload} from './uploads.js';
import {ensureTestServer, installShutdownHooks} from './test-server.js';
import {attachVscodeProxy} from './vscode-proxy.js';

// Resolve once at module load — `scripts/stage-trivial-hunks.mjs` lives at the agent-storm
// repo root, three levels up from this file (`packages/server/src/index.ts`).
const stageTrivialHunksScript = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'scripts',
    'stage-trivial-hunks.mjs',
);

installShutdownHooks();

/**
 * Mirror stdout/stderr to `serverLogPath` so the assistant can tail the backend output instead of
 * asking the user to copy/paste console lines. Truncate on startup so each `npm start` begins with
 * a clean file. The original streams keep going to the terminal — we just `appendFileSync` a copy
 * of each chunk. Wrapped in try/catch so a transient FS error never crashes the backend.
 */
try {
    writeFileSync(serverLogPath, '');
} catch {
    /* ignore truncate errors */
}
function mirrorWriteTo<Stream extends NodeJS.WriteStream>(
    original: Stream['write'],
    stream: Stream,
): Stream['write'] {
    return ((chunk: unknown, ...rest: unknown[]) => {
        try {
            if (typeof chunk === 'string' || chunk instanceof Buffer) {
                appendFileSync(serverLogPath, chunk);
            }
        } catch {
            /* ignore mirror-write errors */
        }
        return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
    }) as Stream['write'];
}
process.stdout.write = mirrorWriteTo(process.stdout.write.bind(process.stdout), process.stdout);
process.stderr.write = mirrorWriteTo(process.stderr.write.bind(process.stderr), process.stderr);

/**
 * Backend listen port and the frontend's listen port come from
 * `packages/scripts/src/start.script.ts` via env so each `npm start` gets fresh, conflict-free
 * ports. The frontend port is used below to install a CORS origin guard so only the matching vite
 * dev server (on any LAN hostname, on this port) is accepted — the auth secret in `createContext`
 * is the actual security boundary, but a port-scoped origin check is cheap defense-in-depth.
 */
const port = Number(process.env.BACKEND_PORT) || 41_880;
const frontendPort = Number(process.env.FRONTEND_PORT) || undefined;

/**
 * Override the service's `requiredClientOrigin` with a function that matches any origin whose port
 * equals the live frontend port. This is wider than a single string allowlist (works for
 * `localhost`, `127.0.0.1`, and arbitrary LAN IPs without re-listing them) but tighter than
 * `AnyOrigin` (a random page on the user's LAN can't impersonate the frontend just because it runs
 * on port 80).
 *
 * `defineService` copies `requiredClientOrigin` into a per-endpoint `minimalService` object that
 * the CORS handler reads at request time (see `handleCors` in @rest-vir/run-service). All
 * endpoints
 *
 * - Websockets share the same `minimalService` instance, so mutating it via any one endpoint's
 *   `.service` reference propagates everywhere. Mutating the top-level
 *   `agentStormService.requiredClientOrigin` does NOT propagate, because the inner object was
 *   captured before this code runs.
 */
if (frontendPort !== undefined) {
    const portGuard = (origin: string | undefined): boolean => {
        if (!origin) {
            return false;
        }
        try {
            const parsed = parseUrl(origin);
            return parsed.port === String(frontendPort);
        } catch {
            return false;
        }
    };
    const sampleEndpoint = Object.values(agentStormService.endpoints)[0];
    if (sampleEndpoint) {
        (sampleEndpoint.service as {requiredClientOrigin: unknown}).requiredClientOrigin =
            portGuard;
    }
    (agentStormService as {requiredClientOrigin: unknown}).requiredClientOrigin = portGuard;
}

type SocketAttachment = {
    attachment: PaneAttachment;
    folder: string;
    kind: PaneKind;
};

const attachmentsByWebSocket = new WeakMap<object, SocketAttachment>();

await ensureDaemon();
await resetClientErrorLog();

await startFolderInfoRefreshLoop();

await initAuth();

function extractBearerToken(header: string | string[] | undefined): string | undefined {
    if (typeof header !== 'string') {
        return undefined;
    }
    const trimmed = header.trim();
    const schemePrefix = 'bearer ';
    if (trimmed.slice(0, schemePrefix.length).toLowerCase() !== schemePrefix) {
        return undefined;
    }
    return trimmed.slice(schemePrefix.length).trimStart() || undefined;
}

async function runPostWorktreeCmd({
    repoPath,
    worktreePath,
}: Readonly<{
    repoPath: string;
    worktreePath: string;
}>): Promise<void> {
    const config = await loadConfig();
    const repoConfig = config.repos.find((repo) => repo.path === repoPath);
    const cmd = repoConfig?.postWorktreeCmd || config.postWorktreeCmd;
    if (!cmd) {
        return;
    }
    const attachment = await attachPane({
        folder: worktreePath,
        kind: PaneKind.Shell,
        onData() {},
        onExit() {},
    });
    attachment.write(`${cmd}\n`);
    attachment.close();
}

const implementation = implementService({
    service: agentStormService,
    customHeaders: ['Authorization'],
    /**
     * Mute the framework's per-request info chatter (each request, websocket open/close, etc.) but
     * keep its default error logger — runtime failures still need to surface. `error: undefined`
     * here would fall back to the default, so we only override `info`.
     */
    logger: {
        info: silentServiceLogger.info,
    },
    async createContext({requestHeaders, webSocketDefinition}) {
        const provided = webSocketDefinition
            ? typeof requestHeaders['sec-websocket-protocol'] === 'string'
                ? requestHeaders['sec-websocket-protocol'].trim()
                : undefined
            : extractBearerToken(requestHeaders.authorization);
        const isValid = await verifyAuthToken(provided);
        if (!isValid) {
            return {
                reject: {
                    statusCode: HttpStatus.Unauthorized,
                    responseErrorMessage: 'Unauthorized',
                },
            };
        }
        return {
            context: undefined,
        };
    },
})({
    endpoints: {
        async '/config'({method, requestData}) {
            if (method === HttpMethod.Get) {
                const config = await loadConfig();
                return {
                    statusCode: HttpStatus.Ok,
                    responseData: config,
                };
            } else if (!requestData) {
                return {
                    statusCode: HttpStatus.BadRequest,
                    responseErrorMessage: 'Missing config body.',
                };
            }
            await saveConfig(requestData);
            /**
             * Re-enumerate folder targets now so a freshly-added repo (or removed one) shows up in
             * `/folders` immediately instead of waiting for the next background sweep cycle.
             * `publishTargetsFromConfig` reconciles the worktree list against disk and writes the
             * reconciled config back; return that so the client sees the populated worktrees
             * without an extra round trip.
             */
            const reconciled = await publishTargetsFromConfig(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: reconciled,
            };
        },
        async '/folders'() {
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    folders: getCachedFolders(),
                },
            };
        },
        async '/worktrees/create'({requestData}) {
            const {worktreePath} = await addWorktree(requestData);
            // Fast path: we know exactly which worktree was added and where it lives, so skip
            // the full reconcile (which would re-run getGitInfo for every existing worktree
            // — that's the slow part on big repos). The next background sweep still catches
            // anything created out-of-band by the CLI.
            const newPath = normalizePath(join(requestData.repoPath, requestData.name));
            const config = await loadConfig();
            const updated = addWorktreeToConfig(config, requestData.repoPath, newPath);
            if (updated !== config) {
                await saveConfig(updated);
            }
            publishTargets(updated);
            await runPostWorktreeCmd({
                repoPath: requestData.repoPath,
                worktreePath,
            });
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/worktrees/delete'({requestData}) {
            const config = await loadConfig().catch(() => defaultConfig);
            const parentRepoPath = dirname(requestData.worktreePath);
            const parentRepo = config.repos.find((repo) => repo.path === parentRepoPath);
            // Prefer the config's cached `isBase` flag — it's authoritative and avoids a git
            // subprocess. Fall back to a live branch check if config hasn't seen this worktree
            // yet (e.g. created outside agent-storm and not yet reconciled).
            const knownWorktree = parentRepo?.worktrees.find(
                (worktree) => worktree.path === requestData.worktreePath,
            );
            if (knownWorktree?.isBase && parentRepo?.baseBranch) {
                return {
                    statusCode: HttpStatus.BadRequest,
                    responseErrorMessage: `Refusing to remove ${requestData.worktreePath}: it tracks the "${parentRepo.baseBranch}" base branch for ${parentRepoPath}.`,
                };
            }
            if (!knownWorktree && parentRepo?.baseBranch) {
                const info = await getGitInfo(requestData.worktreePath);
                if (info.branch === parentRepo.baseBranch) {
                    return {
                        statusCode: HttpStatus.BadRequest,
                        responseErrorMessage: `Refusing to remove ${requestData.worktreePath}: it tracks the "${parentRepo.baseBranch}" base branch for ${parentRepoPath}.`,
                    };
                }
            }
            await killFolderPanes({
                folder: requestData.worktreePath,
            });
            await killVscode({
                folder: requestData.worktreePath,
            }).catch(() => {
                /* if no vscode was running for this folder, killVscode is a no-op */
            });
            await removeWorktree(requestData);
            // Fast path: we know which worktree was removed; skip the full reconcile.
            const postDeleteConfig = removeWorktreeFromConfig(config, requestData.worktreePath);
            if (postDeleteConfig !== config) {
                await saveConfig(postDeleteConfig);
            }
            publishTargets(postDeleteConfig);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/worktrees/mark-reviewed'({requestData}) {
            const config = await loadConfig();
            const repos = config.repos.map((repo) => {
                if (!repo.worktrees.some((worktree) => worktree.path === requestData.worktreePath)) {
                    return repo;
                }
                return {
                    ...repo,
                    worktrees: repo.worktrees.map((worktree) =>
                        worktree.path === requestData.worktreePath
                            ? {...worktree, lastReviewedSha: requestData.sha}
                            : worktree,
                    ),
                };
            });
            const updated = {...config, repos};
            await saveConfig(updated);
            // Republish targets right away so `/folders` reflects the new SHA on the next poll
            // (no waiting for the ~25s sweep). The sweep's reconcile preserves `lastReviewedSha`
            // per worktree path, so this write survives the next disk-scan.
            publishTargets(updated);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/worktrees/set-merge-step'({requestData}) {
            const config = await loadConfig();
            const repos = config.repos.map((repo) => {
                if (!repo.worktrees.some((worktree) => worktree.path === requestData.worktreePath)) {
                    return repo;
                }
                return {
                    ...repo,
                    worktrees: repo.worktrees.map((worktree) => {
                        if (worktree.path !== requestData.worktreePath) {
                            return worktree;
                        }
                        const nextValues = {...(worktree.mergeStepValues ?? {})};
                        if (requestData.value == null) {
                            // Null clears the step — same shape as the un-toggled / never-set
                            // state, which keeps the config file from accumulating dead keys.
                            delete nextValues[requestData.name];
                        } else {
                            nextValues[requestData.name] = requestData.value;
                        }
                        return {...worktree, mergeStepValues: nextValues};
                    }),
                };
            });
            const updated = {...config, repos};
            await saveConfig(updated);
            publishTargets(updated);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/worktrees/test-server/start'({requestData}) {
            const {port: detectedPort, reused} = await ensureTestServer(requestData.worktreePath);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    port: detectedPort,
                    reused,
                },
            };
        },
        async '/worktrees/stage-trivial-hunks'({requestData}) {
            const result = spawnSync(process.execPath, [stageTrivialHunksScript], {
                cwd: requestData.worktreePath,
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
            });
            const output = [result.stdout, result.stderr].filter(Boolean).join('');
            if (result.status !== 0) {
                return {
                    statusCode: HttpStatus.InternalServerError,
                    responseErrorMessage: output || 'stage-trivial-hunks failed',
                };
            }
            return {
                statusCode: HttpStatus.Ok,
                responseData: {output},
            };
        },
        async '/panes/restart'({requestData}) {
            await restartPane(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/panes/kill'({requestData}) {
            await killFolderPanes(requestData);
            /**
             * Pair the VS Code instance lifecycle with the pane lifecycle — "kill folder panes"
             * implies "tear down the editor I have for this folder too". Silently ignore the
             * no-vscode case.
             */
            await killVscode({
                folder: requestData.folder,
            }).catch(() => {});
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/daemon/restart'() {
            await shutdownDaemon().catch(() => {
                /* daemon may already be down; ensureDaemon below will respawn */
            });
            await waitForDaemonGone(3000);
            await ensureDaemon();
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/uploads/create'({requestData}) {
            const path = await saveUpload(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    path,
                },
            };
        },
        async '/repos/inspect'({requestData}) {
            const inspection = await inspectRepoPath(requestData.path);
            return {
                statusCode: HttpStatus.Ok,
                responseData: inspection,
            };
        },
        async '/repos/convert-to-worktree'({requestData}) {
            await convertRepoToWorktreeLayout(requestData.repoPath);
            // After conversion the repo path now hosts a worktree layout; reconcile so the
            // config reflects the new on-disk shape before the frontend reads it back.
            await publishTargetsFromConfig(await loadConfig());
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/repos/delete'({requestData}) {
            const config = await loadConfig().catch(() => defaultConfig);
            if (!config.repos.some((repo) => repo.path === requestData.repoPath)) {
                return {
                    statusCode: HttpStatus.NotFound,
                    responseErrorMessage: `Repo ${requestData.repoPath} is not registered.`,
                };
            }
            const nextConfig = {
                ...config,
                repos: config.repos.filter((repo) => repo.path !== requestData.repoPath),
            };
            await saveConfig(nextConfig);
            await publishTargetsFromConfig(nextConfig);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/folder-picker'() {
            try {
                const path = await pickFolder();
                return {
                    statusCode: HttpStatus.Ok,
                    responseData: {
                        path,
                    },
                };
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                log.error(`folder-picker failed: ${message}`);
                return {
                    statusCode: HttpStatus.InternalServerError,
                    responseErrorMessage: message,
                };
            }
        },
        async '/client-errors'({requestData}) {
            await appendClientError({
                message: requestData.message,
                stack: requestData.stack ?? null,
                source: requestData.source,
                url: requestData.url ?? null,
                userAgent: requestData.userAgent ?? null,
            });
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
    },
    webSockets: {
        '/pty': {
            async open({webSocket, searchParams}) {
                const folder = searchParams.folder[0];
                const kind = searchParams.kind[0];
                const attachment = await attachPane({
                    folder,
                    kind,
                    onData(data) {
                        webSocket.send(data);
                    },
                    async onExit() {
                        await webSocket.close();
                    },
                });
                attachmentsByWebSocket.set(webSocket, {
                    attachment,
                    folder,
                    kind,
                });
            },
            message({webSocket, message}) {
                const socketAttachment = attachmentsByWebSocket.get(webSocket);
                if (!socketAttachment) {
                    return;
                } else if (typeof message === 'string') {
                    socketAttachment.attachment.write(message);
                    return;
                }
                socketAttachment.attachment.resize(message.resize.cols, message.resize.rows);
            },
            close({webSocket}) {
                const socketAttachment = attachmentsByWebSocket.get(webSocket);
                socketAttachment?.attachment.close();
                attachmentsByWebSocket.delete(webSocket);
            },
        },
    },
});

/**
 * Custom Fastify instance so we can raise `bodyLimit` past Fastify's 1 MB default. Image uploads
 * (screenshots dragged into a terminal) get base64-encoded inside a JSON body and that runs past
 * the default in a hurry.
 */
const server = fastify({
    bodyLimit: 25 * 1024 * 1024,
});

await attachService(server, implementation, {
    throwErrorsForExternalHandling: false,
});
/**
 * Mount the embedded-VS-Code proxy after the main service so its `/vscode-proxy/*` route doesn't
 * collide with rest-vir's path handling. Owns its own routes (`/vscode/ensure`, `/vscode/kill`, the
 * proxy itself) and an HTTP-server `upgrade` listener for WebSocket forwarding.
 */
attachVscodeProxy(server);
/**
 * Default to `127.0.0.1` so the dev server isn't reachable over LAN. The auth-secret on the
 * wire would otherwise be a passive-sniffer hazard (no TLS in dev). LAN testing — the UI from
 * a phone or another laptop — is still possible via `AGENT_STORM_BIND_HOST=0.0.0.0`, at which
 * point the bearer-secret check becomes the only thing gating access (which is fine because
 * the secret is 256 bits of unguessable randomness; see `packages/server/src/auth.ts`).
 */
const bindHost = process.env.AGENT_STORM_BIND_HOST || '127.0.0.1';
const listenAddress = await server.listen({
    port,
    host: bindHost,
});

log.success(`agent-storm server listening on ${listenAddress}`);
