#!/usr/bin/env node
/**
 * Splits a frozen `diff.patch` into chunks one Read call returns whole, and
 * writes `manifest.json` naming them.
 *
 *   node split_diff.mjs .tmp/sessions/SESSION/review
 *   node split_diff.mjs --check .tmp/sessions/SESSION/review
 *
 * A reviewer handed one large diff reads the first call's worth and moves on,
 * and its report reads as a full audit all the same. Each chunk therefore ends
 * in a random token that only reading the chunk to its end shows; a reviewer
 * lists the tokens it saw, and a token missing from its list is a chunk it did
 * not read. The manifest beside the chunks holds only each token's hash, so
 * a reviewer who opens it learns none. Chunks break at file boundaries, a
 * file too large for one chunk at hunk boundaries, and a hunk too large at
 * line boundaries, each later part of a hunk under a header of its own. A
 * line longer than the Read tool shows is wrapped onto `# wrapped:` lines.
 * The manifest also assigns the chunks to reviewers: a diff up to 600 KB goes
 * whole to two, a larger one goes shard by shard to one reviewer each.
 * `--check` writes to `coverage.json` which of its chunks each reviewer's
 * `coverage` list shows it read, and prints the prompts of what comes
 * next: a resume for each reviewer that missed chunks, then the verifiers.
 */

import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { isMainModule } from './main_module.mjs';
import { resumePrompt, verifierPrompts } from './prompts.mjs';
import { parseCandidates } from './report_schema.mjs';

/*
 * The Read tool stops at 50 KB and, by default, at 2,000 lines, whichever
 * comes first; a chunk stays under both with room for its two marker lines.
 */
const BUDGET = {
    bytes: 40_000,
    lines: 1_500,
};
const MARKER_ROOM = {
    bytes: 200,
    lines: 2,
};

/*
 * Room for a later part's `# continued:` line and its hunk header.
 */
const PART_ROOM = {
    bytes: 400,
    lines: 2,
};

/*
 * The Read tool cuts every line past 2,000 characters.
 */
const WRAP_AT = 1_900;
const WRAPPED = '# wrapped: ';
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/*
 * A reviewer holding a whole large diff finds less
 * (`evaluation/pr_audit/evaluation.md` → *Pull request size limit*), so a diff past
 * `WHOLE_DIFF_BYTES` is cut into shards of about `SHARD_BYTES`, all of one
 * size, so that no reviewer is left a tail of one chunk. A shard closes early
 * where the next chunk opens another module, so that a module's files share a
 * reviewer, and never inside a run of chunks that each continue the file the
 * chunk before ends in, as long as it can hold that run whole.
 */
const WHOLE_DIFF_BYTES = 600_000;
const SHARD_BYTES = 250_000;
const SHARD_SLACK = 1.2;
const MODULE_CLOSE_SHARE = 0.6;
const MODULE_DEPTH = 3;

/*
 * A diff read whole is read by two reviewers, whose union is what the second
 * is for; a sharded diff gets one reviewer per shard.
 */
const WHOLE_DIFF_REVIEWERS = 2;
const EXIT_FAILED = 1;
const TOKEN_BYTES = 6;
const JSON_INDENT = 4;
const NAME_DIGITS = 2;

/*
 * Git quotes a path holding a quote, a backslash or a control character, and
 * without `core.quotePath=false` every non-ASCII one, C-style with octal
 * bytes: `"b/\303\274.txt"`.
 */
const FILE_HEADER = /^diff --git (?:"a\/(?:[^"\\]|\\.)*"|a\/.+) (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.+))$/;
const DIFF_GIT = 'diff --git ';
const SEPARATOR = ' b/';
const QUOTED_ESCAPE = /\\([0-7]{3}|.)/g;
const OCTAL = 8;
const C_ESCAPES = {
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
};

const lineBytes = line => Buffer.byteLength(line, 'utf8') + 1;

const measureLines = lines => ({
    bytes: lines.reduce((sum, line) => sum + lineBytes(line), 0),
    lines: lines.length,
});

const HIGH_SURROGATE = {
    first: 0xd800,
    last: 0xdbff,
};

const isHighSurrogate = code => code >= HIGH_SURROGATE.first && code <= HIGH_SURROGATE.last;

const hashOf = token => createHash('sha256').update(token).digest('hex');

/**
 * Wraps a line the Read tool would cut onto `# wrapped:` lines.
 * @param line - One line of the diff.
 * @returns The line, or its parts.
 */
function wrapLine (line) {
    const parts = [];
    let start = 0;

    do {
        const width = start === 0 ? WRAP_AT : WRAP_AT - WRAPPED.length;
        let end = Math.min(start + width, line.length);

        /*
         * A cut between the two halves of a surrogate pair turns each half
         * into U+FFFD once the chunk is written as UTF-8.
         */
        if (end < line.length && isHighSurrogate(line.charCodeAt(end - 1))) {
            end -= 1;
        }

        parts.push(`${start === 0 ? '' : WRAPPED}${line.slice(start, end)}`);
        start = end;
    } while (start < line.length);

    return parts;
}

/**
 * Groups each diff line with the `# wrapped:` lines that continue it, so a
 * split falls between two diff lines and never inside one.
 * @param lines - Lines of one hunk, wrapped.
 * @returns The rows, each a diff line and its continuations.
 */
function rowsOf (lines) {
    const rows = [];

    for (const line of lines) {
        if (line.startsWith(WRAPPED) && rows.length > 0) {
            rows.at(-1).push(line);
        } else {
            rows.push([
                line,
            ]);
        }
    }

    return rows;
}

/**
 * Counts how far a run of hunk lines moves the old and the new side.
 * @param lines - Lines of one hunk, its header excluded.
 * @returns The lines each side holds.
 */
function sideCounts (lines) {
    return lines.reduce((counts, line) => ({
        old: counts.old + (line.startsWith(' ') || line.startsWith('-') ? 1 : 0),
        new: counts.new + (line.startsWith(' ') || line.startsWith('+') ? 1 : 0),
    }), {
        old: 0,
        new: 0,
    });
}

/**
 * Gives each later part of a split hunk a header naming the lines it holds,
 * so a reviewer counts HEAD line numbers from any part.
 * @param parts - The parts of one hunk, the first opening with its header.
 * @returns The parts, the later ones under a header of their own.
 */
function headParts (parts) {
    const header = HUNK_HEADER.exec(parts[0][0]);

    if (header === null) {
        return parts;
    }

    let oldLine = Number(header[1]);
    let newLine = Number(header[2]);

    return parts.map((part, index) => {
        const body = index === 0 ? part.slice(1) : part;
        const counts = sideCounts(body);
        const headed = index === 0 ? part : [
            `@@ -${oldLine},${counts.old} +${newLine},${counts.new} @@ continued`,
            ...part,
        ];

        oldLine += counts.old;
        newLine += counts.new;

        return headed;
    });
}

/**
 * Packs items in order into groups that stay within a budget; an item larger
 * than the budget makes a group of its own.
 * @param items - The items.
 * @param measure - Returns an item's `bytes` and `lines`.
 * @param budget - The most `bytes` and `lines` a group holds.
 * @returns The groups, each an array of items.
 */
function pack (items, measure, budget) {
    const groups = [];
    let current = null;

    for (const item of items) {
        const size = measure(item);
        const overflows = current !== null &&
            (current.bytes + size.bytes > budget.bytes || current.lines + size.lines > budget.lines);

        if (current === null || overflows) {
            current = {
                items: [],
                bytes: 0,
                lines: 0,
            };
            groups.push(current);
        }

        current.items.push(item);
        current.bytes += size.bytes;
        current.lines += size.lines;
    }

    return groups.map(group => group.items);
}

/**
 * Cuts a row too large for one part into rows of its lines that fit, the one
 * case a `# wrapped:` line opens a part rather than follow its diff line.
 * @param rows - The rows of one hunk.
 * @param room - The most a part may hold.
 * @returns The rows, none larger than the room.
 */
function rowsWithin (rows, room) {
    return rows.flatMap(row => {
        const size = measureLines(row);

        return size.bytes <= room.bytes && size.lines <= room.lines ? [
            row,
        ] : pack(row, line => measureLines([
            line,
        ]), room);
    });
}

/**
 * Reads a path git quoted, its octal escapes being the bytes of UTF-8.
 * @param quoted - The path between the quotes.
 * @returns The path.
 */
function unquotePath (quoted) {
    const bytes = [];
    let last = 0;

    for (const match of quoted.matchAll(QUOTED_ESCAPE)) {
        bytes.push(...Buffer.from(quoted.slice(last, match.index), 'utf8'));

        const escape = match[1];

        bytes.push((/^[0-7]+$/).test(escape) ? parseInt(escape, OCTAL) : C_ESCAPES[escape] ?? escape.charCodeAt(0));
        last = match.index + match[0].length;
    }

    bytes.push(...Buffer.from(quoted.slice(last), 'utf8'));

    return Buffer.from(bytes).toString('utf8');
}

/**
 * Names the HEAD path of an unquoted `diff --git a/<old> b/<new>` line. A path
 * may hold ` b/` itself, which no pattern tells from the separator; but unless
 * the file is renamed both halves are one path, so the line splits at its middle.
 * @param line - The `diff --git` line.
 * @param fallback - The path the pattern read, kept for a rename.
 * @returns The path.
 */
function unquotedHeadPath (line, fallback) {
    const rest = line.slice(DIFF_GIT.length);
    const half = (rest.length - ' '.length) / 2;
    const old = rest.slice(0, half);

    if (Number.isInteger(half) && old.startsWith('a/') && rest.slice(half) === `${SEPARATOR}${old.slice(2)}`) {
        return old.slice(2);
    }

    return fallback;
}

/**
 * Names the file a `diff --git` line opens, at HEAD.
 * @param line - One line of the diff.
 * @returns The path, or null when the line opens no file.
 */
function headerPath (line) {
    const header = FILE_HEADER.exec(line);

    if (header === null) {
        return null;
    }

    return header[1] === undefined ? unquotedHeadPath(line, header[2]) : unquotePath(header[1]);
}

/**
 * Counts the changed lines of a chunk: a `+` or `-` line inside a hunk. A file's
 * `---` and `+++` lines stand before its first hunk and are told apart by that
 * position, since a removed `-- a/x` or an added `++ b/x` reads the same.
 * @param lines - The chunk's lines.
 * @returns The count.
 */
function changedLinesOf (lines) {
    let inHunk = false;
    let count = 0;

    for (const line of lines) {
        if (line.startsWith(DIFF_GIT)) {
            inHunk = false;
        } else if (line.startsWith('@@')) {
            inHunk = true;
        } else if (inHunk && (/^[+-]/).test(line)) {
            count += 1;
        }
    }

    return count;
}

/**
 * Cuts the diff into one section per file.
 * @param lines - The diff's lines.
 * @returns The sections: the file's path at HEAD and its lines.
 */
function fileSections (lines) {
    const sections = [];

    for (const line of lines) {
        const path = headerPath(line);

        if (path !== null) {
            sections.push({
                path,
                lines: [],
            });
        }

        sections.at(-1)?.lines.push(line);
    }

    return sections;
}

/**
 * Separates a file section's header from its hunks.
 * @param lines - The section's lines.
 * @returns The header lines and the hunks, each an array of lines.
 */
function hunksOf (lines) {
    const start = lines.findIndex(line => line.startsWith('@@'));

    if (start === -1) {
        return {
            header: lines,
            hunks: [],
        };
    }

    const hunks = [];

    for (const line of lines.slice(start)) {
        if (line.startsWith('@@')) {
            hunks.push([]);
        }

        hunks.at(-1).push(line);
    }

    return {
        header: lines.slice(0, start),
        hunks,
    };
}

/**
 * Splits a file section too large for one chunk into parts that each carry
 * the file's header, so every part names its file.
 * @param section - The file section.
 * @param budget - The most a part may hold.
 * @returns The parts, each shaped like a section.
 */
function piecesOf (section, budget) {
    const whole = measureLines(section.lines);

    if (whole.bytes <= budget.bytes && whole.lines <= budget.lines) {
        return [
            section,
        ];
    }

    const { header, hunks } = hunksOf(section.lines);
    const head = measureLines(header);
    const room = {
        bytes: budget.bytes - head.bytes - PART_ROOM.bytes,
        lines: budget.lines - head.lines - PART_ROOM.lines,
    };
    const units = hunks.flatMap(hunk => headParts(pack(rowsWithin(rowsOf(hunk), room), measureLines, room)
        .map(part => part.flat())));

    return pack(units, measureLines, room).map((group, index) => ({
        path: section.path,
        lines: [
            ...header,
            ...(index > 0 ? [
                `# continued: ${section.path}`,
            ] : []),
            ...group.flat(),
        ],
    }));
}

/**
 * Splits a diff into chunks.
 * @param text - The contents of `diff.patch`.
 * @param newToken - Returns a fresh token; random unless a test replaces it.
 * @returns The chunks: file name, token, text and what the manifest records.
 */
function splitDiff (text, newToken = () => randomBytes(TOKEN_BYTES).toString('hex')) {
    const budget = {
        bytes: BUDGET.bytes - MARKER_ROOM.bytes,
        lines: BUDGET.lines - MARKER_ROOM.lines,
    };
    const lines = text.replace(/\n$/, '').split('\n').flatMap(wrapLine);
    const pieces = fileSections(lines).flatMap(section => piecesOf(section, budget));
    const groups = pack(pieces, piece => measureLines(piece.lines), budget);

    return groups.map((group, index) => {
        const name = `chunk-${String(index + 1).padStart(NAME_DIGITS, '0')}.patch`;
        const token = newToken();
        const body = group.flatMap(piece => piece.lines);
        const chunkText = [
            `# ${name}, ${index + 1} of ${groups.length}; its token is on its last line`,
            ...body,
            `# end of ${name}; token ${token}`,
            '',
        ].join('\n');

        return {
            name,
            token,
            text: chunkText,
            bytes: Buffer.byteLength(chunkText, 'utf8'),
            lines: body.length,
            changedLines: changedLinesOf(body),
            files: [
                ...new Set(group.map(piece => piece.path)),
            ],
        };
    });
}

/**
 * Names the module a path belongs to: its first directories.
 * @param path - A repository path.
 * @returns The module.
 */
const moduleOf = path => path.split('/').slice(0, MODULE_DEPTH).join('/');

/**
 * Tells whether a chunk opens a shard of its own.
 * @param current - The shard being filled, or null before the first.
 * @param chunk - The next chunk.
 * @param target - The size every shard aims at.
 * @returns True when the chunk starts a new shard.
 */
function opensShard (current, chunk, target) {
    if (current === null) {
        return true;
    }

    const reached = current.bytes >= target;
    const over = current.bytes + chunk.bytes > target * SHARD_SLACK;
    const newModule = current.bytes > target * MODULE_CLOSE_SHARE && moduleOf(chunk.files[0]) !== current.module;

    return reached || over || newModule;
}

/**
 * Merges a last shard smaller than half the target into the one before it,
 * so that no reviewer is spawned for a remnant.
 * @param shards - The shards, each with its `names` and `bytes`.
 * @param target - The size every shard aims at.
 * @returns The shards.
 */
function withoutTail (shards, target) {
    const last = shards.at(-1);
    const rest = shards.slice(0, -1);
    const before = rest.at(-1);

    if (before === undefined || last.bytes >= target / 2) {
        return shards;
    }

    return [
        ...rest.slice(0, -1),
        {
            names: [
                ...before.names,
                ...last.names,
            ],
            bytes: before.bytes + last.bytes,
        },
    ];
}

/**
 * Joins each chunk that continues the file the chunk before it ends in to
 * that chunk, so that a file split over chunks reaches one reviewer. A group
 * larger than a shard may take stays its chunks, and a shard may then close
 * between any two of them: a large file, or a chain of files each continuing
 * into the next chunk, where every cut parts some file, even one a shard
 * could hold.
 * @param chunks - The chunks, each with its `name`, `bytes` and `files`.
 * @param largest - The most bytes a shard takes.
 * @returns The units a shard is filled with, each with its `names`, `bytes`
 * and `files`.
 */
function unitsOf (chunks, largest) {
    const groups = [];

    for (const chunk of chunks) {
        const last = groups.at(-1);

        if (last !== undefined && last.files.at(-1) === chunk.files[0]) {
            last.chunks.push(chunk);
        } else {
            groups.push({
                chunks: [
                    chunk,
                ],
                files: chunk.files,
            });
        }

        groups.at(-1).files = [
            ...new Set([
                ...groups.at(-1).files,
                ...chunk.files,
            ]),
        ];
    }

    const unit = members => ({
        names: members.map(member => member.name),
        bytes: members.reduce((sum, member) => sum + member.bytes, 0),
        files: [
            ...new Set(members.flatMap(member => member.files)),
        ],
    });

    return groups.flatMap(group => {
        const whole = unit(group.chunks);

        return whole.bytes > largest ? group.chunks.map(chunk => unit([
            chunk,
        ])) : [
            whole,
        ];
    });
}

/**
 * Groups the chunks, in their order, into shards of one size near
 * `SHARD_BYTES`, closing a shard early where the next chunk starts another
 * module and keeping a file's chunks together; a diff up to
 * `WHOLE_DIFF_BYTES` stays one shard.
 * @param chunks - The chunks, each with its `bytes` and `files`.
 * @param limits - `whole`, the largest diff read whole, and `shard`, the
 * size a shard aims at.
 * @returns The shards, each a list of chunk names.
 */
function shardsOf (chunks, limits = {
    whole: WHOLE_DIFF_BYTES,
    shard: SHARD_BYTES,
}) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);

    if (total <= limits.whole) {
        return [
            chunks.map(chunk => chunk.name),
        ];
    }

    const target = total / Math.ceil(total / limits.shard);
    const shards = [];
    let current = null;

    for (const unit of unitsOf(chunks, target * SHARD_SLACK)) {
        if (opensShard(current, unit, target)) {
            current = {
                names: [],
                bytes: 0,
            };
            shards.push(current);
        }

        current.names.push(...unit.names);
        current.bytes += unit.bytes;
        current.module = moduleOf(unit.files.at(-1));
    }

    return withoutTail(shards, target).map(shard => shard.names);
}

/**
 * Assigns the chunks to reviewers: all of them to each of two when they make
 * one shard, one shard to each reviewer otherwise.
 * @param chunks - The chunks.
 * @param limits - As `shardsOf` takes them.
 * @returns Per reviewer its number and its chunks' names.
 */
function reviewersOf (chunks, limits = undefined) {
    const shards = shardsOf(chunks, limits);
    const assigned = shards.length === 1 ? Array.from({
        length: WHOLE_DIFF_REVIEWERS,
    }, () => shards[0]) : shards;

    return assigned.map((names, index) => ({
        reviewer: index + 1,
        chunks: names,
    }));
}

/**
 * Refuses a diff the review cannot take: an empty one, and one that is not
 * the patch git writes. The freeze runs it before it empties the review
 * directory, so a refused diff costs no earlier run.
 * @param text - The diff.
 */
function checkDiff (text) {
    if (text.trim() === '') {
        throw new Error('the diff is empty: HEAD holds nothing its merge-base does not, so there is nothing to review');
    }

    if (!text.split('\n').some(line => headerPath(line) !== null)) {
        throw new Error('diff.patch holds no `diff --git` line, so it is not the patch git writes; ' +
            'a diff tool or a colored diff may have replaced it');
    }
}

/**
 * Writes the chunks under `<review>/chunks/` and `<review>/manifest.json`,
 * replacing those of an earlier run.
 * @param reviewDir - The review directory holding `diff.patch`.
 * @returns The manifest.
 */
function writeChunks (reviewDir) {
    const chunksDir = join(reviewDir, 'chunks');
    const text = readFileSync(join(reviewDir, 'diff.patch'), 'utf8');

    checkDiff(text);

    const chunks = splitDiff(text);

    rmSync(chunksDir, {
        recursive: true,
        force: true,
    });
    mkdirSync(chunksDir, {
        recursive: true,
    });
    chunks.forEach(chunk => writeFileSync(join(chunksDir, chunk.name), chunk.text, 'utf8'));

    const manifest = {
        chunks: chunks.map(chunk => ({
            name: chunk.name,
            tokenHash: hashOf(chunk.token),
            bytes: chunk.bytes,
            lines: chunk.lines,
            changedLines: chunk.changedLines,
            files: chunk.files,
        })),
        reviewers: reviewersOf(chunks),
    };

    writeFileSync(join(reviewDir, 'manifest.json'), `${JSON.stringify(manifest, null, JSON_INDENT)}\n`, 'utf8');

    return manifest;
}

/**
 * Reads the tokens a reviewer's file lists. A file the schema refuses lists
 * none: the verifier could not read its candidates either, so the reviewer is
 * resumed on every chunk, with the problems named.
 * @param path - The candidates file.
 * @returns The tokens, and the problems of a refused file.
 */
function coverageOf (path) {
    try {
        const { coverage } = parseCandidates(readFileSync(path, 'utf8'), basename(path));

        return {
            tokens: new Set(coverage.map(entry => entry.token)),
            problems: [],
        };
    } catch (error) {
        return {
            tokens: new Set(),
            problems: error?.problems ?? [
                error instanceof Error ? error.message : String(error),
            ],
        };
    }
}

/**
 * Compares the tokens each reviewer listed with the chunks the manifest
 * assigned it.
 * @param reviewDir - The review directory.
 * @returns Per reviewer the chunks of its own it read and missed and the
 * problems of a file the schema refuses (null for a reviewer that wrote no
 * file), and the chunks no reviewer read.
 */
function checkCoverage (reviewDir) {
    const { chunks, reviewers } = JSON.parse(readFileSync(join(reviewDir, 'manifest.json'), 'utf8'));
    const byName = new Map(chunks.map(chunk => [
        chunk.name,
        chunk,
    ]));
    const results = {};
    const read = new Set();

    for (const { reviewer, chunks: names } of reviewers) {
        const path = join(reviewDir, `candidates-reviewer-${reviewer}.json`);

        if (existsSync(path)) {
            const { tokens, problems } = coverageOf(path);
            const hashes = new Set([
                ...tokens,
            ].map(hashOf));
            const seen = names.filter(name => hashes.has(byName.get(name).tokenHash));

            seen.forEach(name => read.add(name));
            results[reviewer] = {
                read: seen.length,
                missed: names.filter(name => !seen.includes(name)),
                problems,
            };
        } else {
            results[reviewer] = null;
        }
    }

    const unread = chunks.filter(chunk => !read.has(chunk.name));

    /*
     * A file split over chunks is in every chunk holding a part of it, so a
     * file one of whose chunks was read is only partly unreviewed.
     */
    const readFiles = new Set(chunks.filter(chunk => read.has(chunk.name)).flatMap(chunk => chunk.files));

    return {
        chunks: chunks.length,
        reviewers: results,
        unread: unread.map(chunk => ({
            name: chunk.name,
            files: chunk.files,
            partlyRead: chunk.files.filter(file => readFiles.has(file)),
            changedLines: chunk.changedLines,
        })),
    };
}

/**
 * Splits from the command line: exit 1 for any failure.
 * @param reviewDir - The review directory holding `diff.patch`.
 */
function split (reviewDir) {
    try {
        const manifest = writeChunks(reviewDir);
        const changed = manifest.chunks.reduce((sum, chunk) => sum + chunk.changedLines, 0);

        process.stdout.write(`${manifest.chunks.length} chunks, ${changed} changed lines, ` +
            `${manifest.reviewers.length} reviewers\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
        process.exitCode = EXIT_FAILED;
    }
}

/**
 * Says what the orchestrator does after a coverage check: which reviewers to
 * resume, with which prompt, and which verifiers to spawn once none is left.
 * @param reviewDir - The absolute review directory.
 * @param coverage - The coverage check's output.
 * @returns The unread chunks, the resume prompts and the verifier prompts.
 */
function gate (reviewDir, coverage) {
    const manifest = JSON.parse(readFileSync(join(reviewDir, 'manifest.json'), 'utf8'));
    const written = Object.entries(coverage.reviewers)
        .filter(([
            , result,
        ]) => result !== null)
        .map(([
            reviewer,
        ]) => Number(reviewer));

    return {
        chunks: coverage.chunks,
        unread: coverage.unread.map(chunk => chunk.name),
        failed: Object.keys(coverage.reviewers).map(Number).filter(reviewer => !written.includes(reviewer)),
        resume: written
            .filter(reviewer => coverage.reviewers[reviewer].missed.length > 0)
            .map(reviewer => ({
                reviewer,
                prompt: resumePrompt(coverage.reviewers[reviewer].missed, coverage.reviewers[reviewer].problems),
            })),
        verifiers: verifierPrompts(reviewDir, manifest, written),
    };
}

/**
 * Reads the command line. A `--check` the parser missed would re-split the
 * diff, and every token the reviewers listed would name a chunk that is gone.
 * @param argv - The arguments after the script path.
 * @returns Whether to check and the review directory, or null for a
 * malformed line.
 */
function parseArguments (argv) {
    const check = argv.includes('--check');
    const rest = argv.filter(argument => argument !== '--check');

    if (rest.length !== 1 || rest[0].startsWith('-') || argv.length - rest.length > 1) {
        return null;
    }

    return {
        check,
        reviewDir: rest[0],
    };
}

/**
 * Runs the script from the command line: splits, or with `--check` compares.
 * @param argv - The arguments after the script path.
 */
function main (argv) {
    const options = parseArguments(argv);

    if (options === null) {
        process.stderr.write('usage: node split_diff.mjs [--check] <review directory>\n');
        process.exitCode = 1;

        return;
    }

    const { check, reviewDir } = options;

    if (check) {
        const coverage = checkCoverage(reviewDir);
        const next = gate(resolve(reviewDir), coverage);

        /*
         * The files the verifiers are asked for, which the renderer requires,
         * so a shard whose verifier wrote nothing cannot drop out of the report.
         */
        writeFileSync(join(reviewDir, 'coverage.json'), `${JSON.stringify({
            ...coverage,
            verifiers: next.verifiers.map(verifier => verifier.output),
        }, null, JSON_INDENT)}\n`, 'utf8');
        process.stdout.write(`${JSON.stringify(next, null, JSON_INDENT)}\n`);

        return;
    }

    split(reviewDir);
}

if (isMainModule(import.meta.url)) {
    main(process.argv.slice(2));
}

export { checkCoverage, checkDiff, gate, reviewersOf, shardsOf, splitDiff, writeChunks };
