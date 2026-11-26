# ADE Call documentation

Start with the [project README](../README.md) for what the project is and a quick start.

## Using it

| Document | What it covers |
| --- | --- |
| [Installation](installation.md) | Requirements, private configuration, first start and first call |
| [Configuration](configuration.md) | Directories, `config.json` fields, environment variables, interface language, time zone |
| [Access](access.md) | Pairing browsers, sessions, listing and revoking, origin and proxy model |
| [Deployment](deployment.md) | systemd user service, phone access over HTTPS (Caddy or Tailscale Serve), project sync timer, updates, backups |
| [Troubleshooting](troubleshooting.md) | Symptoms and fixes, logs, voice diagnostics, diagnostic recordings, manual recovery |

## Understanding it

| Document | What it covers |
| --- | --- |
| [How it works](how-it-works.md) | One call from the phone to the agents: audio, reads and sends, with a diagram |
| [Architecture](architecture.md) | Components, data stores, call lifecycle, tool calls, ADE selection |
| [Voice](voice.md) | Realtime session setup, instructions, turn detection, language, notices, tones |
| [Gemini Live](gemini.md), [Lokutor](lokutor.md) | The providers whose audio the server relays: what differs, limits, what has been verified |
| [Delivery safety](delivery-safety.md) | The send rule, deduplication, uncertain deliveries, what hanging up does |
| [Adapters](adapters.md) | The ADE adapter model and how to add an ADE |
| [T3](t3.md) | T3 adapter: CLI commands, read-only database reads, main threads, receipts |
| [Orca](orca.md) | Orca adapter: terminals, sends, agent starts, limits |

## Contributing

| Document | What it covers |
| --- | --- |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Development environment, checks, pull requests |
| [AGENTS.md](../AGENTS.md) | Guide for coding agents: code map, invariants, commands |
| [Testing](testing.md) | What the test suite covers and what it does not prove |
| [Roadmap](roadmap.md) | Known limitations and possible improvements |

These documents are also context for coding agents. Nothing in them authorizes an agent to send work to an ADE, publish anything or reveal secrets.
