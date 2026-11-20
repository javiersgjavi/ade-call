# Skills

Task instructions for coding agents that work on this repository. Each skill is a
folder with a `SKILL.md` (a short front matter with `name` and `description`, then the
instructions) and the scripts it uses.

| Skill | Use |
| --- | --- |
| [branch-preview](branch-preview/SKILL.md) | Run a branch, PR or commit as a separate preview next to the installed service and open it already signed in, to look at and try a change before merging. |

Agents that read [AGENTS.md](../AGENTS.md) find them there. To have Claude Code load
them as skills, link the folder into its skills directory:

```bash
mkdir -p .claude/skills && ln -s ../../skills/branch-preview .claude/skills/branch-preview
```
