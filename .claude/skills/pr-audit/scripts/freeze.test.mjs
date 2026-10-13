/**
 * The texts `freeze.mjs` writes from what git and `gh` give it.
 *
 *   node --test .claude/skills/pr-audit/scripts/freeze.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
    baseRemote,
    checkHead,
    checkTree,
    freeze,
    intentText,
    localTimestamp,
    parseShortstat,
    pullRequestFrom,
} from './freeze.mjs';

const FACTS = {
    branch: 'feature/prüfung',
    base: 'develop',
    mergeBase: 'a'.repeat(40),
    head: 'b'.repeat(40),
    pr: 7,
    owner: 'owner',
    repo: 'repo',
};

test('the shortstat counts read as numbers, a part git omits as zero', () => {

    // Act
    const full = parseShortstat(' 74 files changed, 12141 insertions(+), 3574 deletions(-)');
    const single = parseShortstat(' 1 file changed, 1 insertion(+)');

    // Assert
    assert.deepEqual(full, {
        filesChanged: 74,
        additions: 12141,
        deletions: 3574,
    });
    assert.deepEqual(single, {
        filesChanged: 1,
        additions: 1,
        deletions: 0,
    });
});

test('the freeze time carries the local offset the renderer accepts', () => {

    // Arrange
    const date = new Date(2026, 8, 25, 9, 20, 11);
    const offset = -date.getTimezoneOffset();
    const expected = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:` +
        `${String(Math.abs(offset) % 60).padStart(2, '0')}`;

    // Act
    const stamp = localTimestamp(date);

    // Assert
    assert.equal(stamp, `2026-09-25T09:20:11${expected}`);
    assert.equal(Date.parse(stamp), date.getTime());
});

test('intent.md holds the facts and the pull request', () => {

    // Act
    const text = intentText(FACTS, {
        title: 'Title',
        body: 'Body\r\nline.\r\n',
    });

    // Assert
    assert.equal(text, [
        '# Review context',
        '',
        '- branch: feature/prüfung',
        '- base: develop',
        `- merge-base: ${'a'.repeat(40)}`,
        `- head: ${'b'.repeat(40)}`,
        '- pr: 7',
        '- repository: owner/repo',
        '',
        '## Pull request',
        '',
        '### Title',
        '',
        'Body\nline.',
        '',
    ].join('\n'));
});

test('intent.md says so when there is no pull request', () => {

    // Act
    const text = intentText({
        ...FACTS,
        pr: null,
    }, null);

    // Assert
    assert.match(text, /^- pr: none$/m);
    assert.match(text, /^## Pull request\n\nNo pull request exists; the commit messages are the only statement of intent\.\n$/m);
});

test('only gh saying there is no pull request means none; any other failure stops the freeze', () => {

    // Act
    const none = pullRequestFrom({
        status: 1,
        stdout: '',
        stderr: 'no pull requests found for branch "feature/x"',
    });
    const found = pullRequestFrom({
        status: 0,
        stdout: '{"number":7}',
        stderr: '',
    });

    // Assert
    assert.equal(none, null);
    assert.equal(found.number, 7);
    assert.throws(() => pullRequestFrom({
        status: 1,
        stdout: '',
        stderr: 'HTTP 401: Bad credentials',
    }), /gh pr view failed: HTTP 401/);
});

test('a HEAD GitHub may not have, or a reviewed file changed in the tree, stops the freeze', () => {

    // Arrange
    const pullRequest = {
        number: 7,
        headRefOid: 'b'.repeat(40),
    };

    // Act and Assert
    assert.throws(() => checkHead('c'.repeat(40), pullRequest, [], [], true), /head of pull request #7/);
    assert.throws(() => checkHead('b'.repeat(40), pullRequest, [
        'a.mjs',
    ], [
        'a.mjs',
        'b.mjs',
    ], true), /differs from HEAD in a\.mjs/);
    assert.throws(() => checkHead('c'.repeat(40), null, [], [], false), /on no remote branch; push it first/);
    checkHead('b'.repeat(40), pullRequest, [
        'other.mjs',
    ], [
        'a.mjs',
    ], true);
    checkHead('c'.repeat(40), null, [], [], true);
});

test('the base is fetched from the remote naming the pull request\'s repository, origin without one', () => {

    // Arrange
    const repository = {
        owner: 'CountZero',
        repo: 'windows_llama.cpp',
    };
    const remotes = [
        {
            name: 'origin',
            url: 'git@github.com:someone/windows_llama.cpp.git',
        },
        {
            name: 'upstream',
            url: 'https://github.com/countzero/windows_llama.cpp.git',
        },
    ];

    // Act and Assert
    assert.equal(baseRemote(remotes, repository), 'upstream');
    assert.equal(baseRemote(remotes.slice(0, 1), repository), 'origin');
    assert.equal(baseRemote([], repository), 'origin');
});

/**
 * Runs git in a directory and fails the test when git does.
 * @param cwd - The directory.
 * @param args - Its arguments.
 * @returns The trimmed stdout.
 */
function gitIn (cwd, ...args) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);

    return result.stdout.trim();
}

/**
 * Commits everything staged, an empty commit allowed.
 * @param repo - The repository.
 * @param message - The commit message.
 */
function commitIn (repo, message) {
    gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '--message', message);
}

/**
 * Stands in for the `gh` lookup: a pull request whose head is HEAD unless
 * another is named, run through the same tree check the live freeze runs.
 * @param mergeBase - The merge-base the diff starts at.
 * @param headRefOid - The pull request's head, HEAD when omitted.
 * @returns The resolver `freeze` takes.
 */
function resolverFor (mergeBase, headRefOid = null) {
    return () => {
        const head = gitIn(process.cwd(), 'rev-parse', 'HEAD');

        checkTree(head, {
            number: 7,
            headRefOid: headRefOid ?? head,
        }, mergeBase);

        return {
            facts: {
                ...FACTS,
                head,
                mergeBase,
                filesChanged: 1,
                additions: 1,
                deletions: 0,
            },
            intent: '# Review context\n',
        };
    };
}

test('the freeze writes git\'s own patch whatever the configuration, an umlaut path included, and empties the directory', () => {

    // Arrange
    const base = mkdtempSync(join(tmpdir(), 'pr-audit-freeze-'));
    const repo = join(base, 'repo');
    const review = join(base, '.tmp', 'sessions', 's1', 'review');
    const cwd = process.cwd();

    mkdirSync(repo);
    gitIn(repo, 'init', '--quiet');
    [
        'diff.noprefix=true',
        'color.diff=always',
        'diff.external=exit',
        'diff.suppressBlankEmpty=true',
        'diff.relative=true',
    ].forEach(setting => {
        const [
            key, value,
        ] = setting.split('=');

        gitIn(repo, 'config', key, value);
    });
    writeFileSync(join(repo, 'base.txt'), 'one\n\nkept\n', 'utf8');
    writeFileSync(join(repo, 'gone.txt'), 'old\n', 'utf8');
    gitIn(repo, 'add', '.');
    commitIn(repo, 'base');

    const mergeBase = gitIn(repo, 'rev-parse', 'HEAD');

    writeFileSync(join(repo, 'base.txt'), 'two\n\nkept\n', 'utf8');
    writeFileSync(join(repo, 'ümlaut.txt'), 'new\n', 'utf8');
    rmSync(join(repo, 'gone.txt'));
    gitIn(repo, 'add', '--all', '.');
    commitIn(repo, 'head');
    mkdirSync(review, {
        recursive: true,
    });
    [
        'candidates-reviewer-3.json',
        'verified-2.json',
        'coverage.json',
    ].forEach(name => {
        writeFileSync(join(review, name), 'stale\n', 'utf8');
    });

    try {
        process.chdir(repo);

        // Act
        freeze(review, resolverFor(mergeBase));

        // Assert
        const manifest = JSON.parse(readFileSync(join(review, 'manifest.json'), 'utf8'));

        const meta = JSON.parse(readFileSync(join(review, 'meta.json'), 'utf8'));

        assert.deepEqual(manifest.chunks.flatMap(chunk => chunk.files), [
            'base.txt',
            'gone.txt',
            'ümlaut.txt',
        ]);
        assert.equal(manifest.chunks.reduce((sum, chunk) => sum + chunk.changedLines, 0), 4);
        const patch = readFileSync(join(review, 'diff.patch'), 'utf8');

        assert.equal(patch.includes('\u001b'), false);
        assert.ok(patch.includes('+two\n \n kept\n'), 'a blank context line keeps its space');
        assert.equal(meta.mergeBase, mergeBase);
        assert.deepEqual(meta.deleted, [
            'gone.txt',
        ]);
        [
            'candidates-reviewer-3.json',
            'verified-2.json',
            'coverage.json',
        ].forEach(name => {
            assert.equal(existsSync(join(review, name)), false, name);
        });
    } finally {
        process.chdir(cwd);
        rmSync(base, {
            recursive: true,
            force: true,
        });
    }
});

test('the freeze refuses a tree dirty in a reviewed file, diff.relative and a subdirectory notwithstanding', () => {

    // Arrange
    const base = mkdtempSync(join(tmpdir(), 'pr-audit-freeze-'));
    const repo = join(base, 'repo');
    const review = join(base, '.tmp', 'sessions', 's1', 'review');
    const cwd = process.cwd();

    mkdirSync(join(repo, 'sub'), {
        recursive: true,
    });
    gitIn(repo, 'init', '--quiet');
    gitIn(repo, 'config', 'diff.relative', 'true');
    writeFileSync(join(repo, 'sub', 'keep.txt'), 'keep\n', 'utf8');
    gitIn(repo, 'add', '.');
    commitIn(repo, 'base');

    const mergeBase = gitIn(repo, 'rev-parse', 'HEAD');

    writeFileSync(join(repo, 'top.txt'), 'committed\n', 'utf8');
    gitIn(repo, 'add', '.');
    commitIn(repo, 'head');
    writeFileSync(join(repo, 'top.txt'), 'edited in the tree\n', 'utf8');

    try {
        process.chdir(join(repo, 'sub'));

        // Act and Assert
        assert.throws(() => freeze(review, resolverFor(mergeBase)), /differs from HEAD in top\.txt/);
        assert.equal(existsSync(join(review, 'diff.patch')), false);
    } finally {
        process.chdir(cwd);
        rmSync(base, {
            recursive: true,
            force: true,
        });
    }
});

const EARLIER_RUN = [
    'candidates-reviewer-1.json',
    'verified.json',
    'coverage.json',
];

/**
 * Builds a repository of two commits and a review directory holding an
 * earlier run.
 * @param headFiles - The files the head commit writes, by name.
 * @returns The scratch root, the repository, the review directory and both commits.
 */
function earlierRunSetup (headFiles) {
    const base = mkdtempSync(join(tmpdir(), 'pr-audit-freeze-'));
    const repo = join(base, 'repo');
    const review = join(base, '.tmp', 'sessions', 's1', 'review');

    mkdirSync(repo);
    gitIn(repo, 'init', '--quiet');
    writeFileSync(join(repo, 'base.txt'), 'one\n', 'utf8');
    gitIn(repo, 'add', '.');
    commitIn(repo, 'base');

    const mergeBase = gitIn(repo, 'rev-parse', 'HEAD');

    Object.entries(headFiles).forEach(([
        name,
        text,
    ]) => writeFileSync(join(repo, name), text, 'utf8'));
    gitIn(repo, 'add', '--all', '.');
    commitIn(repo, 'head');

    const head = gitIn(repo, 'rev-parse', 'HEAD');

    mkdirSync(review, {
        recursive: true,
    });
    EARLIER_RUN.forEach(name => writeFileSync(join(review, name), 'earlier\n', 'utf8'));

    return {
        base,
        repo,
        review,
        mergeBase,
        head,
    };
}

/**
 * Asserts that every file of the earlier run is still in the review directory.
 * @param review - The review directory.
 */
function assertEarlierRunKept (review) {
    EARLIER_RUN.forEach(name => assert.equal(readFileSync(join(review, name), 'utf8'), 'earlier\n', name));
}

test('a freeze refused on HEAD, the tree or an empty diff leaves the earlier run in place', () => {

    // Arrange
    const setup = earlierRunSetup({
        'base.txt': 'two\n',
    });
    const cwd = process.cwd();

    try {
        process.chdir(setup.repo);

        // Act and Assert
        assert.throws(() => freeze(setup.review, resolverFor(setup.mergeBase, setup.mergeBase)),
            /the head of pull request #7 is/);
        assertEarlierRunKept(setup.review);
        assert.throws(() => freeze(setup.review, resolverFor(setup.head)), /the diff is empty/);
        assertEarlierRunKept(setup.review);
        writeFileSync(join(setup.repo, 'base.txt'), 'edited in the tree\n', 'utf8');
        assert.throws(() => freeze(setup.review, resolverFor(setup.mergeBase)), /differs from HEAD in base\.txt/);
        assertEarlierRunKept(setup.review);
        assert.equal(existsSync(join(setup.review, 'diff.patch')), false);
    } finally {
        process.chdir(cwd);
        rmSync(setup.base, {
            recursive: true,
            force: true,
        });
    }
});

test('a review directory that links elsewhere is judged by its target and not emptied', () => {

    // Arrange
    const setup = earlierRunSetup({
        'base.txt': 'two\n',
    });
    const elsewhere = join(setup.base, 'source');
    const link = join(setup.base, '.tmp', 'sessions', 's2', 'review');
    const cwd = process.cwd();

    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'kept.txt'), 'source\n', 'utf8');
    mkdirSync(join(link, '..'), {
        recursive: true,
    });
    symlinkSync(elsewhere, link, 'junction');

    try {
        process.chdir(setup.repo);

        // Act and Assert
        assert.throws(() => freeze(link, resolverFor(setup.mergeBase)), /is not a review directory under \.tmp\/sessions/);
        assert.equal(readFileSync(join(elsewhere, 'kept.txt'), 'utf8'), 'source\n');
    } finally {
        process.chdir(cwd);
        rmSync(setup.base, {
            recursive: true,
            force: true,
        });
    }
});

test('the freeze refuses a directory other than a review under .tmp/sessions/<id>/, since it empties it', () => {

    // Arrange
    const refused = [
        join(tmpdir(), 'not-a-review-dir'),
        join(tmpdir(), 'presets', 'review'),
        join(tmpdir(), '.tmp', 'review'),
        join(tmpdir(), '.tmp', 'sessions', 'review'),
    ];

    // Act and Assert
    refused.forEach(dir => assert.throws(() => freeze(dir), /is not a review directory under \.tmp\/sessions/, dir));
});
