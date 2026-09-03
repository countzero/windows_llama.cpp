// Exports SESSION_ID into the environment of every shell command OpenCode runs,
// via the "shell.env" hook. The agent uses this value as <session-id> in
// .tmp/sessions/<session-id>/ per AGENTS.md "Scratch Files". The Claude Code
// equivalent is the SessionStart hook in .claude/settings.json.
//
// Why the environment and not the system prompt: this plugin used to push
// "SESSION_ID=<id>" into output.system via experimental.chat.system.transform.
// That put a per-session unique string into the cached prefix, so llama.cpp's
// prompt cache found no reusable prefix across sessions and re-prefilled the
// entire system block every time. Measured on the dual-GPU Muse Glimmer entry:
// 22705 of 22724 tokens re-prefilled on a second session with the hook, versus
// 1 token without it - about 21.6 s at 1050 t/s, paid on every new session.
// Behind an mmproj llama.cpp also force-disables cache-reuse, so exact prefix
// matching is the only reuse mechanism there is (docs/presets.md -> "Slots and
// the prompt cache"). The environment costs zero prompt tokens.
//
// Consequence for the agent: the literal id is not in context. Either use the
// variable directly inside a shell command, which is the common case -
//     New-Item -ItemType Directory -Force -Path ".tmp/sessions/$env:SESSION_ID"
// - or read it once with `Write-Output $env:SESSION_ID` when an absolute path is
// needed for the Write/Edit tools.
//
// No package.json is needed: this file imports nothing, and OpenCode loads
// local plugins directly from .opencode/plugins/. The sessionID field is
// optional in the hook signature, hence the guard. If the hook is renamed or
// removed, the soft-fallback in AGENTS.md (mint YYYYMMDD-HHMMSS-<random6>)
// keeps things working at the cost of resume support.

export const SessionIdInjector = async () => ({
    'shell.env': async (input, output) => {
        if (!input.sessionID) return;
        output.env.SESSION_ID = input.sessionID;
    },
});
