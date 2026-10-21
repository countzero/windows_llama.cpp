/**
 * The workers' Task prompts.
 *
 *   node --test .claude/skills/pr-audit/scripts/prompts.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resumePrompt, reviewerPrompt, verifierPrompts } from './prompts.mjs';

const BOUNDARIES = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'boundaries.md');

const MANIFEST = {
    chunks: [
        'chunk-01.patch',
    ],
    reviewers: [
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
    ],
};

test('every worker prompt closes with the boundaries the agent definitions leave out', () => {

    // Arrange
    const reviewDir = '/repo/.tmp/sessions/s/review';
    const boundaries = readFileSync(BOUNDARIES, 'utf8').trim();

    // Act
    const prompts = [
        reviewerPrompt(reviewDir, MANIFEST.reviewers[0]),
        ...verifierPrompts(reviewDir, MANIFEST, [
            1,
            2,
        ]).map(entry => entry.prompt),
    ];

    // Assert
    assert.equal(prompts.length, 2);

    assert.match(boundaries, /no build, no test, no install/);

    for (const prompt of prompts) {
        assert.ok(prompt.endsWith(`\n\n${boundaries}`));
    }
});

test('a verifier prompt names its format check by absolute paths, so any working directory runs it', () => {

    // Arrange
    const reviewDir = join(dirname(fileURLToPath(import.meta.url)), '.tmp', 'sessions', 's', 'review');
    const script = join(dirname(fileURLToPath(import.meta.url)), 'report_schema.mjs');

    // Act
    const [
        { prompt },
    ] = verifierPrompts(reviewDir, MANIFEST, [
        1,
        2,
    ]);

    // Assert
    assert.ok(prompt.includes(`- format check: node "${script}" "${join(reviewDir, 'verified.json')}"`), prompt);
});

test('the resume prompt reads the output file as it stands before the missed chunks, keeping what it holds', () => {

    // Arrange
    const missed = [
        'chunk-02.patch',
        'chunk-03.patch',
    ];

    // Act
    const prompt = resumePrompt(missed);

    // Assert
    assert.match(prompt, /^First read your output file as it stands, and keep every candidate, .*coverage token/);
    assert.ok(prompt.indexOf('output file as it stands') < prompt.indexOf('chunk-02.patch, chunk-03.patch'));
    assert.match(prompt, /Rewrite your output file whole/);
    assert.match(prompt, /the earlier candidates and the new ones/);
    assert.match(prompt, /the earlier tokens and those of these chunks/);
});
