#!/usr/bin/env node
/**
 * Freezes the inputs of a review: resolves the pull request, its base and
 * the merge-base, writes `diff.patch`, `meta.json` and `intent.md`, splits
 * the diff into chunks and prints the reviewers' Task prompts.
 *
 *   node freeze.mjs .tmp/sessions/SESSION/review
 *
 * The pull request's title and body are the only statement of intent the
 * reviewers get; this repository has no ticket tracker.
 *
 * Every text is written by this process as UTF-8. Through a German Windows
 * console, which decodes in CP-850, an umlaut would reach the file as
 * mojibake no check sees; git's and `gh`'s output is read through a pipe and
 * never passes the console, and the patch is written as the bytes git gave.
 * `intent.md` is not named `context.md`: OpenCode injects a `CONTEXT.md` of
 * any directory, case ignored on Windows, into every session that reads a
 * sibling file, decoded in the console code page.
 *
 * The review directory is emptied only once every check has held, so a
 * refused freeze leaves an earlier run's candidates and verdicts in place.
 *
 * Exits 1 on any failure, the reason on stderr.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { isMainModule } from './main_module.mjs';
import { reviewerPrompt } from './prompts.mjs';
import { checkDiff, writeChunks } from './split_diff.mjs';

const DEFAULT_BASE = 'develop';
const EXIT_FAILED = 1;
const JSON_INDENT = 4;
const OFFSET_MINUTES = 60;
const PAD = 2;

/*
 * The diff is the patch git writes whatever the user's configuration says:
 * `diff.external` would replace it with a tool's output, `color.diff=always`
 * fill it with escapes, `diff.noprefix` drop the `a/` and `b/` the chunks are
 * cut at, `core.quotePath` octal-escape every non-ASCII path, and
 * `diff.suppressBlankEmpty` write a blank context line as an empty line,
 * which the chunks' hunk-line count would take for no line at all.
 */
const DIFF_OPTIONS = [
    '-c',
    'core.quotePath=false',
    '-c',
    'diff.suppressBlankEmpty=false',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--no-relative',
    '--src-prefix=a/',
    '--dst-prefix=b/',
];

const REVIEW_DIR_NAME = 'review';
const SCRATCH_REVIEW = /\/\.tmp\/sessions\/[^/]+\/(?:[^/]+\/)*review$/;
const NO_PULL_REQUEST = /no pull requests? found/i;
const DEFAULT_REMOTE = 'origin';

/*
 * Node's default of 1 MiB would fail a large diff, or the name list of a large
 * pull request, as a bare `git … failed`.
 */
const SPAWN_OPTIONS = {
    windowsHide: true,
    maxBuffer: Infinity,
};

/**
 * Runs a command, decoded as UTF-8.
 * @param command - The executable.
 * @param args - Its arguments.
 * @returns Its exit status, trimmed stdout and trimmed stderr.
 */
function execute (command, args) {
    const result = spawnSync(command, args, {
        ...SPAWN_OPTIONS,
        encoding: 'utf8',
    });

    return {
        status: result.status,
        stdout: (result.stdout ?? '').trim(),
        stderr: (result.stderr ?? result.error?.message ?? '').trim(),
    };
}

/**
 * Runs git and returns its output as the bytes it wrote, untrimmed.
 * @param args - Its arguments.
 * @returns The stdout.
 */
function gitBytes (...args) {
    const result = spawnSync('git', args, SPAWN_OPTIONS);

    if (result.status !== 0) {
        const reason = (result.stderr ?? result.error?.message ?? '').toString().trim();

        throw new Error(`git ${args.join(' ')} failed: ${reason}`);
    }

    return result.stdout;
}

/**
 * Runs a command and returns its output.
 * @param command - The executable.
 * @param args - Its arguments.
 * @returns The trimmed stdout, or null when the command failed.
 */
function run (command, args) {
    const result = execute(command, args);

    return result.status === 0 ? result.stdout : null;
}

/**
 * Runs git and fails the freeze when git does.
 * @param args - Its arguments.
 * @returns The trimmed stdout.
 */
function git (...args) {
    const output = run('git', args);

    if (output === null) {
        throw new Error(`git ${args.join(' ')} failed`);
    }

    return output;
}

/**
 * Formats a time as `YYYY-MM-DDTHH:MM:SS±HH:MM` in the local zone.
 * @param date - The time.
 * @returns The timestamp.
 */
function localTimestamp (date) {
    const two = value => String(value).padStart(PAD, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset < 0 ? '-' : '+';
    const hours = Math.floor(Math.abs(offset) / OFFSET_MINUTES);
    const minutes = Math.abs(offset) % OFFSET_MINUTES;

    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
        `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}` +
        `${sign}${two(hours)}:${two(minutes)}`;
}

/**
 * Reads the counts out of `git diff --shortstat`, a part git omits being zero.
 * @param text - Its output.
 * @returns The files changed, the additions and the deletions.
 */
function parseShortstat (text) {
    const number = pattern => Number(pattern.exec(text)?.[1] ?? 0);

    return {
        filesChanged: number(/(\d+) files? changed/),
        additions: number(/(\d+) insertions?\(\+\)/),
        deletions: number(/(\d+) deletions?\(-\)/),
    };
}

/**
 * Reads what `gh pr view` answered. Only its word that the branch has no pull
 * request means none: a failed login or network exits with the same status,
 * and read as none it would review against `develop` without the body.
 * @param result - Its exit status, stdout and stderr.
 * @returns The pull request, or null when there is none.
 */
function pullRequestFrom (result) {
    if (result.status === 0) {
        return JSON.parse(result.stdout);
    }

    if (NO_PULL_REQUEST.test(result.stderr)) {
        return null;
    }

    throw new Error(`gh pr view failed: ${result.stderr || `exit ${result.status}`}`);
}

/**
 * Reads the current branch's pull request through `gh`.
 * @returns Its number, base, state, head, title and body, or null when there is none.
 */
function readPullRequest () {
    return pullRequestFrom(execute('gh', [
        'pr',
        'view',
        '--json',
        'number,baseRefName,headRefOid,state,title,body',
    ]));
}

/**
 * Refuses a HEAD the report's links and the reviewers' line numbers would not
 * hold for: one GitHub may not have, being not the pull request's head or,
 * without a pull request, on no remote branch; or a working tree that differs
 * from it in a file the diff changes, since the reviewers read the tree and
 * the links point at the commit. A change to another file passes: the
 * working tree is shared, and another agent's work in progress would
 * otherwise block every review.
 * @param head - HEAD's commit.
 * @param pullRequest - The pull request, or null.
 * @param dirty - The tracked files that differ from HEAD.
 * @param changed - The files the diff changes.
 * @param pushed - Whether a remote branch holds HEAD.
 */
function checkHead (head, pullRequest, dirty, changed, pushed) {
    if (pullRequest !== null && pullRequest.headRefOid !== head) {
        throw new Error(`HEAD is ${head}, the head of pull request #${pullRequest.number} is ` +
            `${pullRequest.headRefOid}; push HEAD or check out the pull request's head`);
    }

    if (pullRequest === null && !pushed) {
        throw new Error(`HEAD ${head} is on no remote branch; push it first, since the report links it on GitHub`);
    }

    const reviewed = new Set(changed);
    const files = dirty.filter(file => reviewed.has(file));

    if (files.length > 0) {
        throw new Error(`the working tree differs from HEAD in ${files.join(', ')}, which the diff changes; ` +
            'commit or set them aside first, since the reviewers read the tree and the report links the commit');
    }
}

/**
 * Splits git's `-z` output into its paths.
 * @param output - The output.
 * @returns The paths.
 */
const pathList = output => output.split('\0').filter(path => path !== '');

/**
 * Runs `checkHead` on the working tree. Both lists go through the diff's own
 * options: a `diff.relative` the user configured would otherwise leave every
 * dirty file outside the current directory unseen.
 * @param head - HEAD's commit.
 * @param pullRequest - The pull request, or null.
 * @param mergeBase - The merge-base the diff starts at.
 */
function checkTree (head, pullRequest, mergeBase) {
    checkHead(
        head,
        pullRequest,
        pathList(git(...DIFF_OPTIONS, '--name-only', '-z', head)),
        pathList(git(...DIFF_OPTIONS, '--name-only', '-z', mergeBase, head)),
        pullRequest !== null || git('branch', '--remotes', '--contains', head) !== ''
    );
}

/**
 * Resolves a path through every link in the part of it that exists, so a
 * `review` that is a link or a junction is judged by the directory it points at.
 * @param path - An absolute path.
 * @returns The path with its existing part resolved.
 */
function realPath (path) {
    const missing = [];
    let existing = path;

    while (!existsSync(existing) && dirname(existing) !== existing) {
        missing.unshift(basename(existing));
        existing = dirname(existing);
    }

    return join(realpathSync.native(existing), ...missing);
}

/**
 * Refuses a review directory the freeze may not empty. It must be a `review`
 * below a session's scratch, `.tmp/sessions/<id>/`, once its links are
 * resolved, so a mistyped path or a link empties no source directory and no
 * other `review`. A mistyped id that names another existing session is not
 * caught: nothing here knows which session is the caller's.
 * @param reviewDir - The absolute review directory.
 * @returns The directory with its links resolved.
 */
function checkReviewDir (reviewDir) {
    const real = realPath(reviewDir);

    if (basename(real) !== REVIEW_DIR_NAME || !SCRATCH_REVIEW.test(real.replace(/\\/g, '/'))) {
        throw new Error(`${reviewDir} is not a ${REVIEW_DIR_NAME} directory under .tmp/sessions/<id>/; ` +
            'the freeze empties it and refuses another');
    }

    return real;
}

/**
 * Empties the review directory of an earlier run; nothing in it is kept.
 * @param reviewDir - A directory `checkReviewDir` accepted, created when missing.
 */
function clearReviewDir (reviewDir) {
    mkdirSync(reviewDir, {
        recursive: true,
    });

    for (const name of readdirSync(reviewDir)) {
        rmSync(join(reviewDir, name), {
            recursive: true,
            force: true,
        });
    }
}

/**
 * Reads the owner and the name of a GitHub repository out of a remote's URL.
 * @param url - The URL, HTTPS or SSH.
 * @returns The owner and the repository name, or null for another shape.
 */
function repositoryOfUrl (url) {
    const match = (/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/).exec(url);

    return match === null ? null : {
        owner: match[1],
        repo: match[2],
    };
}

/**
 * Names the repository on GitHub, from `gh` or else from the remote's URL.
 * @returns The owner and the repository name.
 */
function readRepository () {
    const output = run('gh', [
        'repo',
        'view',
        '--json',
        'owner,name',
    ]);

    if (output !== null) {
        const { owner, name } = JSON.parse(output);

        return {
            owner: owner.login,
            repo: name,
        };
    }

    const repository = repositoryOfUrl(git('remote', 'get-url', DEFAULT_REMOTE));

    if (repository === null) {
        throw new Error(`cannot tell the repository from the remote ${DEFAULT_REMOTE}`);
    }

    return repository;
}

/**
 * Picks the remote the base is fetched from: the one whose URL names the
 * pull request's repository, since in a fork's clone `origin` is the fork,
 * whose base branch can lag the one the pull request merges into.
 * @param remotes - Each remote's name and URL.
 * @param repository - The repository's owner and name.
 * @returns The remote's name, `origin` when none names the repository.
 */
function baseRemote (remotes, repository) {
    const same = (left, right) => left.toLowerCase() === right.toLowerCase();
    const match = remotes.find(remote => {
        const named = repositoryOfUrl(remote.url);

        return named !== null && same(named.owner, repository.owner) && same(named.repo, repository.repo);
    });

    return match?.name ?? DEFAULT_REMOTE;
}

/**
 * Lists the remotes of the repository.
 * @returns Each remote's name and URL.
 */
function readRemotes () {
    return git('remote').split('\n').filter(name => name !== '').map(name => ({
        name,
        url: git('remote', 'get-url', name),
    }));
}

/**
 * Words `intent.md`.
 * @param facts - The run's facts and the merge-base.
 * @param pullRequest - The pull request, or null.
 * @returns The file's text.
 */
function intentText (facts, pullRequest) {
    const body = pullRequest === null ?
        'No pull request exists; the commit messages are the only statement of intent.' :
        `### ${pullRequest.title}\n\n${pullRequest.body.replace(/\r\n?/g, '\n').trim()}`;

    return [
        '# Review context',
        '',
        `- branch: ${facts.branch}`,
        `- base: ${facts.base}`,
        `- merge-base: ${facts.mergeBase}`,
        `- head: ${facts.head}`,
        `- pr: ${facts.pr ?? 'none'}`,
        `- repository: ${facts.owner}/${facts.repo}`,
        '',
        '## Pull request',
        '',
        body,
        '',
    ].join('\n');
}

/**
 * Reads the current branch's pull request and refuses a closed or merged one.
 * @returns The pull request, or null when there is none.
 */
function openPullRequest () {
    const pullRequest = readPullRequest();

    if (pullRequest !== null && pullRequest.state !== 'OPEN') {
        throw new Error(`pull request #${pullRequest.number} is ${pullRequest.state.toLowerCase()}; nothing to review`);
    }

    return pullRequest;
}

/**
 * Takes the base and the number from the pull request, `develop` without one.
 * @param pullRequest - The pull request, or null.
 * @returns The base branch and the pull request number.
 */
function pullRequestFacts (pullRequest) {
    return pullRequest === null ? {
        base: DEFAULT_BASE,
        pr: null,
    } : {
        base: pullRequest.baseRefName,
        pr: pullRequest.number,
    };
}

/**
 * Resolves the facts of the pull request and words its `intent.md`, writing
 * nothing.
 * @returns The facts `meta.json` carries, the merge-base among them, and the intent.
 */
function freezeLive () {
    const branch = git('branch', '--show-current');
    const pullRequest = openPullRequest();
    const { base, pr } = pullRequestFacts(pullRequest);
    const repository = readRepository();
    const remote = baseRemote(readRemotes(), repository);

    git('fetch', remote, base);

    const head = git('rev-parse', 'HEAD');
    const mergeBase = git('merge-base', `${remote}/${base}`, head);

    checkTree(head, pullRequest, mergeBase);

    const facts = {
        branch,
        base,
        head,
        pr,
        ...repository,
        ...parseShortstat(git(...DIFF_OPTIONS, '--shortstat', mergeBase, head)),
        mergeBase,
    };

    return {
        facts,
        intent: intentText(facts, pullRequest),
    };
}

/**
 * Freezes a review directory. Everything is resolved and checked first, the
 * diff included, and only then is the directory emptied and written.
 * @param reviewDir - The review directory, created when missing.
 * @param resolveFacts - Resolves the facts and the intent; the tests pass one
 * that needs no `gh`.
 * @returns The chunk count, the changed lines and one prompt per reviewer.
 */
function freeze (reviewDir, resolveFacts = freezeLive) {
    const real = checkReviewDir(resolve(reviewDir));
    const { facts, intent } = resolveFacts();

    /*
     * The commit HEAD resolved to, not `HEAD`: a commit or checkout in the
     * shared working tree meanwhile would give a diff of another commit than
     * the one `meta.json` records and the report links.
     */
    const patch = gitBytes(...DIFF_OPTIONS, facts.mergeBase, facts.head);
    const deleted = pathList(git(...DIFF_OPTIONS, '--name-only', '--diff-filter=D', '-z', facts.mergeBase, facts.head));

    checkDiff(patch.toString('utf8'));
    clearReviewDir(real);
    writeFileSync(join(real, 'intent.md'), intent, 'utf8');
    writeFileSync(join(real, 'diff.patch'), patch);
    writeFileSync(join(real, 'meta.json'), `${JSON.stringify({
        ...facts,
        deleted,
        frozenAt: localTimestamp(new Date()),
    }, null, JSON_INDENT)}\n`, 'utf8');

    const manifest = writeChunks(real);

    return {
        chunks: manifest.chunks.length,
        changedLines: manifest.chunks.reduce((sum, chunk) => sum + chunk.changedLines, 0),
        reviewers: manifest.reviewers.map(assignment => ({
            reviewer: assignment.reviewer,
            prompt: reviewerPrompt(reviewDir, assignment),
        })),
    };
}

/**
 * Runs the freeze from the command line.
 * @param argv - The arguments after the script path.
 */
function main (argv) {
    if (argv.length !== 1) {
        process.stderr.write('usage: node freeze.mjs <review dir>\n');
        process.exitCode = EXIT_FAILED;

        return;
    }

    try {
        const result = freeze(resolve(argv[0]));

        process.stdout.write(`${JSON.stringify(result, null, JSON_INDENT)}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
        process.exitCode = EXIT_FAILED;
    }
}

if (isMainModule(import.meta.url)) {
    main(process.argv.slice(2));
}

export {
    baseRemote,
    checkHead,
    checkTree,
    freeze,
    intentText,
    localTimestamp,
    parseShortstat,
    pullRequestFrom,
};
