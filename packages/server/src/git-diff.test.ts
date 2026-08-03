// cspell:word unstages

import {GitDiffSide, GitFileChange, maxDiffFileBytes} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {createArray} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {strict as nodeAssert} from 'node:assert';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {
    discardFileChanges,
    getDiffFileContents,
    getDiffStatus,
    moveHunkAcrossIndex,
    setFileStaged,
} from './git-diff.js';

const exec = promisify(execFile);

async function git(folder: string, ...args: ReadonlyArray<string>): Promise<string> {
    return (
        await exec('git', [...args], {
            cwd: folder,
        })
    ).stdout;
}

async function createRepo(): Promise<{parent: string; repo: string}> {
    const parent = await mkdtemp(join(tmpdir(), 'agent-storm-git-diff-'));
    const repo = join(parent, 'repo');
    await git(parent, 'init', 'repo');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test User');
    return {
        parent,
        repo,
    };
}

async function commitAll(repo: string): Promise<void> {
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'fixture');
}

describe('git diff path safety', () => {
    it('rejects absolute, escaping, root, and symlink-escaped paths', async () => {
        const {parent, repo} = await createRepo();
        const outside = join(parent, 'outside.txt');
        await writeFile(outside, 'private\n');
        await symlink(outside, join(repo, 'escape.txt'));

        try {
            await Promise.all(
                [
                    outside,
                    '../outside.txt',
                    '.',
                    'escape.txt',
                ].map(async (path) => {
                    await nodeAssert.rejects(
                        getDiffFileContents({
                            folder: repo,
                            path,
                            oldPath: undefined,
                            side: GitDiffSide.Unstaged,
                        }),
                        /outside the repo/,
                    );
                }),
            );
        } finally {
            await rm(parent, {
                recursive: true,
                force: true,
            });
        }
    });
});

describe(getDiffStatus.name, () => {
    it('keeps staged and unstaged changes separate across file states', async () => {
        const {parent, repo} = await createRepo();
        try {
            await writeFile(join(repo, 'partial.txt'), 'base\n');
            await writeFile(join(repo, 'rename-old.txt'), 'rename\n');
            await writeFile(join(repo, 'deleted.txt'), 'delete\n');
            await commitAll(repo);
            await writeFile(join(repo, 'partial.txt'), 'staged\n');
            await git(repo, 'add', 'partial.txt');
            await writeFile(join(repo, 'partial.txt'), 'working\n');
            await git(repo, 'mv', 'rename-old.txt', 'rename-new.txt');
            await rm(join(repo, 'deleted.txt'));
            await writeFile(join(repo, 'untracked.txt'), 'new\n');

            const status = await getDiffStatus(repo);
            assert.deepEquals(
                {
                    staged: status.staged.map(({path, oldPath, change}) => {
                        return {
                            path,
                            oldPath,
                            change,
                        };
                    }),
                    unstaged: status.unstaged.map(({path, change}) => {
                        return {
                            path,
                            change,
                        };
                    }),
                },
                {
                    staged: [
                        {
                            path: 'partial.txt',
                            oldPath: undefined,
                            change: GitFileChange.Modified,
                        },
                        {
                            path: 'rename-new.txt',
                            oldPath: 'rename-old.txt',
                            change: GitFileChange.Renamed,
                        },
                    ],
                    unstaged: [
                        {
                            path: 'deleted.txt',
                            change: GitFileChange.Deleted,
                        },
                        {
                            path: 'partial.txt',
                            change: GitFileChange.Modified,
                        },
                        {
                            path: 'untracked.txt',
                            change: GitFileChange.Untracked,
                        },
                    ],
                },
            );
        } finally {
            await rm(parent, {
                recursive: true,
                force: true,
            });
        }
    });
});

describe(getDiffFileContents.name, () => {
    it('loads HEAD, index, and worktree content and suppresses binary or oversized files', async () => {
        const {parent, repo} = await createRepo();
        try {
            await writeFile(join(repo, 'text.txt'), 'head\n');
            await commitAll(repo);
            await writeFile(join(repo, 'text.txt'), 'index\n');
            await git(repo, 'add', 'text.txt');
            await writeFile(join(repo, 'text.txt'), 'worktree\n');
            await writeFile(
                join(repo, 'binary.bin'),
                Buffer.from([
                    0,
                    1,
                    2,
                ]),
            );
            await writeFile(join(repo, 'large.txt'), Buffer.alloc(maxDiffFileBytes + 1, 65));

            assert.deepEquals(
                {
                    staged: await getDiffFileContents({
                        folder: repo,
                        path: 'text.txt',
                        oldPath: undefined,
                        side: GitDiffSide.Staged,
                    }),
                    unstaged: await getDiffFileContents({
                        folder: repo,
                        path: 'text.txt',
                        oldPath: undefined,
                        side: GitDiffSide.Unstaged,
                    }),
                    binary: await getDiffFileContents({
                        folder: repo,
                        path: 'binary.bin',
                        oldPath: undefined,
                        side: GitDiffSide.Unstaged,
                    }),
                    large: await getDiffFileContents({
                        folder: repo,
                        path: 'large.txt',
                        oldPath: undefined,
                        side: GitDiffSide.Unstaged,
                    }),
                },
                {
                    staged: {
                        oldContent: 'head\n',
                        newContent: 'index\n',
                        tooLargeOrBinary: false,
                    },
                    unstaged: {
                        oldContent: 'index\n',
                        newContent: 'worktree\n',
                        tooLargeOrBinary: false,
                    },
                    binary: {
                        oldContent: '',
                        newContent: '',
                        tooLargeOrBinary: true,
                    },
                    large: {
                        oldContent: '',
                        newContent: '',
                        tooLargeOrBinary: true,
                    },
                },
            );
        } finally {
            await rm(parent, {
                recursive: true,
                force: true,
            });
        }
    });
});

describe('whole-file git operations', () => {
    it('stages, unstages, and discards tracked, staged-new, untracked, and no-HEAD files', async () => {
        const {parent, repo} = await createRepo();
        try {
            await writeFile(join(repo, 'tracked.txt'), 'base\n');
            await commitAll(repo);
            await writeFile(join(repo, 'tracked.txt'), 'changed\n');
            await setFileStaged({
                folder: repo,
                path: 'tracked.txt',
                side: GitDiffSide.Unstaged,
            });
            assert.matches(await git(repo, 'diff', '--cached', '--', 'tracked.txt'), /changed/);
            await setFileStaged({
                folder: repo,
                path: 'tracked.txt',
                side: GitDiffSide.Staged,
            });
            assert.strictEquals(await git(repo, 'diff', '--cached', '--', 'tracked.txt'), '');

            await writeFile(join(repo, 'new.txt'), 'new\n');
            await setFileStaged({
                folder: repo,
                path: 'new.txt',
                side: GitDiffSide.Unstaged,
            });
            await discardFileChanges({
                folder: repo,
                path: 'new.txt',
            });
            await writeFile(join(repo, 'untracked.txt'), 'untracked\n');
            await discardFileChanges({
                folder: repo,
                path: 'untracked.txt',
            });
            await discardFileChanges({
                folder: repo,
                path: 'tracked.txt',
            });

            const noHead = join(parent, 'no-head');
            await mkdir(noHead);
            await git(noHead, 'init');
            await writeFile(join(noHead, 'first.txt'), 'first\n');
            await setFileStaged({
                folder: noHead,
                path: 'first.txt',
                side: GitDiffSide.Unstaged,
            });
            await setFileStaged({
                folder: noHead,
                path: 'first.txt',
                side: GitDiffSide.Staged,
            });

            assert.deepEquals(
                {
                    tracked: await readFile(join(repo, 'tracked.txt'), 'utf8'),
                    newExists: !!(await stat(join(repo, 'new.txt')).catch(() => undefined)),
                    untrackedExists: !!(await stat(join(repo, 'untracked.txt')).catch(
                        () => undefined,
                    )),
                    noHeadStatus: await git(noHead, 'status', '--porcelain'),
                },
                {
                    tracked: 'base\n',
                    newExists: false,
                    untrackedExists: false,
                    noHeadStatus: '?? first.txt\n',
                },
            );
        } finally {
            await rm(parent, {
                recursive: true,
                force: true,
            });
        }
    });
});

describe(moveHunkAcrossIndex.name, () => {
    it('moves one distant text hunk without its neighbor and rejects stale ranges', async () => {
        const {parent, repo} = await createRepo();
        try {
            const baseLines = createArray(14, (index) => `line ${index + 1}`);
            await writeFile(join(repo, 'hunks.sh'), `${baseLines.join('\n')}\n`, {
                mode: 0o755,
            });
            await commitAll(repo);
            const changedLines = [...baseLines];
            changedLines[1] = 'first changed';
            changedLines[12] = 'second changed';
            await writeFile(join(repo, 'hunks.sh'), changedLines.join('\n'));

            await moveHunkAcrossIndex({
                folder: repo,
                path: 'hunks.sh',
                oldPath: undefined,
                side: GitDiffSide.Unstaged,
                fromOldLine: 1,
                toOldLine: 2,
                fromNewLine: 1,
                toNewLine: 2,
            });
            const staged = await git(repo, 'diff', '--cached', '--', 'hunks.sh');
            const unstaged = await git(repo, 'diff', '--', 'hunks.sh');
            assert.isTrue(staged.includes('first changed'));
            assert.isFalse(staged.includes('second changed'));
            assert.isTrue(unstaged.includes('second changed'));

            await moveHunkAcrossIndex({
                folder: repo,
                path: 'hunks.sh',
                oldPath: undefined,
                side: GitDiffSide.Staged,
                fromOldLine: 1,
                toOldLine: 2,
                fromNewLine: 1,
                toNewLine: 2,
            });
            assert.strictEquals(await git(repo, 'diff', '--cached', '--', 'hunks.sh'), '');
            await nodeAssert.rejects(
                moveHunkAcrossIndex({
                    folder: repo,
                    path: 'hunks.sh',
                    oldPath: undefined,
                    side: GitDiffSide.Unstaged,
                    fromOldLine: 100,
                    toOldLine: 101,
                    fromNewLine: 100,
                    toNewLine: 101,
                }),
                /git apply failed/,
            );
        } finally {
            await rm(parent, {
                recursive: true,
                force: true,
            });
        }
    });
});
