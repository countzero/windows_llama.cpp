/**
 * Words the Task prompts of the workers, so that a prompt names exactly the
 * files the manifest and the disk hold and nothing the orchestrator retypes
 * can drift from them. Why a sharded diff gets one verifier per shard is
 * `SKILL.md` → *Workers*.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(SCRIPTS, '..', 'prompts');

/**
 * The boundaries every worker keeps. They travel in the prompt rather than in
 * the agent definitions, so that each harness's definition is a header alone
 * and a worker spawned as a general agent keeps them too.
 */
const BOUNDARIES = readFileSync(join(PROMPTS, 'boundaries.md'), 'utf8').trim();

/**
 * Words the format check a worker runs on its output, by absolute paths so it
 * runs from any working directory.
 * @param output - The worker's output file.
 * @returns The command.
 */
const formatCheck = output => `node "${join(SCRIPTS, 'report_schema.mjs')}" "${output}"`;

/**
 * Words one reviewer's prompt.
 * @param reviewDir - The absolute review directory.
 * @param assignment - The manifest's entry: `reviewer` and its `chunks`.
 * @returns The prompt.
 */
function reviewerPrompt (reviewDir, assignment) {
    return [
        `Review a pull request. Read the brief at ${join(PROMPTS, 'reviewer.md')} and follow it.`,
        '',
        `- reviewer: ${assignment.reviewer}`,
        `- intent: ${join(reviewDir, 'intent.md')}`,
        `- chunks: ${join(reviewDir, 'chunks')}; yours are ${assignment.chunks.join(', ')}`,
        `- manifest: ${join(reviewDir, 'manifest.json')}, every chunk's files`,
        `- output: ${join(reviewDir, `candidates-reviewer-${assignment.reviewer}.json`)}`,
        `- format check: ${formatCheck(join(reviewDir, `candidates-reviewer-${assignment.reviewer}.json`))}`,
        '',
        'Write the output file in the brief\'s format. Your final message is the one line ' +
            '"written: <n> candidates and <m> observations".',
        '',
        BOUNDARIES,
    ].join('\n');
}

/**
 * Words the prompt that resumes a reviewer which left chunks of its own unread.
 * It opens by reading the output file because a harness without a handle
 * spawns a fresh reviewer, which holds no earlier candidate in its context and
 * would otherwise overwrite them.
 * A file the schema refused lists no token, so its reviewer is resumed on
 * every chunk and told what the check found.
 * @param missed - The chunk names.
 * @param problems - What the format check refused the file for, none for a file it took.
 * @returns The prompt.
 */
function resumePrompt (missed, problems = []) {
    const refused = problems.length === 0 ? '' : `The format check refused your output file: ${problems.join('; ')}. `;

    return `${refused}First read your output file as it stands, and keep every candidate, observation and coverage token in ` +
        `it. Then read these chunks to their last line: ${missed.join(', ')}. Rewrite your output file whole, in ` +
        'the brief\'s format: the earlier candidates and the new ones in the one `candidates` list, the earlier ' +
        'tokens and those of these chunks in the one `coverage` list, and run the format check until it prints ok.';
}

/**
 * Words one verifier's prompt.
 * @param reviewDir - The absolute review directory.
 * @param chunkCount - The number of chunks.
 * @param reviewers - The reviewers whose candidates it verifies.
 * @param output - The file it writes, relative to the review directory.
 * @returns The prompt.
 */
function verifierPrompt (reviewDir, chunkCount, reviewers, output) {
    return [
        `Verify the candidates of a pull request review. Read the brief at ${join(PROMPTS, 'verifier.md')} ` +
            'and follow it.',
        '',
        `- intent: ${join(reviewDir, 'intent.md')}`,
        `- chunks: ${join(reviewDir, 'chunks')} (${chunkCount} files)`,
        `- manifest: ${join(reviewDir, 'manifest.json')}, every chunk's files`,
        `- candidates: ${reviewers.map(reviewer => join(reviewDir, `candidates-reviewer-${reviewer}.json`))
            .join(', ')}`,
        `- output: ${join(reviewDir, output)}`,
        `- format check: ${formatCheck(join(reviewDir, output))}`,
        '',
        'Write the output file in the brief\'s format. Your final message is the one line ' +
            '"written: <n> confirmed, <m> open, <k> refuted".',
        '',
        BOUNDARIES,
    ].join('\n');
}

/**
 * Tells whether the reviewers read one diff whole rather than a shard each.
 * @param assignments - The manifest's `reviewers`.
 * @returns True when every reviewer holds the same chunks.
 */
function readWhole (assignments) {
    const first = assignments[0].chunks.join('\n');

    return assignments.every(assignment => assignment.chunks.join('\n') === first);
}

/**
 * Words the verifiers' prompts: one over every candidate file when the diff
 * was read whole, one per candidate file when it was sharded.
 * @param reviewDir - The absolute review directory.
 * @param manifest - The manifest.
 * @param written - The reviewers that wrote a candidate file.
 * @returns Per verifier the file it writes and its prompt; none when no
 * reviewer wrote a file.
 */
function verifierPrompts (reviewDir, manifest, written) {
    if (written.length === 0) {
        return [];
    }

    const count = manifest.chunks.length;

    if (readWhole(manifest.reviewers)) {
        return [
            {
                output: 'verified.json',
                prompt: verifierPrompt(reviewDir, count, written, 'verified.json'),
            },
        ];
    }

    return written.map(reviewer => ({
        output: `verified-${reviewer}.json`,
        prompt: verifierPrompt(reviewDir, count, [
            reviewer,
        ], `verified-${reviewer}.json`),
    }));
}

export { resumePrompt, reviewerPrompt, verifierPrompts };
