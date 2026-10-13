/**
 * Telling a script started from the command line from one a test imports.
 *
 *   node --test .claude/skills/pr-audit/scripts/main_module.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMainModule } from './main_module.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'report_schema.mjs');

test('an imported module is not the main module, and a missing path is not either', () => {

    // Act and Assert
    assert.equal(isMainModule(pathToFileURL(SCRIPT).href), false);
    assert.equal(isMainModule(pathToFileURL(join(HERE, 'missing.mjs')).href), false);
});

test('a script started through a link to its directory still runs as the main module', () => {

    // Arrange
    const base = mkdtempSync(join(tmpdir(), 'pr-audit-main-'));
    const link = join(base, 'scripts');

    symlinkSync(HERE, link, 'junction');

    try {

        // Act
        const result = spawnSync(process.execPath, [
            join(link, 'report_schema.mjs'),
        ], {
            encoding: 'utf8',
        });

        // Assert
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, /usage: node report_schema\.mjs/);
    } finally {
        rmSync(link, {
            force: true,
        });
        rmSync(base, {
            recursive: true,
            force: true,
        });
    }
});

test('a script started by its own path runs as the main module', () => {

    // Act
    const result = spawnSync(process.execPath, [
        SCRIPT,
    ], {
        encoding: 'utf8',
    });

    // Assert
    assert.equal(result.status, 2, result.stderr);
});
