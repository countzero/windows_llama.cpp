#!/usr/bin/env node
/**
 * Renders a pr-audit report from the workers' JSON.
 *
 *   node render_report.mjs <review-dir> --out <directory>
 *
 * `<review-dir>` holds `meta.json` (the run's facts, written when the inputs
 * were frozen), `verified.json` or one `verified-<n>.json` per shard (merged
 * into one report), every `candidates-reviewer-<n>.json`, whose Design
 * observations print grouped by their lead and tagged with their reviewer,
 * and `coverage.json` when the coverage gate wrote one.
 *
 * Two files land in `--out`. `<stem>.json` is the whole result: every
 * confirmed finding of every severity, the open and the refuted entries with
 * their quotes, the Design observations, the coverage and the run's facts;
 * a caller that acts on the review reads it, and it outlives the next
 * freeze, which empties the review directory. `<stem>.html` is what a person
 * reads: the findings of Medium and above, the Design and the coverage, with
 * the Low, the open and the refuted only counted. Their paths, the counts and
 * the chat summary are printed as JSON on stdout.
 *
 * Both files depend on the review directory alone, the time included, which
 * is `meta.json`'s `frozenAt`, so a re-render gives the same bytes. Anything
 * that can go wrong stops the run before the first byte reaches the disk,
 * because a report with a hole in it would read as a review that found less.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMainModule } from './main_module.mjs';
import {
    CANDIDATES_FILE,
    DESIGN_LEADS,
    mergeVerified,
    parseCandidates,
    parseVerified,
    SEVERITIES,
    VERIFIED_FILE,
} from './report_schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(HERE, '..', 'templates', 'report.html');

/*
 * Its presence is checked by `render_report.test.mjs`, so a move fails a test
 * and not the next report.
 */
const CSS_PATH = join(HERE, '..', 'templates', 'github-markdown.css');
const GLYPHS = {
    Critical: '🔴',
    High: '🟠',
    Medium: '🟡',
    Low: '⚪',
    Open: '🔵',
};

/*
 * The severities the HTML lists; the rest stand in the JSON and are counted
 * on the page. On a large diff the Low findings are most of the report, and a
 * reader skimming them gives back what the second reviewer won.
 */
const SHOWN_SEVERITIES = [
    'Critical',
    'High',
    'Medium',
];

/*
 * The info octicon GitHub puts in the title of a `> [!NOTE]`.
 */
const NOTE_ICON = '<svg class="octicon octicon-info" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
    '<path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 ' +
    '7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75Z' +
    'M8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>';
const ID_PREFIXES = {
    Critical: 'C',
    High: 'H',
    Medium: 'M',
    Low: 'L',
    Open: 'O',
};
const REQUIRED_META_KEYS = [
    'branch',
    'base',
    'head',
    'mergeBase',
    'deleted',
    'owner',
    'repo',
    'filesChanged',
    'additions',
    'deletions',
    'frozenAt',
];
const FROZEN_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const OPTION_KEYS = {
    '--out': 'out',
};
const SHORT_SHA_LENGTH = 7;
const CONTEXT_LINES = 1;
const MINUTE_PRECISION = 'YYYY-MM-DDTHH:MM'.length;
const JSON_INDENT = 4;

/**
 * Reads the command line.
 * @param argv - The arguments after the script path.
 * @returns The resolved review directory and output directory.
 */
function parseArguments (argv) {
    const options = {
        reviewDir: null,
        out: null,
    };

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        const key = OPTION_KEYS[argument];

        if (key !== undefined) {
            options[key] = argv[++index] ?? null;
        } else if (options.reviewDir === null) {
            options.reviewDir = argument;
        } else {
            throw new Error(`Unexpected argument: ${argument}`);
        }
    }

    if (options.reviewDir === null || options.out === null) {
        throw new Error('Usage: render_report.mjs <review-dir> --out <directory>');
    }

    return {
        reviewDir: resolve(options.reviewDir),
        out: resolve(options.out),
    };
}

/**
 * Reads a UTF-8 file with its byte order mark dropped and its line endings normalized.
 * @param path - The file to read.
 * @returns The contents.
 */
function readText (path) {
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/**
 * Refuses a `meta.json` that lacks one of the facts the report needs, or
 * whose text went through a console code page on its way to the disk.
 * @param meta - The parsed file.
 */
function checkMetaKeys (meta) {
    for (const key of REQUIRED_META_KEYS) {
        if (meta[key] === undefined || meta[key] === null) {
            throw new Error(`meta.json lacks ${key}`);
        }
    }

    for (const [
        key,
        value,
    ] of Object.entries(meta)) {
        if (typeof value === 'string' && value.includes('\uFFFD')) {
            throw new Error(`meta.json: ${key} holds a replacement character; re-run the freeze, ` +
                'node <scripts>/freeze.mjs <review>, which writes meta.json as UTF-8');
        }
    }
}

/**
 * Reads a non-negative integer out of `meta.json`.
 * @param meta - The parsed file.
 * @param key - The key.
 * @returns The integer.
 */
function count (meta, key) {
    const value = Number(meta[key]);

    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`meta.json: ${key} is not a count`);
    }

    return value;
}

/**
 * Refuses a `meta.json` whose commits, deleted files or time the report
 * could not use.
 * @param meta - The parsed file.
 */
function checkMetaShapes (meta) {
    for (const key of [
        'head',
        'mergeBase',
    ]) {
        if (!(/^[0-9a-f]{40}$/).test(meta[key])) {
            throw new Error(`meta.json: ${key} is not a 40-character SHA`);
        }
    }

    if (!Array.isArray(meta.deleted) || !meta.deleted.every(file => typeof file === 'string')) {
        throw new Error('meta.json: deleted is not a list of paths');
    }

    if (!FROZEN_AT_PATTERN.test(meta.frozenAt)) {
        throw new Error('meta.json: frozenAt is not YYYY-MM-DDTHH:MM:SS±HH:MM');
    }
}

/**
 * Reads and checks `meta.json`.
 * @param path - The file to read.
 * @returns The run's facts.
 */
function readMeta (path) {
    const meta = JSON.parse(readText(path));

    checkMetaKeys(meta);

    checkMetaShapes(meta);

    return {
        branch: meta.branch,
        base: meta.base,
        head: meta.head,
        mergeBase: meta.mergeBase,
        deleted: meta.deleted,
        pr: meta.pr ?? null,
        owner: meta.owner,
        repo: meta.repo,
        filesChanged: count(meta, 'filesChanged'),
        additions: count(meta, 'additions'),
        deletions: count(meta, 'deletions'),
        frozenAt: meta.frozenAt,
    };
}

/**
 * Lists the files of a review directory a pattern names, in the order of the
 * number it captures.
 * @param reviewDir - The review directory.
 * @param pattern - The file pattern, its first group the number.
 * @returns The names.
 */
function numberedFiles (reviewDir, pattern) {
    const order = name => Number(pattern.exec(name)[1] ?? 0);

    return readdirSync(reviewDir)
        .filter(name => pattern.test(name))
        .sort((left, right) => order(left) - order(right));
}

/**
 * Collects the Design observations of every reviewer, in reviewer order,
 * each tagged with its reviewer; a reviewer that wrote no file contributes
 * nothing.
 * @param reviewDir - The review directory.
 * @returns The observations.
 */
function readDesign (reviewDir) {
    return numberedFiles(reviewDir, CANDIDATES_FILE).flatMap(name => parseCandidates(
        readText(join(reviewDir, name)),
        name
    ).design.map(observation => ({
        ...observation,
        reviewer: Number(CANDIDATES_FILE.exec(name)[1]),
    })));
}

/**
 * Reads the verifiers' output: `verified.json`, or one `verified-<n>.json`
 * per shard, merged. A file the schema refuses stops the run under its name,
 * and so does a file the coverage gate asked a verifier for that is not there.
 * @param reviewDir - The review directory.
 * @param coverage - The coverage check's output, or null when none ran.
 * @returns The confirmed, the open and the refuted entries.
 */
function readVerified (reviewDir, coverage) {
    const names = numberedFiles(reviewDir, VERIFIED_FILE);

    if (names.length === 0) {
        throw new Error('the review directory holds no verified.json');
    }

    const missing = (coverage?.verifiers ?? []).filter(name => !names.includes(name));

    if (missing.length > 0) {
        throw new Error(`the review directory lacks ${missing.join(', ')}, which the coverage gate asked a verifier ` +
            'for; its candidates would be missing from the report');
    }

    return mergeVerified(names.map(name => parseVerified(readText(join(reviewDir, name)), name)));
}

/**
 * Reads `coverage.json` when the coverage gate wrote one.
 * @param reviewDir - The review directory.
 * @returns The coverage, or null.
 */
function readCoverage (reviewDir) {
    const path = join(reviewDir, 'coverage.json');

    return existsSync(path) ? JSON.parse(readText(path)) : null;
}

/**
 * Names the report files, the refs slugged so that a `/` makes no directory.
 * @param meta - The run's facts.
 * @returns The stem shared by the JSON and the HTML file.
 */
function fileStem (meta) {
    const slug = ref => ref.replace(/\//g, '-').toLowerCase();
    return `pr-audit-${slug(meta.branch)}-${slug(meta.base)}-${meta.head.slice(0, SHORT_SHA_LENGTH).toLowerCase()}`;
}

/**
 * Builds a finding's link: the span from the first line named to the last,
 * linked into the blob at HEAD with one line of context on either side, which
 * shows the lines whether or not the pull request's diff touches them. The
 * text states the lines named, not the widened span. A file the diff deletes
 * links into its last version, at the merge-base.
 * @param meta - The run's facts.
 * @param item - A confirmed or open entry.
 * @returns The link's text and URL.
 */
function fileLink (meta, item) {
    const numbers = item.lines.split(/[-,]/).map(Number);
    const first = Math.min(...numbers);
    const last = Math.max(...numbers);
    const start = Math.max(1, first - CONTEXT_LINES);
    const end = last + CONTEXT_LINES;
    const commit = meta.deleted.includes(item.file) ? meta.mergeBase : meta.head;
    const path = item.file.split('/').map(encodeURIComponent).join('/');

    return {
        text: `/${item.file}:${first === last ? first : `${first}-${last}`}`,
        url: `https://github.com/${meta.owner}/${meta.repo}/blob/${commit}/${path}#L${start}-L${end}`,
    };
}

/**
 * Counts the findings per severity, plus the open and the refuted
 * candidates, a refuted entry standing for every id it carries.
 * @param verified - The merged verifiers' entries.
 * @returns The counts, keyed by lowercase severity, `open` and `refuted`.
 */
function countFindings (verified) {
    const counts = Object.fromEntries(SEVERITIES.map(severity => [
        severity.toLowerCase(),
        verified.confirmed.filter(item => item.severity === severity).length,
    ]));

    counts.open = verified.open.length;
    counts.refuted = verified.refuted.reduce((sum, entry) => sum + entry.ids.length, 0);

    return counts;
}

/**
 * Gives every confirmed entry an id of its severity's letter and its place,
 * `H-1`, and every open one `O-1`, so a reader can name a finding. The ids
 * hold within one report; a new run numbers anew.
 * @param verified - The merged verifiers' entries.
 * @returns The entries with their ids.
 */
function withIds (verified) {
    const place = {};
    const idOf = prefix => {
        place[prefix] = (place[prefix] ?? 0) + 1;

        return `${prefix}-${place[prefix]}`;
    };

    return {
        confirmed: verified.confirmed.map(item => ({
            id: idOf(ID_PREFIXES[item.severity]),
            ...item,
        })),
        open: verified.open.map(item => ({
            id: idOf(ID_PREFIXES.Open),
            ...item,
        })),
        refuted: verified.refuted,
    };
}

/**
 * Names the reviewers that wrote no candidate file. On a diff read whole the
 * other reviewer still reads every chunk, so nothing counts as unread, and
 * the report would pass for two readings when it rests on one.
 * @param coverage - The coverage check's output.
 * @returns The notice, or null when every reviewer wrote its file.
 */
function lostReviewers (coverage) {
    const lost = Object.entries(coverage.reviewers)
        .filter(([
            , result,
        ]) => result === null)
        .map(([
            reviewer,
        ]) => reviewer);

    if (lost.length === 0) {
        return null;
    }

    const total = Object.keys(coverage.reviewers).length;
    const names = lost.length === 1 ? `Reviewer ${lost[0]}` : `Reviewers ${lost.join(', ')}`;

    return {
        lead: 'Reviewer lost.',
        text: `${names} of ${total} wrote no candidate file; the report rests on ${total - lost.length} of ` +
            `${total} readings.`,
    };
}

/**
 * Splits the files of the unread chunks into those no reviewer read any part
 * of and those a read chunk holds another part of.
 * @param coverage - The coverage check's output.
 * @returns The unreviewed and the partly unreviewed files.
 */
function unreadFiles (coverage) {
    const partly = new Set(coverage.unread.flatMap(chunk => chunk.partlyRead ?? []));
    const all = [
        ...new Set(coverage.unread.flatMap(chunk => chunk.files)),
    ];

    return {
        unreviewed: all.filter(file => !partly.has(file)),
        partly: all.filter(file => partly.has(file)),
    };
}

/**
 * Builds the notices that open a report that lost a reviewer, whose reviewers
 * left chunks unread, naming the files no finding can speak for, or whose
 * coverage was never checked.
 * @param coverage - The coverage check's output, or null.
 * @returns The notices, each a bold lead and a text; none for a complete review.
 */
function coverageNotices (coverage) {
    if (coverage === null) {
        return [
            {
                lead: 'Coverage not checked.',
                text: 'No coverage gate ran, so nothing shows that every chunk of the diff was read.',
            },
        ];
    }

    const lost = lostReviewers(coverage);
    const notices = lost === null ? [] : [
        lost,
    ];

    if (coverage.unread.length === 0) {
        return notices;
    }

    const { unreviewed, partly } = unreadFiles(coverage);
    const lines = coverage.unread.reduce((sum, chunk) => sum + chunk.changedLines, 0);
    const named = files => files.map(file => `\`${file}\``).join(', ');
    const whole = unreviewed.length === 0 ? '' : ` These files are unreviewed: ${named(unreviewed)}.`;
    const inPart = partly.length === 0 ? '' : ` These files are partly unreviewed: ${named(partly)}.`;

    return [
        ...notices,
        {
            lead: 'Incomplete review.',
            text: `No reviewer read ${coverage.unread.length} of ${coverage.chunks} chunks ` +
                `(${lines.toLocaleString('en-US')} changed lines).${whole}${inPart}`,
        },
    ];
}

/**
 * Builds the report's data, the one source both files are written from.
 * @param meta - The run's facts.
 * @param verified - The merged verifiers' entries.
 * @param design - The tagged Design observations.
 * @param coverage - The coverage check's output, or null when none ran.
 * @returns The report.
 */
function buildReport (meta, verified, design, coverage = null) {
    return {
        meta,
        counts: countFindings(verified),
        coverage,
        notices: coverageNotices(coverage),
        design,
        ...withIds(verified),
    };
}

/**
 * Escapes the characters that would break out of an HTML text node or a
 * double-quoted attribute.
 * @param text - The text.
 * @returns The text as HTML.
 */
function escapeHtml (text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Renders a worker's text: escaped, its backtick code spans as `<code>`, the
 * one markup the briefs let a worker use.
 * @param text - A title, a description, an observation or a notice.
 * @returns The HTML.
 */
function inline (text) {
    return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * Renders a link.
 * @param url - The target.
 * @param html - The link's content, already HTML.
 * @returns The HTML.
 */
const anchor = (url, html) => `<a href="${escapeHtml(url)}">${html}</a>`;

/**
 * Renders a table.
 * @param headers - The header cells, as text.
 * @param rows - The body rows, each cell already HTML.
 * @param className - The table's class, or null.
 * @returns The HTML.
 */
function table (headers, rows, className = null) {
    const opening = className === null ? '<table>' : `<table class="${className}">`;

    return [
        opening,
        `<thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>`,
        '<tbody>',
        ...rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`),
        '</tbody>',
        '</table>',
    ].join('\n');
}

/**
 * Builds the Findings cell: a count per severity the page lists, linked to
 * its section when it holds a finding. What the page leaves out is counted in
 * the note at its bottom.
 * @param counts - The finding counts.
 * @returns The cell's HTML.
 */
function findingsCell (counts) {
    return SHOWN_SEVERITIES.map(section => {
        const key = section.toLowerCase();
        const label = `${counts[key]} ${section}`;

        return `${GLYPHS[section]} ${counts[key] > 0 ? anchor(`#${key}`, label) : label}`;
    }).join(' · ');
}

/**
 * Builds the metadata table under the report's heading. The diff's counts
 * stand in `<ins>` and `<del>`, which the page template colors as GitHub
 * colors a diff.
 * @param meta - The run's facts.
 * @param counts - The finding counts.
 * @returns The HTML.
 */
function metadataTable (meta, counts) {
    const github = `https://github.com/${meta.owner}/${meta.repo}`;
    const head7 = meta.head.slice(0, SHORT_SHA_LENGTH);
    const number = value => value.toLocaleString('en-US');
    const code = text => `<code>${escapeHtml(text)}</code>`;
    const none = code('none');

    return table([
        'Field',
        'Value',
    ], [
        [
            'Branch',
            `${anchor(`${github}/tree/${meta.branch}`, code(meta.branch))} → ${
                anchor(`${github}/tree/${meta.base}`, code(meta.base))}`,
        ],
        [
            'HEAD',
            anchor(`${github}/commit/${head7}`, code(head7)),
        ],
        [
            'PR',
            meta.pr === null ? none : anchor(`${github}/pull/${meta.pr}`, code(`#${meta.pr}`)),
        ],
        [
            'Generated',
            meta.frozenAt.slice(0, MINUTE_PRECISION).replace('T', ' '),
        ],
        [
            'Diff',
            `${meta.filesChanged} files · <ins>+${number(meta.additions)}</ins> · ` +
                `<del>−${number(meta.deletions)}</del>`,
        ],
        [
            'Findings',
            findingsCell(counts),
        ],
    ].map(([
        field,
        value,
    ]) => [
        escapeHtml(field),
        value,
    ]));
}

/**
 * States, in a note as GitHub renders `> [!NOTE]`, what the page leaves out
 * and where it stands: the Low findings, the open entries and the refuted
 * candidates, all in the JSON beside the page, each refutation with its
 * quoted line so a reader can overrule it.
 * @param counts - The finding counts.
 * @param stem - The report's file stem.
 * @returns The HTML, or none when nothing is left out.
 */
function leftOutNote (counts, stem) {
    const parts = [
        [
            counts.low,
            'Low finding',
            'Low findings',
        ],
        [
            counts.open,
            'open entry',
            'open entries',
        ],
        [
            counts.refuted,
            'refuted candidate',
            'refuted candidates',
        ],
    ].filter(([
        size,
    ]) => size > 0).map(([
        size,
        one,
        many,
    ]) => `${size} ${size === 1 ? one : many}`);

    if (parts.length === 0) {
        return [];
    }

    const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
    const quotes = counts.refuted === 0 ? '' : ', each refutation with its quoted line';

    return [
        '<div class="markdown-alert markdown-alert-note">',
        `<p class="markdown-alert-title">${NOTE_ICON}Note</p>`,
        `<p>Not listed here: ${escapeHtml(listed)}. They stand in <code>${escapeHtml(stem)}.json</code> beside ` +
            `this page${quotes}.</p>`,
        '</div>',
    ];
}

/**
 * Builds the Design section, its observations grouped under a subheading per
 * lead, in the order of the leads; a lead without observations is omitted.
 * @param design - The tagged observations.
 * @returns The HTML.
 */
function designSection (design) {
    const groups = DESIGN_LEADS.map(lead => [
        lead,
        design.filter(observation => observation.lead === lead),
    ]).filter(([
        , observations,
    ]) => observations.length > 0);

    return [
        '<h3 id="design">Design</h3>',
        ...groups.length === 0 ? [
            '<p>None.</p>',
        ] : groups.flatMap(([
            lead,
            observations,
        ]) => [
            `<h4 id="${lead.toLowerCase()}">${lead}</h4>`,
            '<ul>',
            ...observations.map(observation => `<li>${inline(observation.text)} (R${observation.reviewer})</li>`),
            '</ul>',
        ]),
    ];
}

/**
 * Builds one table per severity the page lists, each omitted when it holds
 * nothing. A row's cell stacks the link, the bold title and the description,
 * so the path takes the whole width and the title reads on its own.
 * @param meta - The run's facts.
 * @param confirmed - The confirmed entries, with their ids.
 * @returns The HTML.
 */
function findingSections (meta, confirmed) {
    const shown = confirmed.filter(item => SHOWN_SEVERITIES.includes(item.severity));

    if (shown.length === 0) {
        return [
            '<p>No confirmed finding of Medium or above.</p>',
        ];
    }

    return SHOWN_SEVERITIES.flatMap(severity => {
        const items = shown.filter(item => item.severity === severity);

        return items.length === 0 ? [] : [
            `<h3 id="${severity.toLowerCase()}">${severity}</h3>`,
            table([
                'ID',
                'Finding',
            ], items.map(item => {
                const link = fileLink(meta, item);

                return [
                    escapeHtml(item.id),
                    `${anchor(link.url, escapeHtml(link.text))}<br><br><strong>${inline(item.title)}</strong>` +
                        `<br><br>${inline(item.description)}`,
                ];
            }), 'findings'),
        ];
    });
}

/**
 * Words the report's title.
 * @param meta - The run's facts.
 * @returns The title.
 */
const titleOf = meta => `${meta.branch} (vs ${meta.base})`;

/**
 * Builds the page's body from the report.
 * @param report - The report.
 * @returns The HTML.
 */
function buildBody (report) {
    return [
        '<h1>PR Review</h1>',
        `<h2>${escapeHtml(titleOf(report.meta))}</h2>`,
        ...report.notices.map(notice => `<blockquote><p><strong>${escapeHtml(notice.lead)}</strong> ` +
            `${inline(notice.text)}</p></blockquote>`),
        metadataTable(report.meta, report.counts),
        ...designSection(report.design),
        ...findingSections(report.meta, report.confirmed),
        ...leftOutNote(report.counts, fileStem(report.meta)),
        '',
    ].join('\n');
}

/**
 * Fills the page template. Each placeholder must appear exactly once: a
 * second one, in a comment say, would take the stylesheet and leave the
 * style block holding the placeholder's name.
 * @param template - The page template.
 * @param css - The stylesheet.
 * @param title - The page title.
 * @param content - The rendered body.
 * @returns The page.
 */
function buildPage (template, css, title, content) {
    const values = {
        '{{TITLE}}': escapeHtml(title),
        '{{CSS}}': css,
        '{{CONTENT}}': content,
    };

    for (const placeholder of Object.keys(values)) {
        const occurrences = template.split(placeholder).length - 1;

        if (occurrences !== 1) {
            throw new Error(`the page template holds ${placeholder} ${occurrences} times, not once`);
        }
    }

    return template.replace(/\{\{(?:TITLE|CSS|CONTENT)\}\}/g, placeholder => values[placeholder]);
}

/**
 * Words the chat message that stands for the report: the counts, a reviewer
 * lost, a coverage that was not checked or not complete, and the link to the
 * page. The report itself is read in the browser, since retyping it into the
 * chat takes minutes on a large diff. It is ASCII by construction, because it
 * reaches the orchestrator through the console, which on a German Windows
 * host turns every glyph and middle dot into `?`: it names no file, and its
 * link is a file URL, which percent-encodes every other character.
 * @param counts - The finding counts.
 * @param coverage - The coverage check's output, or null.
 * @param htmlPath - The page.
 * @returns The message.
 */
function summary (counts, coverage, htmlPath) {
    const findings = SEVERITIES.map(severity => `${counts[severity.toLowerCase()]} ${severity}`)
        .concat(`${counts.open} Open`, `${counts.refuted} Refuted`)
        .join(', ');
    const lines = [
        `**PR Review:** ${findings}.`,
    ];
    const lost = coverage === null ? null : lostReviewers(coverage);

    if (lost !== null) {
        lines.push('', `**${lost.lead}** ${lost.text}`);
    }

    if (coverage === null) {
        lines.push('', '**Coverage not checked.** No coverage gate ran, so nothing shows every chunk was read.');
    } else if (coverage.unread.length > 0) {
        const { unreviewed, partly } = unreadFiles(coverage);
        const files = size => `${size} ${size === 1 ? 'file' : 'files'}`;
        const inPart = partly.length === 0 ? '' : `, and ${files(partly.length)} only in part`;

        lines.push('', `**Incomplete review.** No reviewer read ${files(unreviewed.length)}${inPart}; ` +
            'the report names them.');
    }

    lines.push('', `**Report:** [PR review (HTML, opens in browser)](${pathToFileURL(htmlPath).href})`);

    return lines.join('\n');
}

/**
 * Renders the report of a review directory into `out`: both files are built
 * before either is written.
 * @param reviewDir - The review directory.
 * @param out - The output directory.
 * @returns The paths, the counts and the chat message.
 */
function renderReport (reviewDir, out) {
    const meta = readMeta(join(reviewDir, 'meta.json'));
    const coverage = readCoverage(reviewDir);
    const report = buildReport(meta, readVerified(reviewDir, coverage), readDesign(reviewDir), coverage);
    const page = buildPage(
        readText(TEMPLATE_PATH),
        readText(CSS_PATH),
        `PR Review: ${titleOf(meta)}`,
        buildBody(report)
    );
    const stem = fileStem(meta);
    const jsonPath = join(out, `${stem}.json`);
    const htmlPath = join(out, `${stem}.html`);

    mkdirSync(out, {
        recursive: true,
    });
    writeFileSync(jsonPath, `${JSON.stringify(report, null, JSON_INDENT)}\n`, 'utf8');
    writeFileSync(htmlPath, page, 'utf8');

    return {
        json: jsonPath,
        html: htmlPath,
        counts: report.counts,
        summary: summary(report.counts, coverage, htmlPath),
    };
}

/**
 * Runs the render from the command line.
 */
function main () {
    const { reviewDir, out } = parseArguments(process.argv.slice(2));

    process.stdout.write(`${JSON.stringify(renderReport(reviewDir, out), null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
    main();
}

export {
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
};
