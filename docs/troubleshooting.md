# Troubleshooting

When you share an error in an issue or with someone else, remove keys, tokens, pairing codes, transcripts and personal paths first.

## Logs

```bash
journalctl --user -u ade-call -n 100    # systemd service
systemctl --user status ade-call
```

With `npm start`, the log goes to the terminal. At startup the server prints its address and one line per ADE, such as `[t3] voice: GPT Realtime gpt-realtime-2.1`, with `(openaiKey missing)` appended if no key was found.

## Common problems

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The server exits at startup with `Invalid OpenAI Realtime … value` | A `realtime*` field in `config.json` has an unsupported value | Use one of the values in [Configuration](configuration.md#configjson). |
| The server exits at startup with a JSON error | `config.json` is not valid JSON | Remove comments and trailing commas. |
| The page says the OpenAI key is missing, or the log shows `(openaiKey missing)` | No `openaiKey` in `config.json` and no `OPENAI_API_KEY` in the server's environment | Add the key and restart. A variable exported in your shell does not reach the systemd service. |
| `OpenAI Realtime could not create the call (401, …)` or `(403, …)` | Wrong key, or no access to the model | Check the key and model access in your OpenAI account. |
| `OpenAI Realtime could not create the call (429, …)` | Quota or rate limit | Check usage and billing in your OpenAI account. |
| `OpenAI Realtime could not create the call (400, …)` | Usually an unknown `realtimeModel`, `realtimeVoice` or `realtimeTranscriptionModel` | Pick a listed value in **Settings → Voice**, or fix the name in `config.json` and restart. |
| No projects, or "T3 not available. Check its CLI and configuration." | `t3` not found, T3 not initialized, or data in another directory | Run `t3 --help` as the service user. Set `T3_BIN` and `T3CODE_HOME`, then re-run the installer so the unit gets them. |
| "its local database of projects and threads could not be read" | T3's database is missing, locked or from an unsupported version | Check the T3 installation. See [T3 compatibility](t3.md). |
| The installer stops with `systemd cannot use a working directory with a line break` | The checkout's path contains a line break | Rename or move the checkout to a folder without one, then run the installer again from there. |
| `systemctl --user status ade-call` shows `bad-setting` and `WorkingDirectory= path is not absolute: "…"` | The unit was written by an older installer that quoted `WorkingDirectory` | Update the checkout and run the installer again. |
| Orca shows as unavailable | `orca-ide` not on the service's `PATH`, or Orca not running | Set `ORCA_BIN` to its absolute path and re-run the installer. |
| The microphone does not work on the phone | The page is not on HTTPS, or the permission was denied | Open the HTTPS address and allow the microphone in the site settings. |
| The phone cannot open the `*.ts.net` address | The Tailscale app is not connected to the same tailnet, or MagicDNS or HTTPS certificates are off | Connect the app, check both settings in the admin console and `tailscale serve status` on the server. See [Tailscale Serve](deployment.md#tailscale-serve). |
| Caddy cannot obtain a certificate | DNS does not point to this machine, or ports 80 and 443 are not reachable from the Internet | Fix the DNS record and the router's port forwarding, or use [Tailscale Serve](deployment.md#tailscale-serve). |
| "Code invalid, expired or already used." | The code expired (ten minutes) or was already redeemed | Generate a new one with `npm run access -- pair`. |
| "Open this installation's link to pair the browser." | The address in the browser differs from the configured one, or the proxy rewrote `Host` | Open exactly the configured URL. See [Access](access.md#origin-and-proxy-model). |
| "The URL differs from the configured one." when pairing | `--url` is not the address configured earlier | Omit `--url`, or change the address with `configure`, which revokes existing pairings. |
| "Wait a minute before trying again." | More than 20 pairing attempts in a minute from the same peer (behind a proxy, from anyone) | Wait one minute. |
| The page loads but events never update | The proxy buffers server-sent events | Disable response buffering (`flush_interval -1` in Caddy). |
| `EADDRINUSE` at startup | Port 8787 is taken | Set `PORT`, re-run the installer and update the proxy. |
| "There is another call or the destination has changed." | A call is already active or connecting, possibly from another browser, or the page is stale | End the other call or reload the page. |
| The voice says a send is blocked by an uncertain delivery | An earlier send may have arrived without confirmation | Ask the voice to read the thread. See [Delivery safety](delivery-safety.md). |

## Voice drops and silence

The call's audio travels over WebRTC directly between the browser and OpenAI. The server keeps only a control channel, so an open control channel or a fresh transcript does not prove the browser is playing audio.

During a call, the page sends a heartbeat to the server every ten seconds with a reduced sample of WebRTC `getStats()` and of the audio player, and once more when the call closes. The server keeps only known numeric and state fields, at most one sample every five seconds, and stores them as `voice-diagnostic` events in `caller.sqlite`, tagged with the call, ADE and conversation. No audio, text, SDP, ICE candidates, IP addresses or device identifiers are stored. To look at the latest samples (requires the `sqlite3` CLI):

```bash
sqlite3 ~/.local/share/ade-call/caller.sqlite \
  "SELECT id, payload FROM events WHERE type='voice-diagnostic' ORDER BY id DESC LIMIT 5"
```

| Fields | Meaning |
| --- | --- |
| `packetsReceived`, `packetsLost`, `packetsDiscarded`, `bytesReceived` | Cumulative counters for received audio packets. |
| `concealedSamples`, `silentConcealedSamples`, `concealmentEvents`, `totalSamplesReceived` | Samples the browser synthesized because packets were missing or late, against the total received. |
| `jitterMs`, `roundTripTimeMs` | Values at sampling time. |
| `jitterBufferMeanMs` | Cumulative mean time in the jitter buffer. |
| `statsAgeMs` | Age of the stats sample; a large value means a stale measurement. |
| `connectionState`, `iceConnectionState`, `disconnects` | Observed connection state, and how many times it entered a transient disconnection, even if it recovered. |
| `outputMuted`, `outputPaused`, `outputReadyState`, `pageHidden` | Whether playback was blocked locally rather than by the network. |
| `localGateActive`, `localGateActivations`, `localGateActiveMs`, `localGateTimeouts`, `playbackEvents` | Local speech detection. It only drives the on-screen indicator and never mutes audio (`playbackPolicy: provider`). `playbackEvents` keeps the last 20 local speech starts and ends, without text. |

A missing field is not a zero. The final sample may be missing exactly when the network is lost. On a transient disconnection the page shows a notice and lets WebRTC recover; it does not start another call or resend anything. If two heartbeats in a row fail, the page warns that the server has not confirmed the call. If the server reports the session no longer exists, the page releases the audio. References: [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/), [WebRTC connection states](https://www.w3.org/TR/webrtc/).

## Diagnostic recordings

For problems the counters do not explain, such as cut-off turns, talking over each other or silence, you can record a call. Turn on **Settings → Call recording → Record a diagnostic of the call** before calling. The switch is off whenever the page loads or reloads (on purpose: recordings hold private audio and are never deleted automatically, see [Settings](configuration.md#settings)), applies to every call while the page stays open, and can be turned off mid-call to stop recording without hanging up. It does not affect the normal transcript or any ADE work.

The browser uploads fragments to the ADE Call server over the authenticated session. Nothing is saved on the phone and there is no download endpoint. When the recording ends, the page shows its ID. Each recording is a folder `recordings/ID/` in the state directory (mode `700`, files `600`):

| File | Contents |
| --- | --- |
| `manifest.json` | ADE, conversation, call ID if it connected, UTC start, duration, format, bytes received, and `complete` or `incomplete` status. |
| `audio.webm`, `audio.m4a` or `audio.ogg` | Stereo audio, depending on the browser: your microphone on the left, received audio on the right, silences included. |
| `timeline.jsonl` | One JSON event per line, with `ms` relative to the start: transcripts, audio activity, connection changes, errors, interruptions, mute, visibility, audio metrics, and the name and status of each tool the voice used. |
| `parts/` | The numbered fragments as uploaded, kept so an interrupted recording can be reassembled. |

The left channel is what the browser's microphone delivered after its echo and noise processing; muting also silences it. The right channel is the audio received over WebRTC before local muting, so hearing something there does not prove it came out of the speaker: cross-check with the mute, playback and connection events. Suspending the phone or the browser can leave gaps.

A recording stops at 30 minutes, 64 MiB of audio, too much unsent data in memory, or an upload or storage error; the call continues. The archive holds at most 128 recordings within a 1 GiB budget. Nothing is deleted automatically: when it is full, delete or move folders of finished recordings out of `recordings/`. That does not affect conversations or receipts.

To reassemble the fragments of an incomplete recording, after it has stopped, using the same `ADE_CALL_STATE` as the service:

```bash
node dist/scripts/recordings.mjs recover RECORDING_ID
```

It rewrites `audio.*` and `timeline.jsonl` from `parts/`, does not change the fragments, does not call any provider, and leaves the status as it was.

Recordings contain your voice and transcripts. Keep them out of Git and do not send them to anyone without thinking about who else is on them.

### Replaying a recording

```bash
node dist/scripts/replay-realtime.mjs RECORDING_DIR OUTPUT_DIR [--eagerness low] [--tail MS] [--no-prefetch]
```

This plays the microphone channel of a recording to OpenAI Realtime in real time, with the T3 tools, to compare turn-taking and tool use across settings. It runs real T3 reads through the read-only CLI and simulates every send, so nothing is delivered. It writes a stereo WAV (left: you, right: the new voice) and a JSON report with turns, overlaps and tools. The replay is open loop, since the recorded speaker cannot react to the new voice. It uses your OpenAI quota, and its output contains transcripts: keep `OUTPUT_DIR` private.

## Recovering an uncertain delivery by hand

When a send may have reached the ADE without confirmation, ADE Call marks it uncertain and blocks further sends to that project until it is resolved. The normal way out is in a call: ask the voice to read the thread, or to release the uncertain send. [Delivery safety](delivery-safety.md) explains the states and why nothing is retried.

Use the following only as a last resort, for example when the voice is unavailable. First check in T3, or in the Orca terminal, whether the message arrived. Then, with the service stopped or with no send in progress, update the single row:

```bash
# T3: status 'delivered' if it arrived, 'released' if it did not
sqlite3 "$HOME/.local/share/ade-call/ades/t3/dispatch.sqlite" \
  "UPDATE dispatches SET status='released' WHERE requestId='REQUEST_ID' AND status IN ('pending','unknown')"

# Orca: status 'accepted' if it arrived, 'released' if it did not
sqlite3 "$HOME/.local/share/ade-call/ades/orca/dispatch.sqlite" \
  "UPDATE operations SET status='released' WHERE id='REQUEST_ID' AND status IN ('pending','unknown')"
```

To find the request ID, list the uncertain rows with `SELECT requestId, projectId, status FROM dispatches WHERE status IN ('pending','unknown')` (Orca: `SELECT id, project, status FROM operations WHERE …`). Never delete rows or the journal to force a retry, and do not resend a request that already arrived. A send left `pending` that never reached the CLI, for example because the service stopped first, is released automatically by the next send or release in that project.
