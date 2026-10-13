/**
 * Tells a script started from the command line from one a test imports.
 * Both sides are resolved to the file they name, because a script started
 * through a junction, a link or a differently cased drive letter spells its
 * path otherwise than `import.meta.url` does, and a plain comparison would
 * let it exit 0 having done nothing.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const canonical = path => {
    const real = realpathSync.native(path);

    return process.platform === 'win32' ? real.toLowerCase() : real;
};

/**
 * Tells whether the module is the one Node was started with.
 * @param moduleUrl - The module's `import.meta.url`.
 * @returns Whether it runs as the main module.
 */
function isMainModule (moduleUrl) {
    const started = process.argv[1];

    if (started === undefined) {
        return false;
    }

    try {
        return canonical(started) === canonical(fileURLToPath(moduleUrl));
    } catch {
        return false;
    }
}

export { isMainModule };
