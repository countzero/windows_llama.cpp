/**
 * The contract of `render_report.mjs`, pinned against one invented review.
 *
 *   node --test .claude/skills/pr-audit/scripts/render_report.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    buildBody,
    buildPage,
    buildReport,
    CSS_PATH,
    fileLink,
    fileStem,
    inline,
    readMeta,
    renderReport,
    summary,
} from './render_report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'pr-audit-render-'));
const REVIEW = join(ROOT, 'review');

const META = {
    branch: 'feature/x',
    base: 'release/v0.0.14-staging',
    head: '0123456789abcdef0123456789abcdef01234567',
    mergeBase: 'fedcba9876543210fedcba9876543210fedcba98',
    deleted: [
        'gone.mjs',
    ],
    pr: 12,
    owner: 'owner',
    repo: 'repo',
    filesChanged: 2,
    additions: 10,
    deletions: 3,
    frozenAt: '2026-09-25T09:20:11+02:00',
};

const entry = (severity, file, lines, title, description) => ({
    severity,
    file,
    lines,
    title,
    description,
});

const VERIFIED = {
    confirmed: [
        entry('Low', 'b.mjs', '4', 'Beta breaks a rule', 'One sentence.'),
        entry('Medium', 'a.mjs', '10-12', 'Alpha drops a <T> row', 'The `Array<T>` loses **one** row.'),
    ],
    open: [
        entry('High', 'c.mjs', '7', 'Gamma may lose a write', 'A doubt. What settles it.'),
    ],
    refuted: [
        {
            ids: [
                'R1-3',
                'R2-1',
            ],
            file: 'd.mjs',
            lines: '2',
            quotePath: 'd.mjs:5',
            quote: 'return null;',
            reason: 'It returns before the write.',
        },
    ],
};

const candidates = design => JSON.stringify({
    candidates: [],
    design,
    coverage: [],
});

const render = out => renderReport(REVIEW, join(ROOT, out));
const htmlOf = result => readFileSync(result.html, 'utf8');
const jsonOf = result => JSON.parse(readFileSync(result.json, 'utf8'));
const report = (verified = VERIFIED, design = [], coverage = null) => buildReport(
    META,
    JSON.parse(JSON.stringify(verified)),
    design,
    coverage
);

before(() => {
    mkdirSync(REVIEW, {
        recursive: true,
    });
    writeFileSync(join(REVIEW, 'meta.json'), JSON.stringify(META), 'utf8');
    writeFileSync(join(REVIEW, 'verified.json'), JSON.stringify(VERIFIED), 'utf8');
    writeFileSync(join(REVIEW, 'candidates-reviewer-1.json'), candidates([
        {
            lead: 'Complexity',
            text: 'One fact twice.',
        },
    ]), 'utf8');
    writeFileSync(join(REVIEW, 'candidates-reviewer-2.json'), candidates([
        {
            lead: 'Scope',
            text: 'Beyond the `ticket`.',
        },
    ]), 'utf8');
});

after(() => {
    rmSync(ROOT, {
        recursive: true,
        force: true,
    });
});

test('two renders of one review give the same JSON and HTML bytes, the time taken from frozenAt', () => {

    // Act
    const first = render('first');
    const second = render('second');

    // Assert
    assert.deepEqual(readFileSync(first.json), readFileSync(second.json));
    assert.deepEqual(readFileSync(first.html), readFileSync(second.html));
    assert.match(htmlOf(first), /<td>Generated<\/td><td>2026-09-25 09:20<\/td>/);
});

test('the JSON holds every finding, open and refuted entry, the Design and the facts', () => {

    // Act
    const data = jsonOf(render('json'));

    // Assert
    assert.deepEqual(data.confirmed.map(item => `${item.id} ${item.severity} ${item.file}`), [
        'M-1 Medium a.mjs',
        'L-1 Low b.mjs',
    ]);
    assert.deepEqual(data.open.map(item => `${item.id} ${item.severity}`), [
        'O-1 High',
    ]);
    assert.equal(data.refuted[0].quote, 'return null;');
    assert.deepEqual(data.design.map(item => `${item.lead} R${item.reviewer}`), [
        'Complexity R1',
        'Scope R2',
    ]);
    assert.equal(data.meta.head, META.head);
    assert.deepEqual(data.counts, {
        critical: 0,
        high: 0,
        medium: 1,
        low: 1,
        open: 1,
        refuted: 2,
    });
});

test('the HTML lists Critical to Medium and counts the Low, the open and the refuted alone', () => {

    // Act
    const html = htmlOf(render('html'));

    // Assert
    assert.match(html, /<h3 id="medium">Medium<\/h3>/);
    assert.match(html, /Alpha drops a &lt;T&gt; row/);
    assert.doesNotMatch(html, /Beta breaks a rule|Gamma may lose a write|return null;|id="low"|id="open"/);
    assert.match(html, new RegExp('<p>Not listed here: 1 Low finding, 1 open entry and 2 refuted candidates\\. ' +
        'They stand in <code>pr-audit-feature-x-release-v0\\.0\\.14-staging-0123456\\.json</code> beside this page, ' +
        'each refutation with its quoted line\\.</p>'));
    assert.match(html, /<td>Findings<\/td><td>🔴 0 Critical · 🟠 0 High · 🟡 <a href="#medium">1 Medium<\/a><\/td>/);
});

test('the note on what the page leaves out is a GitHub NOTE alert and closes the page', () => {

    // Act
    const body = buildBody(report());
    const note = body.indexOf('<div class="markdown-alert markdown-alert-note">');

    // Assert
    assert.ok(note > body.indexOf('id="medium"'), 'the note stands after the findings');
    assert.ok(note > body.indexOf('id="design"'), 'the note stands after the Design');
    assert.match(body.slice(note), /^<div class="markdown-alert markdown-alert-note">\n<p class="markdown-alert-title"><svg class="octicon octicon-info"[^]*?<\/svg>Note<\/p>\n<p>Not listed here: [^\n]*<\/p>\n<\/div>\n$/);
});

test('a review with nothing of Medium or above says so and lists no table of findings', () => {

    // Act
    const body = buildBody(report({
        confirmed: [
            entry('Low', 'b.mjs', '4', 'Beta', 'One.'),
        ],
        open: [],
        refuted: [],
    }));

    // Assert
    assert.match(body, /<p>No confirmed finding of Medium or above\.<\/p>/);
    assert.doesNotMatch(body, /class="findings"/);
    assert.match(body, /Not listed here: 1 Low finding\. They stand in <code>[^<]+<\/code> beside this page\.<\/p>/);
});

test('ids follow the merged order, per severity letter, and the HTML numbers as the JSON does', () => {

    // Arrange
    const verified = {
        confirmed: [
            entry('High', 'z.mjs', '1', 'Z', 'z'),
            entry('High', 'a.mjs', '1', 'A', 'a'),
            entry('Medium', 'm.mjs', '1', 'M', 'm'),
        ],
        open: [],
        refuted: [],
    };

    // Act
    const data = report(verified);
    const body = buildBody(data);

    // Assert
    assert.deepEqual(data.confirmed.map(item => item.id), [
        'H-1',
        'H-2',
        'M-1',
    ]);
    assert.ok(body.indexOf('<td>H-1</td>') < body.indexOf('<td>H-2</td>'));
    assert.ok(body.indexOf('id="high"') < body.indexOf('id="medium"'));
});

test('a worker\'s text is escaped and keeps only its code spans', () => {

    // Act and Assert
    assert.equal(
        inline('A <br> and `Array<T>` with **bold** & "quotes"'),
        'A &lt;br&gt; and <code>Array&lt;T&gt;</code> with **bold** &amp; &quot;quotes&quot;'
    );
});

test('the metadata links the branch, head and pull request, and colors the diff', () => {

    // Act
    const body = buildBody(report());

    // Assert
    assert.doesNotMatch(body, /Ticket|Jira/);
    assert.match(body, /<a href="https:\/\/github\.com\/owner\/repo\/tree\/feature\/x"><code>feature\/x<\/code><\/a>/);
    assert.match(body, /<a href="https:\/\/github\.com\/owner\/repo\/pull\/12"><code>#12<\/code><\/a>/);
    assert.match(body, /2 files · <ins>\+10<\/ins> · <del>−3<\/del>/);
});

test('the Design groups by lead in the leads\' order, each tagged with its reviewer', () => {

    // Act
    const html = htmlOf(render('design'));

    // Assert
    assert.match(html, new RegExp([
        '<h3 id="design">Design</h3>',
        '<h4 id="scope">Scope</h4>',
        '<ul>',
        '<li>Beyond the <code>ticket</code>\\. \\(R2\\)</li>',
        '</ul>',
        '<h4 id="complexity">Complexity</h4>',
    ].join('\n')));
});

test('a file links to the blob at HEAD, its text the lines named and its target one line wider', () => {

    // Act
    const link = fileLink(META, {
        file: 'a.mjs',
        lines: '10-12',
    });

    // Assert
    assert.deepEqual(link, {
        text: '/a.mjs:10-12',
        url: `https://github.com/owner/repo/blob/${META.head}/a.mjs#L9-L13`,
    });
});

test('a #, ? or % in a path is encoded in the link and kept in its text', () => {

    // Act
    const link = fileLink(META, {
        file: 'app/#id/a?b%c.mjs',
        lines: '4',
    });

    // Assert
    assert.equal(link.text, '/app/#id/a?b%c.mjs:4');
    assert.equal(link.url, `https://github.com/owner/repo/blob/${META.head}/app/%23id/a%3Fb%25c.mjs#L3-L5`);
});

test('a file the diff deletes links to its last version at the merge-base', () => {

    // Act
    const link = fileLink(META, {
        file: 'gone.mjs',
        lines: '4',
    });

    // Assert
    assert.equal(link.url, `https://github.com/owner/repo/blob/${META.mergeBase}/gone.mjs#L3-L5`);
});

test('a replacement character in meta.json stops the run', () => {

    // Arrange
    const path = join(ROOT, 'mojibake.json');

    writeFileSync(path, JSON.stringify({
        ...META,
        branch: 'feature/Pr\uFFFDfung',
    }), 'utf8');

    // Act and Assert
    assert.throws(() => readMeta(path), /branch holds a replacement character; re-run the freeze/);
});

test('the file stem slugs the base like the branch', () => {

    // Act and Assert
    assert.equal(fileStem(META), 'pr-audit-feature-x-release-v0.0.14-staging-0123456');
});

test('the report opens with a coverage not checked or incomplete and says nothing of a complete one', () => {

    // Arrange
    const full = {
        chunks: 3,
        reviewers: {},
        unread: [],
    };
    const partial = {
        chunks: 3,
        reviewers: {},
        unread: [
            {
                name: 'chunk-03.patch',
                files: [
                    'c.mjs',
                    'd.mjs',
                ],
                partlyRead: [
                    'd.mjs',
                ],
                changedLines: 1200,
            },
        ],
    };

    // Act
    const unchecked = buildBody(report());
    const complete = buildBody(report(VERIFIED, [], full));
    const incomplete = buildBody(report(VERIFIED, [], partial));

    // Assert
    assert.match(unchecked, /<blockquote><p><strong>Coverage not checked\.<\/strong> /);
    assert.doesNotMatch(complete, /<blockquote>/);
    assert.match(incomplete, new RegExp('<strong>Incomplete review\\.</strong> No reviewer read 1 of 3 chunks ' +
        '\\(1,200 changed lines\\)\\. These files are unreviewed: <code>c\\.mjs</code>\\. These files are partly ' +
        'unreviewed: <code>d\\.mjs</code>\\.'));
});

test('a reviewer that wrote no file is named in the page and the chat, although its twin read every chunk', () => {

    // Arrange
    const lost = {
        chunks: 3,
        reviewers: {
            1: {
                read: 3,
                missed: [],
                problems: [],
            },
            2: null,
        },
        unread: [],
    };
    const line = 'Reviewer 2 of 2 wrote no candidate file; the report rests on 1 of 2 readings.';

    // Act
    const body = buildBody(report(VERIFIED, [], lost));
    const chat = summary(report().counts, lost, join(ROOT, 'r.html'));

    // Assert
    assert.ok(body.includes(`<strong>Reviewer lost.</strong> ${line}`));
    assert.ok(chat.includes(`**Reviewer lost.** ${line}`));
});

test('the verifiers of a sharded review are merged and ordered by severity', () => {

    // Arrange
    const sharded = join(ROOT, 'sharded');

    mkdirSync(sharded, {
        recursive: true,
    });
    writeFileSync(join(sharded, 'meta.json'), JSON.stringify(META), 'utf8');
    writeFileSync(join(sharded, 'verified-1.json'), JSON.stringify({
        confirmed: [
            entry('Low', 'z.mjs', '1', 'Z', 'z'),
        ],
        open: [],
        refuted: VERIFIED.refuted,
    }), 'utf8');
    writeFileSync(join(sharded, 'verified-2.json'), JSON.stringify({
        confirmed: [
            entry('High', 'b.mjs', '1', 'B', 'b'),
        ],
        open: [
            entry('Medium', 'c.mjs', '1', 'C', 'c'),
        ],
        refuted: [],
    }), 'utf8');

    // Act
    const result = renderReport(sharded, join(ROOT, 'sharded-out'));

    // Assert
    assert.deepEqual(jsonOf(result).confirmed.map(item => item.id), [
        'H-1',
        'L-1',
    ]);
    assert.deepEqual(result.counts, {
        critical: 0,
        high: 1,
        medium: 0,
        low: 1,
        open: 1,
        refuted: 2,
    });
});

test('a verifier file the schema refuses is named in the error and nothing is written', () => {

    // Arrange
    const broken = join(ROOT, 'broken');
    const out = join(ROOT, 'broken-out');

    mkdirSync(broken, {
        recursive: true,
    });
    writeFileSync(join(broken, 'meta.json'), JSON.stringify(META), 'utf8');
    writeFileSync(join(broken, 'verified-1.json'), JSON.stringify(VERIFIED), 'utf8');
    writeFileSync(join(broken, 'verified-2.json'), '{"confirmed": [', 'utf8');

    // Act and Assert
    assert.throws(() => renderReport(broken, out), /^Error: verified-2\.json: not JSON/);
    assert.equal(existsSync(out), false);
});

test('a sharded review whose verifier left no file is refused rather than rendered without its shard', () => {

    // Arrange
    const partial = join(ROOT, 'partial');

    mkdirSync(partial, {
        recursive: true,
    });
    writeFileSync(join(partial, 'meta.json'), JSON.stringify(META), 'utf8');
    writeFileSync(join(partial, 'coverage.json'), JSON.stringify({
        chunks: 2,
        reviewers: {},
        unread: [],
        verifiers: [
            'verified-1.json',
            'verified-2.json',
        ],
    }), 'utf8');
    writeFileSync(join(partial, 'verified-1.json'), JSON.stringify(VERIFIED), 'utf8');

    // Act and Assert
    assert.throws(() => renderReport(partial, join(ROOT, 'partial-out')), /lacks verified-2\.json/);
});

test('the chat summary is ASCII: the counts, an unchecked coverage and the one link, to the HTML', () => {

    // Act
    const result = renderReport(REVIEW, join(ROOT, 'bericht-ä'));

    // Assert
    assert.match(result.summary, /^\*\*PR Review:\*\* 0 Critical, 0 High, 1 Medium, 1 Low, 1 Open, 2 Refuted\.$/m);
    assert.match(result.summary, /^\*\*Coverage not checked\.\*\* /m);
    assert.match(result.summary, /^\*\*Report:\*\* \[PR review \(HTML, opens in browser\)\]\(file:\/\/\/.*\.html\)$/m);
    assert.doesNotMatch(result.summary, /\.json/);
    assert.match(result.summary, /^[\x20-\x7E\n]*$/u);
});

test('the chat summary of an incomplete review counts the unread files and names none', () => {

    // Arrange
    const coverage = {
        chunks: 3,
        reviewers: {},
        unread: [
            {
                name: 'chunk-02.patch',
                files: [
                    'grüße.mjs',
                    'big.mjs',
                ],
                partlyRead: [
                    'big.mjs',
                ],
                changedLines: 10,
            },
        ],
    };

    // Act
    const chat = summary(report().counts, coverage, join(ROOT, 'r.html'));

    // Assert
    assert.match(chat, /^\*\*Incomplete review\.\*\* No reviewer read 1 file, and 1 file only in part; the report names them\.$/m);
    assert.match(chat, /^[\x20-\x7E\n]*$/u);
});

test('the page carries the stylesheet in its style block and no placeholder', () => {

    // Arrange
    const template = '<title>{{TITLE}}</title>\n<style>\n{{CSS}}\n</style>\n{{CONTENT}}';

    // Act
    const page = buildPage(template, 'body { font-family: sans-serif; }', 'A < B', '<p>$&</p>');

    // Assert
    assert.equal(page, '<title>A &lt; B</title>\n<style>\nbody { font-family: sans-serif; }\n</style>\n<p>$&</p>');
});

test('a page template naming a placeholder twice is refused', () => {

    // Act and Assert
    assert.throws(
        () => buildPage('<!-- {{CSS}} -->{{TITLE}}<style>{{CSS}}</style>{{CONTENT}}', '', '', ''),
        /holds \{\{CSS\}\} 2 times/
    );
});

test('the shipped page template fills into a page without a placeholder, from the shared stylesheet', () => {

    // Arrange
    const template = readFileSync(join(HERE, '..', 'templates', 'report.html'), 'utf8');

    // Act
    const page = buildPage(template, '.markdown-body { font-family: sans-serif; }', 'Title', '<p>Body</p>');

    // Assert
    assert.doesNotMatch(page, /\{\{/);
    assert.match(page, /<style>\n\.markdown-body \{ font-family: sans-serif; \}/);
    assert.equal(existsSync(CSS_PATH), true, CSS_PATH);
});
