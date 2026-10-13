/**
 * The chunking of `split_diff.mjs`.
 *
 *   node --test .claude/skills/pr-audit/scripts/split_diff.test.mjs
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkCoverage, gate, reviewersOf, shardsOf, splitDiff, writeChunks } from './split_diff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const READ_BYTES = 50_000;
const READ_LINES = 2_000;
const READ_LINE_CHARACTERS = 2_000;
const XXL_FIXTURE_BYTES = 1_900_000;
const WHOLE_DIFF_REVIEWERS = 2;

const fileDiff = (path, hunks, linesPerHunk) => [
    `diff --git a/${path} b/${path}`,
    'index 0000000..1111111 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    ...Array.from({
        length: hunks,
    }, (_, hunk) => [
        `@@ -${hunk * 100 + 1},0 +${hunk * 100 + 1},${linesPerHunk} @@`,
        ...Array.from({
            length: linesPerHunk,
        }, (__, line) => `+const value${hunk}_${line} = 'a line of code that takes some room in the chunk';`),
    ]).flat(),
].join('\n');

let counter = 0;
const token = () => {
    counter += 1;

    return `t${counter}`;
};

const changedIn = text => text.split('\n').filter(line => (/^\+const /).test(line)).length;

test('a small diff is one chunk ending in its token', () => {

    // Arrange
    const diff = `${fileDiff('a.ts', 1, 3)}\n`;

    // Act
    const chunks = splitDiff(diff, token);

    // Assert
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].files, [
        'a.ts',
    ]);
    assert.equal(chunks[0].changedLines, 3);
    assert.match(chunks[0].text, new RegExp(`token ${chunks[0].token}\\n$`));
});

test('a large diff splits into chunks one Read call returns whole, losing no line', () => {

    // Arrange
    const diff = [
        fileDiff('small.ts', 1, 10),
        fileDiff('big.ts', 40, 60),
        fileDiff('huge_hunk.sql', 1, 3000),
        fileDiff('tail.ts', 2, 5),
    ].join('\n');

    // Act
    const chunks = splitDiff(diff, token);

    // Assert
    assert.ok(chunks.length > 3);
    chunks.forEach(chunk => {
        assert.ok(chunk.bytes < READ_BYTES, `${chunk.name} has ${chunk.bytes} bytes`);
        assert.ok(chunk.text.split('\n').length < READ_LINES, chunk.name);
        assert.ok(chunk.text.trimEnd().endsWith(`token ${chunk.token}`), chunk.name);
    });
    assert.equal(chunks.reduce((sum, chunk) => sum + changedIn(chunk.text), 0), changedIn(diff));
    assert.equal(new Set(chunks.map(chunk => chunk.token)).size, chunks.length);
});

test('a path git quoted opens a section of its own under its real name', () => {

    // Arrange
    const diff = [
        fileDiff('a.ts', 1, 2),
        'diff --git "a/\\303\\274mlaut.txt" "b/\\303\\274mlaut.txt"',
        'new file mode 100644',
        '--- /dev/null',
        '+++ "b/\\303\\274mlaut.txt"',
        '@@ -0,0 +1 @@',
        '+new',
    ].join('\n');

    // Act
    const [
        chunk,
    ] = splitDiff(diff, token);

    // Assert
    assert.deepEqual(chunk.files, [
        'a.ts',
        'ümlaut.txt',
    ]);
    assert.equal(chunk.changedLines, 3);
});

test('an unquoted path holding " b/" is read whole, a rename by its new name', () => {

    // Arrange
    const diff = [
        'diff --git a/d b/f.txt b/d b/f.txt',
        '--- a/d b/f.txt',
        '+++ b/d b/f.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/old.txt b/new.txt',
        'similarity index 90%',
        'rename from old.txt',
        'rename to new.txt',
    ].join('\n');

    // Act
    const [
        chunk,
    ] = splitDiff(diff, token);

    // Assert
    assert.deepEqual(chunk.files, [
        'd b/f.txt',
        'new.txt',
    ]);
});

test('a changed line that reads like a file header is counted, the headers are not', () => {

    // Arrange
    const diff = [
        'diff --git a/q.sql b/q.sql',
        '--- a/q.sql',
        '+++ b/q.sql',
        '@@ -1,2 +1,2 @@',
        '--- a/foo',
        '+++ b/x',
        ' kept',
        'diff --git a/bin.png b/bin.png',
        'Binary files a/bin.png and b/bin.png differ',
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-gone',
        '\\ No newline at end of file',
    ].join('\n');

    // Act
    const [
        chunk,
    ] = splitDiff(diff, token);

    // Assert
    assert.equal(chunk.changedLines, 3);
    assert.deepEqual(chunk.files, [
        'q.sql',
        'bin.png',
        'gone.txt',
    ]);
});

test('a patch without a diff --git line is refused before any chunk is written', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    writeFileSync(join(dir, 'diff.patch'), '\x1b[1mdiff a.ts\x1b[m\n', 'utf8');

    try {

        // Act and Assert
        assert.throws(() => writeChunks(dir), /holds no `diff --git` line/);
        assert.equal(existsSync(join(dir, 'chunks')), false);
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

test('a file split across chunks names itself in every part', () => {

    // Arrange
    const diff = fileDiff('big.ts', 40, 60);

    // Act
    const chunks = splitDiff(diff, token);

    // Assert
    assert.ok(chunks.length > 1);
    chunks.forEach(chunk => {
        assert.deepEqual(chunk.files, [
            'big.ts',
        ]);
        assert.match(chunk.text, /^diff --git a\/big\.ts b\/big\.ts$/m);
    });
    assert.match(chunks[1].text, /^# continued: big\.ts$/m);
});

const tokenOf = (dir, name) => (/token ([0-9a-f]+)\n$/).exec(readFileSync(join(dir, 'chunks', name), 'utf8'))[1];

const coverageFile = listed => JSON.stringify({
    candidates: [],
    design: [],
    coverage: listed,
});

const listedOf = (dir, names) => names.map(name => ({
    chunk: name,
    token: tokenOf(dir, name),
}));

const chunkOf = (name, bytes, file) => ({
    name,
    bytes,
    files: [
        file,
    ],
});

const LIMITS = {
    whole: 100,
    shard: 100,
};

test('a diff up to the whole-diff limit stays one shard', () => {

    // Arrange
    const chunks = [
        chunkOf('chunk-01.patch', 40, 'application/client/a.ts'),
        chunkOf('chunk-02.patch', 40, 'application/server/b.ts'),
    ];

    // Act
    const shards = shardsOf(chunks, {
        whole: 100,
        shard: 50,
    });

    // Assert
    assert.deepEqual(shards, [
        [
            'chunk-01.patch',
            'chunk-02.patch',
        ],
    ]);
});

test('a larger diff splits into shards of one size, closing early where a new module starts', () => {

    // Arrange
    const chunks = [
        chunkOf('chunk-01.patch', 40, 'application/client/libraries/a.ts'),
        chunkOf('chunk-02.patch', 40, 'application/client/libraries/b.ts'),
        chunkOf('chunk-03.patch', 40, 'application/server/services/c.ts'),
        chunkOf('chunk-04.patch', 40, 'application/server/services/d.ts'),
        chunkOf('chunk-05.patch', 40, 'application/server/services/e.ts'),
    ];

    // Act
    const shards = shardsOf(chunks, LIMITS);

    // Assert
    assert.deepEqual(shards, [
        [
            'chunk-01.patch',
            'chunk-02.patch',
        ],
        [
            'chunk-03.patch',
            'chunk-04.patch',
            'chunk-05.patch',
        ],
    ]);
});

test('a last shard under half the target joins the one before it', () => {

    // Arrange
    const chunks = [
        chunkOf('chunk-01.patch', 90, 'a/b/c.ts'),
        chunkOf('chunk-02.patch', 90, 'a/b/d.ts'),
        chunkOf('chunk-03.patch', 30, 'a/b/e.ts'),
    ];

    // Act
    const shards = shardsOf(chunks, LIMITS);

    // Assert
    assert.deepEqual(shards, [
        [
            'chunk-01.patch',
        ],
        [
            'chunk-02.patch',
            'chunk-03.patch',
        ],
    ]);
});

test('a file split over two chunks stays in one shard where the boundary would fall between them', () => {

    // Arrange
    const chunks = [
        chunkOf('chunk-01.patch', 60, 'a/b/c.ts'),
        chunkOf('chunk-02.patch', 30, 'a/b/d.ts'),
        chunkOf('chunk-03.patch', 30, 'a/b/d.ts'),
        chunkOf('chunk-04.patch', 60, 'a/b/e.ts'),
    ];

    // Act
    const shards = shardsOf(chunks, LIMITS);

    // Assert
    assert.deepEqual(shards, [
        [
            'chunk-01.patch',
        ],
        [
            'chunk-02.patch',
            'chunk-03.patch',
        ],
        [
            'chunk-04.patch',
        ],
    ]);
});

test('a file larger than a shard takes is split at its chunks', () => {

    // Arrange
    const chunks = [
        chunkOf('chunk-01.patch', 90, 'a/b/c.ts'),
        chunkOf('chunk-02.patch', 90, 'a/b/c.ts'),
    ];

    // Act
    const shards = shardsOf(chunks, LIMITS);

    // Assert
    assert.deepEqual(shards, [
        [
            'chunk-01.patch',
        ],
        [
            'chunk-02.patch',
        ],
    ]);
});

test('a chain of files each continuing into the next chunk, larger than a shard takes, is cut at its chunks', () => {

    // Arrange
    const chunks = [
        {
            name: 'chunk-01.patch',
            bytes: 70,
            files: [
                'a/b/c.ts',
                'a/b/d.ts',
            ],
        },
        {
            name: 'chunk-02.patch',
            bytes: 20,
            files: [
                'a/b/d.ts',
                'a/b/e.ts',
            ],
        },
        chunkOf('chunk-03.patch', 70, 'a/b/e.ts'),
    ];

    // Act
    const shards = shardsOf(chunks, LIMITS);

    // Assert
    assert.deepEqual(shards, [
        [
            'chunk-01.patch',
            'chunk-02.patch',
        ],
        [
            'chunk-03.patch',
        ],
    ]);
});

test('a --check after the directory checks, and an unknown argument is refused', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));
    const run = argv => spawnSync(process.execPath, [
        join(HERE, 'split_diff.mjs'),
        ...argv,
    ], {
        encoding: 'utf8',
    });

    try {
        writeFileSync(join(dir, 'diff.patch'), fileDiff('a.ts', 1, 3), 'utf8');
        writeChunks(dir);

        const manifest = readFileSync(join(dir, 'manifest.json'), 'utf8');

        // Act
        const checked = run([
            dir,
            '--check',
        ]);
        const refused = run([
            dir,
            '--bogus',
        ]);

        // Assert
        assert.equal(checked.status, 0, checked.stderr);
        assert.equal(existsSync(join(dir, 'coverage.json')), true);
        assert.equal(readFileSync(join(dir, 'manifest.json'), 'utf8'), manifest);
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, /^usage: /);
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

test('a diff read whole goes to two reviewers, a larger one shard by shard to one each', () => {

    // Arrange
    const small = [
        chunkOf('chunk-01.patch', 40, 'a/b/c.ts'),
    ];
    const large = [
        chunkOf('chunk-01.patch', 90, 'a/b/c.ts'),
        chunkOf('chunk-02.patch', 90, 'a/b/d.ts'),
        chunkOf('chunk-03.patch', 90, 'a/b/e.ts'),
    ];

    // Act
    const whole = reviewersOf(small, LIMITS);
    const sharded = reviewersOf(large, LIMITS);

    // Assert
    assert.deepEqual(whole, [
        {
            reviewer: 1,
            chunks: [
                'chunk-01.patch',
            ],
        },
        {
            reviewer: 2,
            chunks: [
                'chunk-01.patch',
            ],
        },
    ]);
    assert.deepEqual(sharded.map(entry => entry.chunks), [
        [
            'chunk-01.patch',
        ],
        [
            'chunk-02.patch',
        ],
        [
            'chunk-03.patch',
        ],
    ]);
});

test('the coverage check holds each reviewer to its own shard and names what no one read', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    try {
        writeFileSync(join(dir, 'diff.patch'), fileDiff('big.ts', 40, 60), 'utf8');

        const manifest = writeChunks(dir);
        const half = Math.ceil(manifest.chunks.length / 2);
        const names = manifest.chunks.map(chunk => chunk.name);

        manifest.reviewers = [
            {
                reviewer: 1,
                chunks: names.slice(0, half),
            },
            {
                reviewer: 2,
                chunks: names.slice(half),
            },
        ];
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
        const listed = listedOf(dir, names);

        writeFileSync(join(dir, 'candidates-reviewer-1.json'), coverageFile(listed), 'utf8');

        // Act
        const coverage = checkCoverage(dir);

        // Assert
        assert.deepEqual(coverage.reviewers[1], {
            read: half,
            missed: [],
            problems: [],
        });
        assert.equal(coverage.reviewers[2], null);
        assert.deepEqual(coverage.unread.map(chunk => chunk.name), names.slice(half));
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

test('the coverage check names the chunks no reviewer showed the token of', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    try {
        writeFileSync(join(dir, 'diff.patch'), fileDiff('big.ts', 40, 60), 'utf8');

        const { chunks } = writeChunks(dir);

        writeFileSync(join(dir, 'candidates-reviewer-1.json'), coverageFile(listedOf(dir, [
            chunks[0].name,
        ])), 'utf8');

        // Act
        const coverage = checkCoverage(dir);

        // Assert
        assert.equal(coverage.chunks, chunks.length);
        assert.equal(coverage.reviewers[1].read, 1);
        assert.equal(coverage.reviewers[2], null);
        assert.deepEqual(coverage.unread.map(chunk => chunk.name), chunks.slice(1).map(chunk => chunk.name));
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

test('the manifest holds no token, only a hash a listed token is checked against', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    try {
        writeFileSync(join(dir, 'diff.patch'), fileDiff('big.ts', 40, 60), 'utf8');

        // Act
        writeChunks(dir);

        const manifest = readFileSync(join(dir, 'manifest.json'), 'utf8');
        const { chunks } = JSON.parse(manifest);

        // Assert
        chunks.forEach(chunk => {
            assert.equal(manifest.includes(tokenOf(dir, chunk.name)), false, chunk.name);
            assert.equal(chunk.token, undefined);
        });
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

const withReviewers = (dir, split) => {
    const manifest = writeChunks(dir);
    const names = manifest.chunks.map(chunk => chunk.name);
    const half = Math.ceil(names.length / 2);

    manifest.reviewers = split ? [
        {
            reviewer: 1,
            chunks: names.slice(0, half),
        },
        {
            reviewer: 2,
            chunks: names.slice(half),
        },
    ] : [
        {
            reviewer: 1,
            chunks: names,
        },
        {
            reviewer: 2,
            chunks: names,
        },
    ];
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    return {
        names,
        half,
    };
};

test('a reviewer file the schema refuses counts as read nowhere and its problems reach the resume', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    try {
        writeFileSync(join(dir, 'diff.patch'), fileDiff('big.ts', 40, 60), 'utf8');

        const { names } = withReviewers(dir, false);

        writeFileSync(join(dir, 'candidates-reviewer-1.json'), '{"candidates": [], "design": [], ', 'utf8');
        writeFileSync(join(dir, 'candidates-reviewer-2.json'), coverageFile(listedOf(dir, names)), 'utf8');

        // Act
        const coverage = checkCoverage(dir);
        const next = gate(dir, coverage);

        // Assert
        assert.equal(coverage.reviewers[1].read, 0);
        assert.match(coverage.reviewers[1].problems[0], /^candidates-reviewer-1\.json: not JSON/);
        assert.deepEqual(coverage.unread, []);
        assert.match(
            next.resume[0].prompt,
            /^The format check refused your output file: candidates-reviewer-1\.json: not JSON/
        );
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

test('the gate resumes a reviewer that missed chunks and words one verifier for a diff read whole', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    try {
        writeFileSync(join(dir, 'diff.patch'), fileDiff('big.ts', 40, 60), 'utf8');

        const { names } = withReviewers(dir, false);

        writeFileSync(join(dir, 'candidates-reviewer-1.json'), coverageFile(listedOf(dir, names)), 'utf8');
        writeFileSync(join(dir, 'candidates-reviewer-2.json'), coverageFile(listedOf(dir, names.slice(0, 1))), 'utf8');

        // Act
        const next = gate(dir, checkCoverage(dir));

        // Assert
        assert.deepEqual(next.unread, []);
        assert.deepEqual(next.failed, []);
        assert.deepEqual(next.resume.map(entry => entry.reviewer), [
            2,
        ]);
        assert.match(next.resume[0].prompt, new RegExp(`read these chunks to their last line: ${names[1]}, `));
        assert.deepEqual(next.verifiers.map(entry => entry.output), [
            'verified.json',
        ]);
        assert.match(next.verifiers[0].prompt, /candidates-reviewer-1\.json, .*candidates-reviewer-2\.json/);
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

test('the gate words one verifier per shard, none for a reviewer that wrote no file', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    try {
        writeFileSync(join(dir, 'diff.patch'), fileDiff('big.ts', 40, 60), 'utf8');

        const { names, half } = withReviewers(dir, true);

        writeFileSync(join(dir, 'candidates-reviewer-1.json'), coverageFile(listedOf(dir, names.slice(0, half))), 'utf8');

        // Act
        const next = gate(dir, checkCoverage(dir));

        // Assert
        assert.deepEqual(next.failed, [
            2,
        ]);
        assert.deepEqual(next.unread, names.slice(half));
        assert.deepEqual(next.verifiers.map(entry => entry.output), [
            'verified-1.json',
        ]);
        assert.doesNotMatch(next.verifiers[0].prompt, /candidates-reviewer-2/);
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

test('the gate words no verifier when no reviewer wrote a file', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    try {
        writeFileSync(join(dir, 'diff.patch'), fileDiff('a.ts', 1, 3), 'utf8');
        withReviewers(dir, false);

        // Act
        const next = gate(dir, checkCoverage(dir));

        // Assert
        assert.deepEqual(next.verifiers, []);
        assert.deepEqual(next.failed, [
            1,
            2,
        ]);
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

test('the check records in coverage.json the verifier files the gate asks for', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    try {
        writeFileSync(join(dir, 'diff.patch'), fileDiff('big.ts', 40, 60), 'utf8');

        const { names, half } = withReviewers(dir, true);

        writeFileSync(join(dir, 'candidates-reviewer-2.json'), coverageFile(listedOf(dir, names.slice(half))), 'utf8');

        // Act
        const result = spawnSync(process.execPath, [
            join(HERE, 'split_diff.mjs'),
            '--check',
            dir,
        ], {
            encoding: 'utf8',
        });

        // Assert
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'coverage.json'), 'utf8')).verifiers, [
            'verified-2.json',
        ]);
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

test('an empty diff is refused before any chunk is written', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    writeFileSync(join(dir, 'diff.patch'), '', 'utf8');

    try {

        // Act and Assert
        assert.throws(() => writeChunks(dir), /the diff is empty/);
        assert.equal(existsSync(join(dir, 'manifest.json')), false);
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

test('a split hunk never parts a wrapped line from the line it continues', () => {

    // Arrange
    const diff = [
        'diff --git a/min.js b/min.js',
        '--- a/min.js',
        '+++ b/min.js',
        '@@ -0,0 +1,60 @@',
        ...Array.from({
            length: 60,
        }, (_, index) => `+${String(index).padEnd(3000, 'x')}`),
    ].join('\n');

    // Act
    const chunks = splitDiff(diff, token);

    // Assert
    assert.ok(chunks.length > 1);
    chunks.forEach(chunk => {
        const lines = chunk.text.split('\n');

        lines.forEach((line, index) => {
            if (line.startsWith('# wrapped: ')) {
                assert.match(lines[index - 1], /^(\+|# wrapped: )/, `${chunk.name} line ${index + 1}`);
            }
        });
    });
});

test('a line the Read tool would cut is wrapped, losing nothing', () => {

    // Arrange
    const long = `+${'x'.repeat(5000)}`;
    const diff = [
        'diff --git a/min.js b/min.js',
        '--- a/min.js',
        '+++ b/min.js',
        '@@ -0,0 +1,1 @@',
        long,
    ].join('\n');

    // Act
    const [
        chunk,
    ] = splitDiff(diff, token);
    const lines = chunk.text.split('\n');

    // Assert
    lines.forEach(line => assert.ok(line.length < READ_LINE_CHARACTERS, `${line.length} characters`));
    assert.equal(lines.filter(line => line.startsWith('# wrapped: ')).map(line => line.slice('# wrapped: '.length))
        .join(''), long.slice(lines.find(line => line.startsWith('+x')).length));
});

test('each later part of a split hunk opens with a header naming its HEAD lines', () => {

    // Arrange
    const diff = fileDiff('huge_hunk.sql', 1, 3000);

    // Act
    const chunks = splitDiff(diff, token);

    // Assert
    assert.ok(chunks.length > 1);
    chunks.slice(1).forEach(chunk => {
        const header = (/^@@ -(\d+),\d+ \+(\d+),\d+ @@ continued$/m).exec(chunk.text);
        const first = (/^\+const value0_(\d+) /m).exec(chunk.text);

        assert.ok(header !== null, chunk.name);
        assert.equal(Number(header[2]), Number(first[1]) + 1, chunk.name);
    });
});

test('a wrapped line never parts the two halves of a surrogate pair', () => {

    // Arrange
    const long = `+${'x'.repeat(1_898)}😀${'y'.repeat(3_000)}😀${'z'.repeat(10)}`;
    const diff = [
        'diff --git a/emoji.txt b/emoji.txt',
        '--- a/emoji.txt',
        '+++ b/emoji.txt',
        '@@ -0,0 +1,1 @@',
        long,
    ].join('\n');

    // Act
    const [
        chunk,
    ] = splitDiff(diff, token);
    const written = Buffer.from(chunk.text, 'utf8').toString('utf8');
    const lines = written.split('\n');
    const joined = lines.filter(line => line.startsWith('+x') || line.startsWith('# wrapped: '))
        .map(line => (line.startsWith('# wrapped: ') ? line.slice('# wrapped: '.length) : line))
        .join('');

    // Assert
    assert.equal(written.includes('\uFFFD'), false);
    assert.equal(joined, long);
});

test('one line longer than a chunk holds is spread over chunks each under the Read limit in UTF-8 bytes', () => {

    // Arrange
    const long = `+${'ü'.repeat(120_000)}`;
    const diff = [
        'diff --git a/min.js b/min.js',
        '--- a/min.js',
        '+++ b/min.js',
        '@@ -0,0 +1,1 @@',
        long,
    ].join('\n');

    // Act
    const chunks = splitDiff(diff, token);

    // Assert
    assert.ok(chunks.length > 1);
    chunks.forEach(chunk => {
        assert.ok(Buffer.byteLength(chunk.text, 'utf8') < READ_BYTES, `${chunk.name} has ${chunk.bytes} bytes`);
    });
    assert.equal(chunks.flatMap(chunk => chunk.text.split('\n'))
        .filter(line => line.startsWith('+ü') || line.startsWith('# wrapped: '))
        .map(line => (line.startsWith('# wrapped: ') ? line.slice('# wrapped: '.length) : line))
        .join(''), long);
});

test('a diff larger than the xxl fixture is split into shards, each chunk read by one reviewer', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    try {
        writeFileSync(join(dir, 'diff.patch'), fileDiff('big.ts', 400, 70), 'utf8');

        // Act
        const split = spawnSync(process.execPath, [
            join(HERE, 'split_diff.mjs'),
            dir,
        ], {
            encoding: 'utf8',
        });

        // Assert
        assert.ok(readFileSync(join(dir, 'diff.patch')).length > XXL_FIXTURE_BYTES);
        assert.equal(split.status, 0, split.stderr);

        const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
        const assigned = manifest.reviewers.flatMap(reviewer => reviewer.chunks);

        assert.ok(manifest.reviewers.length > WHOLE_DIFF_REVIEWERS);
        assert.deepEqual([
            ...assigned,
        ].sort(), manifest.chunks.map(chunk => chunk.name).sort());
        assert.equal(new Set(assigned).size, assigned.length);
        assert.ok(existsSync(join(dir, 'chunks', manifest.chunks[0].name)));
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});

test('a missing diff exits 1', () => {

    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'pr-audit-split-'));

    try {

        // Act
        const missing = spawnSync(process.execPath, [
            join(HERE, 'split_diff.mjs'),
            dir,
        ], {
            encoding: 'utf8',
        });

        // Assert
        assert.equal(missing.status, 1);
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true,
        });
    }
});
