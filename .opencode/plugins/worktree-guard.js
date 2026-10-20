// Keeps session_move inside this repository's worktree layout: the main tree, or
// .worktrees/<name> with <name> matching namePattern. OpenCode's built-in
// session_move accepts any directory; this refuses the rest before it runs.
// docs/worktrees.md has the layout.

import { existsSync } from 'node:fs';
import path from 'node:path';

const namePattern = /^[a-z0-9][a-z0-9._-]*$/;
const nameDescription = 'a branch slug (lowercase letters, digits, ".", "_" and "-")';
const example = '.worktrees/<branch-slug>';

const moveTools = new Set(['opencode_session_move', 'session_move']);

const fold = p => (process.platform === 'win32' ? p.toLowerCase() : p);

const mainTree = directory => (path.basename(path.dirname(directory)) === '.worktrees'
    ? path.dirname(path.dirname(directory))
    : directory);

const refuse = (target, reason) => {
    throw new Error(`worktree-guard refused session_move to ${target}: ${reason}. `
        + `Allowed targets are the main tree or ${example}, named ${nameDescription}; see docs/worktrees.md.`);
};

export default {
    id: 'worktree-guard',
    async setup(ctx) {
        await ctx.tool.hook('execute.before', event => {
            if (!moveTools.has(event.tool)) {
                return;
            }

            const input = event.input ?? {};

            if (input.sessionID && input.sessionID !== event.sessionID) {
                refuse(input.sessionID, 'only the current session may be moved');
            }

            const current = ctx.location.directory;
            const main = mainTree(current);
            const target = path.resolve(current, String(input.directory ?? ''));

            if (fold(target) === fold(current)) {
                refuse(target, 'the session is already there');
            }

            const inWorktrees = fold(path.dirname(target)) === fold(path.join(main, '.worktrees'));

            if (fold(target) !== fold(main) && !(inWorktrees && namePattern.test(path.basename(target)))) {
                refuse(target, 'it is neither the main tree nor a worktree with an allowed name');
            }

            if (!existsSync(target)) {
                refuse(target, 'the directory does not exist; create the worktree first');
            }
        });
    },
};
