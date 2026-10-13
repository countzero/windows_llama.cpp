// Adds the agent tool `worktree_enter`, which re-homes the session, once its
// turn ends, in a linked git worktree of this repository or back in the main
// working tree, so that every later tool call works there without a per-call
// working directory, and the conversation survives.
// The workflow, the timing, why the whitelist admits two targets, and the ban
// on the built-in /move dialog that makes `moveChanges: false` load-bearing are
// all docs/worktrees.md.
//
// Upstream https://github.com/anomalyco/opencode/pull/43238 adds a /cd command
// and a change_directory tool on the same endpoint. Once it lands, this plugin
// can go.
//
// Every export of a plugin file has to be a plugin function, so the helpers
// below stay module-private.

import fs from 'node:fs';
import path from 'node:path';

const namePattern = /^[a-z0-9][a-z0-9._-]*$/;

const httpNotFound = 404;

const comparablePath = value => {
    const resolved = path.resolve(value);

    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const samePath = (left, right) => comparablePath(left) === comparablePath(right);

/**
 * The main working tree, which is what `.worktrees/` hangs below.
 *
 * `context.worktree` is the tree the *session* is in, so a session already inside
 * `.worktrees/<slug>` reports that directory and a relative target resolved against it
 * would name a nested `.worktrees/<other>` that exists nowhere, which the sibling check
 * would then wave through.
 * @param worktree - The tree the session is in.
 * @returns The main working tree.
 */
const mainWorkingTree = worktree => {
    const parent = path.dirname(worktree);

    return path.basename(parent) === '.worktrees' ? path.dirname(parent) : worktree;
};

const refuse = (target, main, worktrees) => `${target} is no valid target: worktree_enter accepts a ` +
    `directory named as a branch slug (lowercase letters, digits, ".", "_" and "-") directly below ${worktrees}, or the main working tree ${main} ` +
    'itself, which "." names. docs/worktrees.md describes how to create a worktree.';

const absent = target => `${target} does not exist, so the session stays where it is. ` +
    'docs/worktrees.md describes how to create a worktree.';

const scheduledNotice = (target, source) => `The session moves to ${target} once this turn ends, and a ` +
    'prompt then starts the next turn there by itself. End the turn now: every tool call before then ' +
    `still runs in ${source} and only delays the move, and an interrupt with esc drops it. No uncommitted ` +
    'change is carried over and the source working tree stays untouched. The branch and the uncommitted ' +
    "work there are another tree's: read the branch and re-run the git status preflight (docs/conventions.md, Shared working tree) before you write or " +
    'commit. Read docs/worktrees.md before you build or run anything there.';

/**
 * What the posted continuation says, the next turn being the first one in the new directory.
 * @param target - The directory the session moved to.
 * @returns The prompt text.
 */
const continuationPrompt = target => `Your session directory changed to ${target} and this turn is ` +
    'working there. Carry on with the task you were on when you called worktree_enter.';

const failedNotice = (target, detail) => `worktree_enter could not move the session to ${target}, so it ` +
    `stays where it was: ${detail}`;

/**
 * The moves still owed, by session id, each with the directory its session is to move into.
 *
 * A move while the session works strands its running loop in the old directory, and the next prompt
 * starts a second one: docs/worktrees.md → *Entering it with the running session*.
 */
const pendingMove = new Map();

/**
 * Posts a prompt into a session, either starting a turn or only recording a message.
 *
 * Deliberately not awaited: `session.prompt` settles when the turn it starts has finished, and an
 * event hook that waits that long holds up every event behind it.
 * @param client - The plugin's SDK client.
 * @param sessionID - The session to post into.
 * @param text - The prompt text.
 * @param noReply - Whether to record the message without starting a turn.
 */
const postPrompt = (client, sessionID, text, noReply) => {
    client.session.prompt({
        path: {
            id: sessionID,
        },
        body: {
            noReply,
            parts: [
                {
                    type: 'text',
                    text,
                },
            ],
        },
    }).catch(error => client.app?.log?.({
        body: {
            service: 'worktree',
            level: 'warn',
            message: 'worktree_enter could not post into the session',
            extra: {
                error: error?.message ?? String(error),
            },
        },
    }).catch(() => undefined));
};

/**
 * Words whatever a failed call threw or returned as the detail of the failure message.
 * @param error - The thrown value or the response's error body.
 * @returns The most specific message it carries.
 */
const errorDetail = error => error?.data?.message ?? error?.message ?? JSON.stringify(error);

/**
 * Asks the running server to re-home the session in the target directory.
 * @param client - The plugin's SDK client.
 * @param sessionID - The session to move.
 * @param target - The directory to move it to.
 * @returns The raw response of the move endpoint.
 */
const postMove = (client, sessionID, target) => client._client.post({
    url: '/experimental/control-plane/move-session',
    body: {
        sessionID,
        destination: {
            directory: target,
        },
        moveChanges: false,
    },
    headers: {
        'Content-Type': 'application/json',
    },
});

/**
 * Words why the move endpoint refused, or nothing when it moved the session.
 * @param move - The raw response of the move endpoint.
 * @returns The failure detail, or undefined on success.
 */
const moveFailure = move => {
    if (move.response?.status === httpNotFound) {
        return 'this OpenCode build serves no POST /experimental/control-plane/move-session. Update ' +
            'OpenCode or start a session inside the worktree instead.';
    }

    if (move.response?.ok === true) {
        return undefined;
    }

    return move.error?.data?.message ?? move.error?.message ?? `status ${move.response?.status}`;
};

/**
 * Moves an idle session and starts its next turn there, or records in the conversation why it stayed.
 *
 * A failure is recorded without a reply because the turn that asked for the move has ended: no agent
 * is left to read a tool result, and a turn started only to report it would restart a stopped agent.
 * @param client - The plugin's SDK client.
 * @param sessionID - The session to move.
 * @param target - The directory to move it to.
 */
const completeMove = async (client, sessionID, target) => {
    let failure;

    try {
        failure = moveFailure(await postMove(client, sessionID, target));
    } catch (error) {
        failure = errorDetail(error);
    }

    if (failure === undefined) {
        postPrompt(client, sessionID, continuationPrompt(target), false);

        return;
    }

    postPrompt(client, sessionID, failedNotice(target, failure), true);
};

/**
 * Looks up the move a session still owes.
 * @param sessionID - The session the event names, if any.
 * @returns The directory the session is to move to, or undefined when nothing is owed.
 */
const pendingTarget = sessionID => (sessionID === undefined ? undefined : pendingMove.get(sessionID));

/**
 * Forgets the pending move of a session whose turn the user interrupted.
 * @param event - The `session.error` event that arrived.
 * @param sessionID - The session it names.
 */
const dropIfAborted = (event, sessionID) => {
    if (event.properties?.error?.name === 'MessageAbortedError') {
        pendingMove.delete(sessionID);
    }
};

/**
 * Hands the pending move of a session to whichever event decides its fate.
 *
 * An interrupt ends the turn as much as a finished answer does, and a move completed after one would
 * post a continuation that restarts the agent the user just stopped.
 * @param client - The plugin's SDK client.
 * @param event - The event that arrived.
 */
const resolvePendingMove = (client, event) => {
    const sessionID = event.properties?.sessionID;
    const target = pendingTarget(sessionID);

    if (target === undefined) {
        return;
    }

    if (event.type === 'session.error') {
        dropIfAborted(event, sessionID);

        return;
    }

    if (event.type !== 'session.idle') {
        return;
    }

    pendingMove.delete(sessionID);
    void completeMove(client, sessionID, target);
};

const missingClient = 'This OpenCode build hands a plugin no client that reaches the running server, so a ' +
    'session cannot be moved. Nothing was moved; report it to the user, who can update OpenCode or start ' +
    'a session inside the worktree instead.';

const failed = detail => `worktree_enter failed and the session stays where it is: ${detail}`;

const missingDirectory = 'worktree_enter needs a directory naming where to move, for example ' +
    '.worktrees/<branch-slug> for a worktree or "." for the main working tree. ' +
    'Nothing was moved.';

/**
 * Tells whether the tool argument names a directory at all.
 * @param directory - The `directory` argument as the agent passed it.
 * @returns Whether it is a non-blank string.
 */
const isDirectoryArgument = directory => typeof directory === 'string' && directory.trim() !== '';

/**
 * Tells whether a target is one of the two admitted kinds: a linked worktree or the main tree.
 * @param target - The resolved target directory.
 * @param main - The main working tree.
 * @param worktrees - The `.worktrees` directory below it.
 * @returns Whether the target is admitted.
 */
const isAdmitted = (target, main, worktrees) => {
    const name = path.basename(target);
    const linked = namePattern.test(name) && samePath(target, path.join(worktrees, name));

    return linked || samePath(target, main);
};

/**
 * Tells whether a directory exists.
 * @param target - The directory to test.
 * @returns Whether it exists and is a directory.
 */
const isExistingDirectory = target => fs.statSync(target, {
    throwIfNoEntry: false,
})?.isDirectory() === true;

/**
 * Checks a target against the session and the whitelist before a move is scheduled.
 * @param target - The resolved target directory.
 * @param main - The main working tree.
 * @param context - The tool context of the calling session.
 * @returns The refusal message, or undefined when the target may be entered.
 */
const targetRefusal = (target, main, context) => {
    const worktrees = path.join(main, '.worktrees');

    if (samePath(target, context.directory)) {
        return `This session already works in ${target}.`;
    }

    if (!isAdmitted(target, main, worktrees)) {
        return refuse(target, main, worktrees);
    }

    return isExistingDirectory(target) ? undefined : absent(target);
};

/**
 * Validates the target and schedules the move for the end of the turn.
 * @param client - The plugin's SDK client.
 * @param directory - The non-blank `directory` argument.
 * @param context - The tool context of the calling session.
 * @returns The message the tool returns.
 */
const enter = (client, directory, context) => {
    const main = mainWorkingTree(context.worktree);
    const target = path.resolve(main, directory);
    const refusal = targetRefusal(target, main, context);

    if (refusal !== undefined) {
        return refusal;
    }

    // The v1 client a plugin is handed carries no control-plane method, and its `serverUrl`
    // is a fabricated http://localhost:4096 whenever the server runs in-process, which is
    // the ordinary case. The protected `_client` is the only transport that reaches the
    // running app, so an upstream rename has to fail loudly rather than post into the void.
    if (typeof client._client?.post !== 'function' || typeof client.session?.prompt !== 'function') {
        return missingClient;
    }

    pendingMove.set(context.sessionID, target);

    return scheduledNotice(target, context.directory);
};

export const Worktree = async ({ client }) => ({
    event: async ({ event }) => {
        resolvePendingMove(client, event);
    },
    tool: {

        // The tool name the agent calls, which OpenCode takes from this key.
        worktree_enter: {
            description: 'Move this session into an existing linked git worktree of this repository, or ' +
                'back into the main working tree, so that every later tool call works there without a ' +
                'per-call working directory. Accepts two targets and refuses every other: a directory ' +
                "named as a lowercase branch slug directly below the repository's .worktrees/, and the main working " +
                'tree itself, which "." names. Uncommitted changes are never carried over and the ' +
                'source working tree stays untouched, in either direction. The move happens once this ' +
                'turn ends and the next turn then starts there by itself, so end the turn right after ' +
                'calling this rather than asking the user for anything; an interrupt before then drops ' +
                'the move.',
            args: {
                directory: {
                    type: 'string',
                    description: 'Target directory, absolute or relative to the main working tree: ' +
                        '.worktrees/<branch-slug> for a linked worktree, "." for the main working tree. ' +
                        'Relative to the main tree rather than to the session, so the same argument ' +
                        'works from either.',
                },
            },
            execute: async (args, context) => {
                if (!isDirectoryArgument(args.directory)) {
                    return missingDirectory;
                }

                try {
                    return enter(client, args.directory, context);
                } catch (error) {
                    return failed(errorDetail(error));
                }
            },
        },
    },
});
