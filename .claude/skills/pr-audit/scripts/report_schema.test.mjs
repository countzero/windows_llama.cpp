/**
 * The schema of the workers' files, pinned against the examples of both briefs.
 *
 *   node --test .claude/skills/pr-audit/scripts/report_schema.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    checkFile,
    mergeVerified,
    parseCandidates,
    parseVerified,
    SEVERITIES,
    TITLE_MAX_GRAPHEMES,
} from './report_schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Reads the JSON example of a brief's *Output format*.
 * @param brief - The brief's file name.
 * @returns The example's text and the section it stands in.
 */
function exampleOf (brief) {
    const text = readFileSync(join(HERE, '..', 'prompts', brief), 'utf8').replace(/\r\n/g, '\n');
    const format = text.slice(text.indexOf('## Output format'));

    return {
        format,
        example: (/```json\n([\s\S]*?)```/).exec(format)[1],
    };
}

const VERIFIER = exampleOf('verifier.md');
const REVIEWER = exampleOf('reviewer.md');
const verified = () => JSON.parse(VERIFIER.example);

test('the example of each brief passes the schema', () => {

    // Act
    const candidates = parseCandidates(REVIEWER.example, 'candidates-reviewer-1.json');
    const sections = parseVerified(VERIFIER.example);

    // Assert
    assert.equal(candidates.candidates[0].id, 'R1-1');
    assert.equal(candidates.design[0].lead, 'Scope');
    assert.equal(candidates.coverage[0].token, '0123456789ab');
    assert.equal(sections.confirmed.length, 1);
    assert.equal(sections.open.length, 1);
    assert.deepEqual(sections.refuted[0].ids, [
        'R1-4',
    ]);
});

test('the verifier brief names the severities and the title length the schema holds', () => {

    // Arrange
    const severityRule = (/^- `severity` is one of (.*)\.$/m).exec(VERIFIER.format)[1];
    const titleRule = (/^- `title` is one line of at most (\d+) characters/m).exec(VERIFIER.format)[1];

    // Assert
    assert.deepEqual(severityRule.split(', ').map(item => item.replace(/`/g, '')), SEVERITIES);
    assert.equal(Number(titleRule), TITLE_MAX_GRAPHEMES);
});

test('a text that is no JSON is refused with the position it breaks at', () => {

    // Arrange
    const broken = VERIFIER.example.replace('One paragraph.', 'One "quoted" paragraph.');

    // Act and Assert
    assert.throws(() => parseVerified(broken), error => {
        assert.equal(error.problems.length, 1);
        assert.match(error.problems[0], /^verified\.json: not JSON: .*position \d+/);

        return true;
    });
});

test('every faulty value is named at once, with where it stands', () => {

    // Arrange
    const data = verified();

    data.confirmed[0].severity = 'Blocker';
    data.confirmed[0].title = `${'x'.repeat(TITLE_MAX_GRAPHEMES)}y`;
    data.open[0].file = 'C:\\repo\\a.mjs';
    data.open[0].lines = '12–18';
    data.refuted[0].quotePath = 'auth.ts';
    data.refuted[0].ids = [];
    data.refuted[0].extra = 'x';
    delete data.refuted[0].reason;

    // Act and Assert
    assert.throws(() => parseVerified(JSON.stringify(data), 'verified-2.json'), error => {
        assert.deepEqual(error.problems, [
            'verified-2.json confirmed[0]: severity must be one of Critical, High, Medium, Low',
            'verified-2.json confirmed[0]: title must be one line of at most 80 characters, no closing period',
            'verified-2.json open[0]: file must be one repository path in forward slashes, as "examples/server.ps1"',
            'verified-2.json open[0]: lines must be HEAD lines as "12", "12-18" or "12-18, 40"',
            'verified-2.json refuted[0]: unknown key "extra"',
            'verified-2.json refuted[0]: ids must be the candidate ids, as ["R1-4", "R2-1"]',
            'verified-2.json refuted[0]: quotePath must be the quoted line\'s own "path:line", as ' +
                '"examples/server.ps1:177"',
            'verified-2.json refuted[0]: lacks reason',
        ]);

        return true;
    });
});

test('a title of 80 characters passes, counted in characters rather than code units', () => {

    // Arrange
    const data = verified();

    data.open[0].title = `${'ä'.repeat(79)}🟠`;

    // Act
    const sections = parseVerified(JSON.stringify(data));

    // Assert
    assert.equal(sections.open[0].title, data.open[0].title);
});

test('a missing list is refused, an empty one passes', () => {

    // Act and Assert
    assert.throws(() => parseVerified('{"confirmed": [], "open": []}'), /lacks refuted/);
    assert.deepEqual(parseVerified('{"confirmed": [], "open": [], "refuted": []}'), {
        confirmed: [],
        open: [],
        refuted: [],
    });
});

test('a reviewer file refuses a foreign id, an unknown lead and a guessed token', () => {

    // Arrange
    const data = JSON.parse(REVIEWER.example);

    data.candidates[0].id = 'R2-1';
    data.design[0].lead = 'Naming';
    data.coverage[0].token = 'abc';

    // Act and Assert
    assert.throws(() => parseCandidates(JSON.stringify(data), 'candidates-reviewer-1.json'), error => {
        assert.deepEqual(error.problems, [
            'candidates-reviewer-1.json candidates[0]: id R2-1 is not reviewer 1\'s',
            'candidates-reviewer-1.json design[0]: lead must be one of Scope, Placement, Complexity, Other',
            'candidates-reviewer-1.json coverage[0]: token must be the 12 hex digits after "token" on the chunk\'s ' +
                'last line',
        ]);

        return true;
    });
});

test('the format check picks the schema by file name and prints ok or every problem', () => {

    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'pr-audit-schema-'));
    const good = join(directory, 'verified.json');
    const bad = join(directory, 'candidates-reviewer-1.json');
    const other = join(directory, 'notes.json');

    writeFileSync(good, VERIFIER.example, 'utf8');
    writeFileSync(bad, '{"candidates": [], "design": []}', 'utf8');
    writeFileSync(other, '{}', 'utf8');

    try {

        // Act
        const run = path => spawnSync(process.execPath, [
            join(HERE, 'report_schema.mjs'),
            path,
        ], {
            encoding: 'utf8',
        });
        const passed = run(good);
        const refused = run(bad);

        // Assert
        assert.equal(passed.status, 0);
        assert.equal(passed.stdout, 'ok\n');
        assert.equal(refused.status, 1);
        assert.equal(refused.stdout, 'candidates-reviewer-1.json: lacks coverage\n');
        assert.equal(checkFile(other).ok, false);
    } finally {
        rmSync(directory, {
            recursive: true,
            force: true,
        });
    }
});

test('merged files are ordered by severity, then by file in code units, a file keeping its order', () => {

    // Arrange
    const entry = (severity, file, title) => ({
        severity,
        file,
        lines: '1',
        title,
        description: 'd',
    });

    // Act
    const merged = mergeVerified([
        {
            confirmed: [
                entry('Low', 'a.mjs', 'first'),
                entry('High', 'b.mjs', 'second'),
                entry('Low', 'a.mjs', 'third'),
            ],
            open: [],
            refuted: [
                {
                    ids: [
                        'R1-2',
                    ],
                },
            ],
        },
        {
            confirmed: [
                entry('Low', 'Z.mjs', 'fourth'),
            ],
            open: [
                entry('Low', 'c.mjs', 'low doubt'),
                entry('High', 'c.mjs', 'high doubt'),
            ],
            refuted: [],
        },
    ]);

    // Assert
    assert.deepEqual(merged.confirmed.map(item => item.title), [
        'second',
        'fourth',
        'first',
        'third',
    ]);
    assert.deepEqual(merged.open.map(item => item.title), [
        'high doubt',
        'low doubt',
    ]);
    assert.equal(merged.refuted.length, 1);
});
