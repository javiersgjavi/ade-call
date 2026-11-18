# Installation

This guide installs ADE Call on the Linux machine where your ADE runs and ends with a first call from the same computer. To use it from your phone, including away from home, choose a route in [Phone access](deployment.md#phone-access): public HTTPS through Caddy, or private HTTPS through Tailscale Serve. Installing the service and generating a pairing link do not set up that network route. The commands use Bash.

## 1. Check the requirements

```bash
node --version   # must be v24 or later
npm --version
t3 --help        # or: orca-ide --help
```

- **Node 24+ and npm.** The server relies on Node's built-in SQLite and TypeScript support; older versions are not supported.
- **An ADE on the same machine.** For T3, the `t3` CLI must be on `PATH` (or in `~/.local/bin/t3`) and have at least one project. If it lives elsewhere, set `T3_BIN` to its absolute path; if T3 keeps its data outside `~/.t3`, set `T3CODE_HOME`. The adapter is tested against T3 0.1.9; see [T3 compatibility](t3.md). For Orca, the `orca-ide` CLI must be on `PATH` or in `ORCA_BIN`, with its repositories registered (`orca-ide repo add --path /path/to/repo --json`). Do not point `ORCA_BIN` at `orca`, the Linux screen reader. One ADE is enough: on a machine with only Orca, T3 shows as unavailable.
- **An OpenAI API key** with access to the Realtime model, on an account with billing set up and credit available. Create one following [OpenAI's quickstart](https://developers.openai.com/api/docs/quickstart). ADE Call only checks the key's format when you save it. Without credit, every call fails with `OpenAI Realtime could not create the call (429, …)` and OpenAI's quota message; a wrong key fails with `401`, and one without access to the model with `403`. See [Troubleshooting](troubleshooting.md#common-problems).

Three different credentials are involved, and they do not replace each other:

| Credential | Where it lives | What it is for |
| --- | --- | --- |
| OpenAI API key | `config.json` or `OPENAI_API_KEY` | The voice. Every call uses API quota. |
| Your ADE's model providers | Inside T3 or Orca | The coding agents. ADE Call never sees them. |
| Browser pairing | A cookie per browser | Access to this ADE Call. See [Access](access.md). |

## 2. Build and test

```bash
git clone https://github.com/javiersgjavi/ade-call.git
cd ade-call
npm ci
npm test
```

Clone into a permanent folder, such as `~/ade-call`. The [systemd service](deployment.md#run-as-a-systemd-user-service) runs the server from this checkout (its `WorkingDirectory` and `ExecStart` point into it), so do not clone into a temporary directory and do not delete or move it afterwards. To update, `git pull` in the same folder; see [Updating](deployment.md#updating).

`npm test` compiles the TypeScript sources into `dist/` and runs the test suite against simulated providers. It needs no keys and does not touch your ADE. `npm ci` installs development dependencies, which the build needs; if `NODE_ENV=production` is set, use `npm ci --include=dev`.

## 3. Store the OpenAI key

Keep the key out of chats, shell history and command lines. Two ways do this:

- **From your own terminal, without echo.** Run this on the server machine. It asks for the key without showing it, creates the configuration directory with mode `700`, and writes `openaiKey` into `config.json` with mode `600`, keeping any other field already there. It uses `ADE_CALL_CONFIG` if you set one.

  ```bash
  dir="${ADE_CALL_CONFIG:-$HOME/.config/ade-call}"
  mkdir -p "$dir" && chmod 700 "$dir"
  read -rsp 'OpenAI API key: ' key; echo
  printf '%s' "$key" | node -e '
  const fs = require("node:fs"), file = require("node:path").join(process.argv[1], "config.json");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  const config = text ? JSON.parse(text) : {};
  config.openaiKey = fs.readFileSync(0, "utf8").trim();
  if (!config.openaiKey) { console.error("No key entered; config.json unchanged."); process.exit(1); }
  fs.writeFileSync(file + ".tmp", JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file + ".tmp", 0o600);
  fs.renameSync(file + ".tmp", file);
  console.log("Saved openaiKey in " + file);
  ' "$dir"
  unset key
  ```

  `printf` is a shell builtin, so the key never appears in the process list. If `config.json` exists but is not valid JSON, the script stops and leaves it untouched.

- **From the page.** Start the server and pair the browser first (steps 4 and 5), then open **Settings → API key** and press **Save key**. The server writes the same field with the same permissions; the page never shows the key again. See [Settings](configuration.md#settings).

`openaiKey` is the only required field. The voice model, voice, reasoning effort, turn detection and noise reduction are optional and listed in [Configuration](configuration.md). As an alternative to the file, export `OPENAI_API_KEY` in the environment of the server; the file takes priority. `.env` files are not read.

## 4. Start the server

```bash
npm start
```

`npm start` rebuilds and starts the server on `127.0.0.1:8787`. The log shows one line per ADE:

```text
ADE Call ready on 127.0.0.1:8787. Private access configured.
[t3] voice: GPT Realtime gpt-realtime-2.1
[orca] voice: GPT Realtime gpt-realtime-2.1
```

`(openaiKey missing)` at the end of a line means the server found no key. On first start the server also creates its directories and an administrative token; see [Configuration](configuration.md#directories).

## 5. Pair this browser

From a second terminal in the same folder, using the same `ADE_CALL_CONFIG` as the server if you set one:

```bash
npm run access -- pair --url http://127.0.0.1:8787 --name "Laptop"
```

It prints a JSON object with a `code` and a `link`. Open the link on the same computer and press **Pair browser**. The code works once and expires in ten minutes. The first `--url` you pass becomes this installation's address; for the phone you will need the HTTPS address instead, which [Access](access.md#changing-the-address) explains how to switch to.

## 6. Make a first call

1. Check that your projects appear in the page. The **ADE** switch in the header selects T3 or Orca.
2. Press **Call** and allow the microphone.
3. Ask "What projects do I have?" in any language.
4. Open **Conversation**: you will see your words, the answer and, under the turn, the tools the voice ran.

The voice is instructed to answer questions with reads and to send work to an agent only after it proposes a specific request and you accept it. Whether your words accept it is judged by the model; the server enforces a new user turn for each send and one send per turn ([Delivery safety](delivery-safety.md)). Do not send work to an agent just to test the installation.

## Next steps

- Install the [systemd user service](deployment.md#run-as-a-systemd-user-service) so it starts with your session.
- Reach it from your phone over HTTPS, then [pair the phone](access.md). Choose one way in [Phone access](deployment.md#phone-access): [Caddy with your own domain](deployment.md#https-reverse-proxy) (needs DNS and ports 80/443 open to the Internet) or [Tailscale Serve](deployment.md#tailscale-serve) (no domain or open ports; the phone must be on your tailnet).
- Adjust the [voice settings](configuration.md#configjson). Restart the server after changing `config.json`, when no call is in progress.

If something does not work, see [Troubleshooting](troubleshooting.md).
