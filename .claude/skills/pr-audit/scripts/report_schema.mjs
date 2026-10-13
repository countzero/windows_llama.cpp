/**
 * The shape of the two files the workers write, `candidates-reviewer-<n>.json`
 * and `verified.json` or `verified-<n>.json`, which the briefs' *Output
 * format* show by example and this module holds the coverage gate and the
 * renderer to. `report_schema.test.mjs` checks both briefs' examples with it,
 * so a brief and the schema cannot drift apart.
 *
 *   node report_schema.mjs <worker-file>
 *
 * prints `ok`, or every problem the next step would refuse the file for, one a
 * line, and exits 1. A worker runs it before it returns: a model does not count
 * a title's characters reliably, and one unescaped quote makes a file no JSON.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { isMainModule } from './main_module.mjs';

const SEVERITIES = [
    'Critical',
    'High',
    'Medium',
    'Low',
];

/*
 * The leads `reviewer.md` gives a Design observation, in the order the
 * report groups them.
 */
const DESIGN_LEADS = [
    'Scope',
    'Placement',
    'Complexity',
    'Other',
];
const CANDIDATES_FILE = /^candidates-reviewer-(\d+)\.json$/;
const VERIFIED_FILE = /^verified(?:-(\d+))?\.json$/;

/*
 * A `file` goes into a link's text and its URL, so it is one repository path
 * in forward slashes: no whitespace, backtick, pipe or backslash, no leading
 * slash, `./` or drive letter, and no `:<line>`. A worker's prompt names
 * absolute Windows paths, so echoing one is the slip this catches.
 */
const FILE = /^(?![A-Za-z]:)(?!\.{1,2}\/)(?!\/)(?!.*:\d+(-\d+)?$)[^\s`|\\]+$/;
const LINES = /^\d+(-\d+)?(, \d+(-\d+)?)*$/;
const TITLE = /^\S([^\n]*[^.\s])?$/;
const CANDIDATE_ID = /^R(\d+)-\d+$/;
const TOKEN = /^[0-9a-f]{12}$/;
const CHUNK = /^chunk-\d+\.patch$/;

/*
 * A refutation is kept so a reader can overrule it without re-running the
 * review, which needs the candidates it answers and the quoted line with its
 * own `path:line`: a refutation without them is a verdict nobody can check.
 */
const PATH_LINE = /^(?![A-Za-z]:)(?!\/)[^\s`|\\:]+:\d+(-\d+)?$/;

/*
 * A title is the line a reader scans the report by, so it stays one line of
 * a table cell; the description beside it carries the rest.
 */
const TITLE_MAX_GRAPHEMES = 80;
const GRAPHEMES = new Intl.Segmenter('en', {
    granularity: 'grapheme',
});

const text = value => typeof value === 'string' && value.trim() !== '';

/**
 * Names what is wrong with one object of a file: a key it lacks, a key the
 * schema does not know, and a value its rule refuses.
 * @param value - The object.
 * @param rules - Per key a predicate and what the value must be.
 * @param where - Where the object stands, which every problem opens with.
 * @returns The problems.
 */
function objectProblems (value, rules, where) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return [
            `${where}: is not an object`,
        ];
    }

    return [
        ...Object.keys(value).filter(key => !Object.hasOwn(rules, key)).map(key => `${where}: unknown key "${key}"`),
        ...Object.entries(rules).flatMap(([
            key,
            [
                holds,
                must,
            ],
        ]) => {
            if (!Object.hasOwn(value, key)) {
                return [
                    `${where}: lacks ${key}`,
                ];
            }

            return holds(value[key]) ? [] : [
                `${where}: ${key} must be ${must}`,
            ];
        }),
    ];
}

/**
 * Names what is wrong with each element of a list, and with a value that is
 * no list.
 * @param value - The value.
 * @param where - The list's name in the file.
 * @param problemsOf - The element's problems, given the element and its place.
 * @returns The problems.
 */
function listProblems (value, where, problemsOf) {
    if (!Array.isArray(value)) {
        return [
            `${where}: must be a list, [] when empty`,
        ];
    }

    return value.flatMap((element, index) => problemsOf(element, `${where}[${index}]`));
}

const checker = rules => (value, where) => objectProblems(value, rules, where);

const titleFits = value => text(value) && TITLE.test(value) &&
    [
        ...GRAPHEMES.segment(value),
    ].length <= TITLE_MAX_GRAPHEMES;

const LOCATION_RULES = {
    file: [
        value => typeof value === 'string' && FILE.test(value),
        'one repository path in forward slashes, as "examples/server.ps1"',
    ],
    lines: [
        value => typeof value === 'string' && LINES.test(value),
        'HEAD lines as "12", "12-18" or "12-18, 40"',
    ],
};

const ENTRY_RULES = {
    severity: [
        value => SEVERITIES.includes(value),
        `one of ${SEVERITIES.join(', ')}`,
    ],
    ...LOCATION_RULES,
    title: [
        titleFits,
        `one line of at most ${TITLE_MAX_GRAPHEMES} characters, no closing period`,
    ],
    description: [
        text,
        'a non-empty string',
    ],
};

const REFUTED_RULES = {
    ids: [
        value => Array.isArray(value) && value.length > 0 && value.every(id => CANDIDATE_ID.test(id)),
        'the candidate ids, as ["R1-4", "R2-1"]',
    ],
    ...LOCATION_RULES,
    quotePath: [
        value => typeof value === 'string' && PATH_LINE.test(value),
        'the quoted line\'s own "path:line", as "examples/server.ps1:177"',
    ],
    quote: [
        text,
        'the contradicting line, verbatim',
    ],
    reason: [
        text,
        'the sentence that makes the quote a contradiction',
    ],
};

const CANDIDATE_RULES = {
    id: [
        value => typeof value === 'string' && CANDIDATE_ID.test(value),
        'the reviewer number and a count, as "R1-1"',
    ],
    ...LOCATION_RULES,
    claim: [
        text,
        'a non-empty string',
    ],
    evidence: [
        text,
        'a non-empty string',
    ],
};

const DESIGN_RULES = {
    lead: [
        value => DESIGN_LEADS.includes(value),
        `one of ${DESIGN_LEADS.join(', ')}`,
    ],
    text: [
        text,
        'a non-empty string',
    ],
};

const COVERAGE_RULES = {
    chunk: [
        value => typeof value === 'string' && CHUNK.test(value),
        'a chunk\'s name, as "chunk-01.patch"',
    ],
    token: [
        value => typeof value === 'string' && TOKEN.test(value),
        'the 12 hex digits after "token" on the chunk\'s last line',
    ],
};

/**
 * Names what is wrong with a reviewer's file; a candidate whose id carries
 * another reviewer's number among it.
 * @param data - The parsed file.
 * @param name - The file's name.
 * @param reviewer - The reviewer number the file name carries, or null.
 * @returns The problems.
 */
function candidatesProblems (data, name, reviewer) {
    const top = objectProblems(data, {
        candidates: [
            Array.isArray,
            'a list, [] when empty',
        ],
        design: [
            Array.isArray,
            'a list, [] when empty',
        ],
        coverage: [
            Array.isArray,
            'a list',
        ],
    }, name);

    if (top.length > 0) {
        return top;
    }

    const foreign = reviewer === null ? [] : data.candidates
        .map((candidate, index) => [
            candidate?.id,
            index,
        ])
        .filter(([
            id,
        ]) => CANDIDATE_ID.test(id ?? '') && Number(CANDIDATE_ID.exec(id)[1]) !== reviewer)
        .map(([
            id,
            index,
        ]) => `${name} candidates[${index}]: id ${id} is not reviewer ${reviewer}'s`);

    return [
        ...listProblems(data.candidates, `${name} candidates`, checker(CANDIDATE_RULES)),
        ...foreign,
        ...listProblems(data.design, `${name} design`, checker(DESIGN_RULES)),
        ...listProblems(data.coverage, `${name} coverage`, checker(COVERAGE_RULES)),
    ];
}

/**
 * Names what is wrong with a verifier's file.
 * @param data - The parsed file.
 * @param name - The file's name.
 * @returns The problems.
 */
function verifiedProblems (data, name) {
    const top = objectProblems(data, {
        confirmed: [
            Array.isArray,
            'a list, [] when empty',
        ],
        open: [
            Array.isArray,
            'a list, [] when empty',
        ],
        refuted: [
            Array.isArray,
            'a list, [] when empty',
        ],
    }, name);

    if (top.length > 0) {
        return top;
    }

    return [
        ...listProblems(data.confirmed, `${name} confirmed`, checker(ENTRY_RULES)),
        ...listProblems(data.open, `${name} open`, checker(ENTRY_RULES)),
        ...listProblems(data.refuted, `${name} refuted`, checker(REFUTED_RULES)),
    ];
}

/**
 * Parses a worker's file. A text that is no JSON is named with the position
 * the parser stopped at, which is where an unescaped quote breaks it.
 * @param raw - The file's contents.
 * @param name - The file's name.
 * @returns The data, or null with the problem recorded.
 */
function parseJson (raw, name) {
    try {
        return {
            data: JSON.parse(raw.replace(/^\uFEFF/, '')),
            problems: [],
        };
    } catch (error) {
        return {
            data: null,
            problems: [
                `${name}: not JSON: ${error instanceof Error ? error.message : String(error)}`,
            ],
        };
    }
}

/**
 * Throws every problem as one error, which carries them as a list.
 * @param problems - The problems.
 */
function refuse (problems) {
    if (problems.length > 0) {
        throw Object.assign(new Error(problems.join('; ')), {
            problems,
        });
    }
}

/**
 * Reads a reviewer's file.
 * @param raw - The file's contents.
 * @param name - The file's name, which every problem opens with.
 * @returns The candidates, the Design observations and the coverage tokens.
 */
function parseCandidates (raw, name = 'candidates-reviewer-1.json') {
    const { data, problems } = parseJson(raw, name);
    const number = CANDIDATES_FILE.exec(name)?.[1];
    const reviewer = number === undefined ? null : Number(number);

    refuse(data === null ? problems : candidatesProblems(data, name, reviewer));

    return data;
}

/**
 * Reads a verifier's file.
 * @param raw - The file's contents.
 * @param name - The file's name, which every problem opens with.
 * @returns The confirmed, the open and the refuted entries.
 */
function parseVerified (raw, name = 'verified.json') {
    const { data, problems } = parseJson(raw, name);

    refuse(data === null ? problems : verifiedProblems(data, name));

    return data;
}

/**
 * Compares two strings by their code units, which no host locale changes, so
 * a re-render gives the same bytes on every machine.
 * @param left - A string.
 * @param right - Another.
 * @returns Negative, zero or positive.
 */
function byCodeUnit (left, right) {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
}

/**
 * Orders entries by severity and then by file, keeping the verifier's order
 * within one file. A single verifier's file goes through it too: its order
 * is the model's, which nothing else checks.
 * @param entries - The entries of one or several verifiers.
 * @returns The entries.
 */
function ordered (entries) {
    return entries
        .map((entry, index) => ({
            entry,
            index,
        }))
        .sort((left, right) => SEVERITIES.indexOf(left.entry.severity) - SEVERITIES.indexOf(right.entry.severity) ||
            byCodeUnit(left.entry.file, right.entry.file) ||
            left.index - right.index)
        .map(({ entry }) => entry);
}

/**
 * Merges the verifiers' files into one, ordered as one.
 * @param parts - The parsed files, in verifier order.
 * @returns The confirmed, the open and the refuted entries.
 */
function mergeVerified (parts) {
    return {
        confirmed: ordered(parts.flatMap(part => part.confirmed)),
        open: ordered(parts.flatMap(part => part.open)),
        refuted: parts.flatMap(part => part.refuted),
    };
}

/**
 * Picks the schema a worker's file is held to by its name.
 * @param name - The file's name.
 * @returns The parser.
 */
function parserOf (name) {
    if (CANDIDATES_FILE.test(name)) {
        return parseCandidates;
    }

    if (VERIFIED_FILE.test(name)) {
        return parseVerified;
    }

    throw new Error(`${name}: is neither candidates-reviewer-<n>.json nor verified[-<n>].json`);
}

/**
 * Checks a worker's file as the next step reads it, the schema chosen by the
 * file's name.
 * @param path - The file.
 * @returns Whether it holds, and `ok` or every problem, one a line.
 */
function checkFile (path) {
    const name = basename(path);

    try {
        parserOf(name)(readFileSync(path, 'utf8'), name);

        return {
            ok: true,
            lines: [
                'ok',
            ],
        };
    } catch (error) {
        return {
            ok: false,
            lines: error?.problems ?? [
                error instanceof Error ? error.message : String(error),
            ],
        };
    }
}

if (isMainModule(import.meta.url)) {
    const [
        path,
    ] = process.argv.slice(2);

    if (path === undefined) {
        process.stderr.write('usage: node report_schema.mjs <worker-file>\n');
        process.exit(2);
    }

    const { ok, lines } = checkFile(path);

    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = ok ? 0 : 1;
}

export {
    CANDIDATES_FILE,
    checkFile,
    DESIGN_LEADS,
    mergeVerified,
    parseCandidates,
    parseVerified,
    SEVERITIES,
    TITLE_MAX_GRAPHEMES,
    VERIFIED_FILE,
};
