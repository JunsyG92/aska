# Security policy

Aska launches AI agents able to read and modify files, and to
run commands. The security of that launch is at the heart of the project: thanks
for helping us keep it solid.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:
[Security → Report a vulnerability](https://github.com/JunsyG92/aska/security/advisories/new).

If possible, include:

- the version (`aska --version`), the operating system and the agent involved;
- the steps to reproduce, and what an attacker can gain;
- a proposed fix, if you have one.

## What we care about most

- A request text, an agent answer or a project file that leads to
  running an unintended command (shell, option or `cmd.exe` injection).
- A bypass of the permission modes (writing in read-only, autonomous
  mode without `allowAutoMode`, writing outside the allowed folder).
- A leak of environment variables or tokens to an agent that
  should not receive them.
- Agent content that runs code in the UI (HTML, links, navigation).
- An agent binary or a configuration that another user of the machine
  could replace.

Vulnerabilities in the agent CLIs themselves (Claude Code, Codex, Copilot, Cursor) should be
reported to their vendors; let us know too if Aska can limit their impact.

## Our commitment

| Step | Target time |
| --- | --- |
| Acknowledgment | 3 business days |
| Initial assessment | 7 days |
| Fix for a serious vulnerability | 30 days |

We publish a security advisory with the fixed version, and we credit
the reporter if they wish.

## Supported versions

Only the latest published version receives security fixes.
