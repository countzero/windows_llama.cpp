// Injects "SESSION_ID=<id>" into the agent's system prompt every turn via
// OpenCode's experimental.chat.system.transform hook. The agent uses this
// value as <session-id> in .tmp/sessions/<session-id>/ per AGENTS.md
// "Scratch Files". The Claude Code equivalent is the SessionStart hook in
// .claude/settings.json.
//
// No package.json is needed: this file imports nothing, and OpenCode loads
// local plugins directly from .opencode/plugins/. A package.json would only
// be required to pull in external npm packages.
//
// The "experimental." prefix means OpenCode reserves the right to rename or
// remove the hook; sessionID is also optional in its signature, hence the
// guard. If either changes, the soft-fallback in AGENTS.md (mint
// YYYYMMDD-HHMMSS-<random6>) keeps things working at the cost of resume
// support. Verified against @opencode-ai/plugin 1.3.17 / opencode-ai 1.18.18.

export const SessionIdInjector = async () => ({
    'experimental.chat.system.transform': async (input, output) => {
        if (!input.sessionID) return;
        output.system.push(`SESSION_ID=${input.sessionID}`);
    },
});
