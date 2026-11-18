# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
**Security** tab of the repository, then **Report a vulnerability**
([direct link](https://github.com/javiersgjavi/ade-call/security/advisories/new)).
Do not open a public issue, pull request or discussion for a security problem.

Include what an attacker can do, the steps or a proof of concept, and the commit you
tested. Leave out real keys, tokens, pairing codes, transcripts and recordings; a
redacted example is enough. You will get an acknowledgement, and a fix will be
coordinated with you before details are published.

Only the latest commit on `master` is supported. There are no released versions.

## Scope

In scope: this repository's server, browser UI, access CLI, installer and deployment
examples. Examples of what we want to hear about:

- Reaching the API, the event stream or the voice session without a valid pairing
  or token.
- Cross-origin or CSRF requests that change state.
- A way to make the server send work to an agent without a new transcribed user turn
  since the previous send, to run more than one send per turn, to send the same
  request twice, or to retry a send that may have been delivered.
- Keys, tokens, CLI output, file paths or other users' data leaking to the browser,
  the model or the logs.
- Writes to T3's database, or reads outside the selected project.

Out of scope: vulnerabilities in T3 Code, Orca, OpenAI's services, Node or the
browser themselves (report those upstream); attacks that require control of the
machine or the user account running the server; a model choosing poorly within what
the user authorized, including a model that treats a new user turn as acceptance
when it was not (the server does not interpret the user's words; see below).

## Security model in brief

- **Single owner.** One installation serves one person. Every paired browser has the
  same full control; there are no accounts or roles.
- **Paired browsers.** Access requires a single-use pairing code generated on the
  server machine, which becomes an HttpOnly, SameSite=Strict session cookie (`__Host-`
  and Secure over HTTPS). Sessions are stored as hashes, expire after 180 days without
  use and can be revoked individually. A bearer access token in the configuration
  directory exists for local tools.
- **Origin checks.** State-changing browser requests must come from the configured
  origin. Being on the same network grants nothing.
- **Loopback by default.** The server listens on `127.0.0.1`. Remote access is meant
  to go through an HTTPS reverse proxy that you run
  ([docs/deployment.md](docs/deployment.md)).
- **Gated sends.** The model is instructed to propose each send and wait for the
  user's yes; judging that the yes accepts the proposal is left to the model. The
  server enforces what it can check mechanically: a new transcribed user turn since
  the previous send, one send per turn, one execution per function call, and
  uncertain deliveries recorded and never retried
  ([docs/delivery-safety.md](docs/delivery-safety.md)).
- **Data sent to OpenAI.** During a call, the microphone audio, the voice
  instructions (including recent turns of the conversation), the project catalog and
  the content of every thread, terminal or project document the model reads are
  sent to the OpenAI Realtime API under your API key. Nothing is sent to OpenAI
  outside calls. Conversations, receipts and optional recordings stay in the local
  state directory.

Details of pairing, sessions and the proxy setup are in [docs/access.md](docs/access.md).
