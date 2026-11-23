# Configuration

ADE Call reads one private JSON file and a few environment variables at startup. Restart the server after changing either, when no call is in progress.

## Directories

| Path (default) | Variable | Contents |
| --- | --- | --- |
| `~/.config/ade-call/` | `ADE_CALL_CONFIG` | `config.json`, `access-token`, `browser-access.sqlite` (pairings and the configured address) |
| `~/.local/share/ade-call/` | `ADE_CALL_STATE` | `caller.sqlite` (conversations, transcripts, events), `ades/t3/dispatch.sqlite` and `ades/t3/tracked-threads.json` (T3 delivery journal and followed threads), `ades/orca/dispatch.sqlite` (Orca delivery journal), `recordings/` (optional diagnostics) |
| `~/.t3/` | `T3CODE_HOME` | T3's own data. ADE Call reads its SQLite database read-only and never writes to it. |

The server creates its two directories with mode `700` and its files with mode `600`. Use absolute paths when you override them. Keep both directories out of any Git repository: they contain credentials, transcripts and receipts.

The state belongs to one ADE installation. Project, thread and receipt IDs are specific to it, so do not reuse a state directory with a different T3 installation.

## config.json

All fields are strings. Only the key of the provider you use is required (`openaiKey`, or `geminiKey` with a Gemini model); every other field has a default. Unknown fields are ignored.

```json
{
  "openaiKey": "YOUR_OPENAI_KEY",
  "realtimeModel": "gpt-realtime-2.1",
  "realtimeVoice": "marin",
  "realtimeReasoning": "low",
  "realtimeEagerness": "low",
  "realtimeNoiseReduction": "near_field",
  "realtimeTranscriptionModel": "gpt-4o-transcribe",
  "customInstructions": "When an agent answers, tell me everything important it says."
}
```

| Field | Default | Allowed values | Effect |
| --- | --- | --- | --- |
| `openaiKey` | `OPENAI_API_KEY` | An OpenAI API key | Used to create Realtime calls. The file takes priority over the variable. It can also be saved or removed from **Settings → API keys**. |
| `realtimeModel` | `gpt-realtime-2.1` | Any Realtime model your key can use; Settings offers `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gemini-3.8-live` and `gemini-3.1-flash-live-preview` | The voice model. A `gemini-*` model runs the call on [Gemini Live](gemini.md); the other `realtime*` fields then do not apply. Mini is faster and cheaper; the full model reasons better. |
| `geminiKey` | `GEMINI_API_KEY`, else `GOOGLE_API_KEY` | A Gemini API key | Used for Gemini Live calls. The file takes priority over the variables. It can also be saved or removed from **Settings → API keys**. |
| `geminiVoice` | `Kore` | A prebuilt Gemini voice; Settings offers `Kore`, `Puck`, `Charon`, `Aoede`, `Leda`, `Zephyr`, `Fenrir`, `Orus` | The voice you hear with a Gemini model. |
| `realtimeVoice` | `marin` | A voice supported by the model | The voice you hear. |
| `realtimeReasoning` | `low` | `minimal`, `low`, `medium`, `high`, `xhigh` | Reasoning effort. Higher values add latency and cost. |
| `realtimeEagerness` | `low` | `low`, `medium`, `high`, `auto` | Semantic turn detection. `low` waits longer, up to about 8 s, when your sentence sounds unfinished. |
| `realtimeNoiseReduction` | `near_field` | `near_field`, `far_field`, `off` | `near_field` for a phone at your mouth or headphones, `far_field` for hands-free or a laptop. |
| `realtimeTranscriptionModel` | `gpt-4o-transcribe` | An OpenAI transcription model | Transcribes what you say, for the Conversation panel and for the send rule. With a `gpt-4o*` model, your project names are passed as a spelling hint. |
| `customInstructions` | none | Text up to 4000 characters after trimming, without control characters (C0 or C1) other than line breaks and tabs | Appended at the end of the voice's instructions under a fixed header ([`resources/custom_instructions.txt`](../resources/custom_instructions.txt)), for every ADE. Missing or blank adds nothing. They are preferences: they do not override the send rule and never authorize a send. Edited in **Settings → Voice**. |

An invalid value for `realtimeReasoning`, `realtimeEagerness`, `realtimeNoiseReduction` or `customInstructions` stops startup with an error that names the field, rather than silently falling back. Model and voice names are not checked locally: a wrong one fails when you place a call, with OpenAI's error in the page. A file that is not valid JSON also stops startup.

Every field can also be changed from the page, between calls: the `realtime*` fields in **Settings → Voice** and `geminiVoice` in **Settings → Voice**, `openaiKey` and `geminiKey` in **Settings → API keys**, which can save or remove them but never show them; see [Settings](#settings). Changes made there are written back to this file.

The [Voice](voice.md) document explains how these settings shape the session.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | OpenAI key, used only if `config.json` has no `openaiKey`. |
| `GEMINI_API_KEY`, `GOOGLE_API_KEY` | none | Gemini key, used only if `config.json` has no `geminiKey`; the first one set wins. |
| `ADE_CALL_CONFIG` | `~/.config/ade-call` | Configuration directory. The `access` command must use the same value as the server. |
| `ADE_CALL_STATE` | `~/.local/share/ade-call` | State directory. |
| `ADE_CALL_HOST` | `127.0.0.1` | Listen address. |
| `PORT` | `8787` | Listen port. |
| `ADE_CALL_TIME_ZONE` | the system's | IANA time zone given to the voice, such as `Europe/Madrid`. |
| `T3_BIN` | `~/.local/bin/t3` if it exists, else `t3` on `PATH` | T3 CLI. |
| `T3CODE_HOME` | `~/.t3` | T3's data directory. |
| `ORCA_BIN` | `orca-ide` on `PATH` | Orca CLI. Never the `orca` screen reader. |

Keep `ADE_CALL_HOST` on loopback unless a proxy on another host or in a container must reach it; see [Deployment](deployment.md#caddy-in-a-container). The [systemd installer](deployment.md#run-as-a-systemd-user-service) writes these variables into the unit, never the OpenAI key.

## Interface language

The page follows the browser's preferred languages (`navigator.languages`, then `navigator.language`). The first tag whose primary subtag has a dictionary wins, so `es-MX` selects Spanish, and dates use that tag. Without a match the page is in English. Supported languages are English and Spanish. Only the page's own text is translated; server messages, tool results and transcripts appear as they arrive.

## Settings

The **Settings** panel, behind the gear button in the header, has four tabs:

- **General**
  - **Language**: **Browser** (the rule in [Interface language](#interface-language)) or a fixed language. The choice is stored in this browser's `localStorage` under `ui-language` and reloads the page, or waits until the current call ends. It is also sent with the next call: the voice transcribes, greets and speaks in it with a native accent (with **Browser**, the browser's first preference is used the same way). The voice still answers in whatever language you actually speak.
  - **Call recording**: the switch for [diagnostic recordings](troubleshooting.md#diagnostic-recordings).
- **Voice**: model, reasoning, voice (`marin`, `cedar`), turn taking, noise reduction and transcription model (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`). With a Gemini model only the model and the Gemini voice are shown. Each choice is saved as soon as it changes, with no Save button; the row marks it as saved and the call screen shows the new model and reasoning at once. A value written by hand in `config.json` outside these lists stays offered while it is the current one. Below them, **Custom instructions** is a text box saved with its own button into `customInstructions`; saving it empty removes the field, and then nothing is added to the prompt. They apply to both providers.
- **API keys**: for OpenAI and for Gemini, says whether a key is saved in `config.json`, comes from the environment (`OPENAI_API_KEY`; `GEMINI_API_KEY` or `GOOGLE_API_KEY`) or is missing. It never shows a key. **Save key** writes `openaiKey` or `geminiKey`; **Remove saved key** deletes it, and the server then falls back to the environment if it has one. `POST /api/settings/key` takes `provider: "gemini"` for the Gemini key.
- **Devices**: paired browsers and links for another device; see [Access](access.md#list-and-revoke).

Voice settings, custom instructions and the key are server-wide: they apply to every paired browser and every ADE, from the next call, without a restart. While any call is active or connecting, the server refuses the change (`409`) and the page locks those tabs; a call keeps the settings and key it started with. The server validates every value against the offered options and rewrites `config.json` atomically with mode `0600`, keeping any other field; if the file is not valid JSON it refuses to save and leaves it untouched. The endpoints are `GET`/`POST /api/settings/voice`, `POST /api/settings/instructions` (`{"instructions": "…"}`; `{"instructions": null}` or blank text removes them; `GET /api/settings/voice` returns the current text) and `POST /api/settings/key`.

What each control keeps after reloading the page or restarting the service:

| Setting | Where it is kept | Applies | After a reload |
| --- | --- | --- | --- |
| Language | This browser's `localStorage` (`ui-language`) | At once (the page reloads), or when the call ends | Kept in this browser; other browsers keep their own. |
| Call recording | Nowhere: the open page only | Every call of that page | Off. Turn it on again before the next call. |
| Voice: model, reasoning, voice, turn taking, noise reduction, transcription, Gemini voice | `config.json` (`realtimeModel`, `realtimeReasoning`, `realtimeVoice`, `realtimeEagerness`, `realtimeNoiseReduction`, `realtimeTranscriptionModel`, `geminiVoice`) | Next call, no restart | Kept, for every paired browser and after a restart. |
| Custom instructions | `config.json` (`customInstructions`) | Next call, no restart | Kept, for every paired browser and after a restart. |
| API keys | `config.json` (`openaiKey`, `geminiKey`) | Next call, no restart | Kept; the page shows whether it is set, never the key. |
| Paired browsers | `browser-access.sqlite` in the configuration directory | At once | Kept. A link created for another device is shown only until Settings closes. |

The call recording switch is off on every load on purpose: a recording keeps private audio on the server and nothing deletes it automatically, so it is never resumed from an earlier visit. The open tab of Settings is remembered only while the page stays open.

Without a paired session only the language is shown. To add a language, add a dictionary to [`public/i18n.ts`](../public/i18n.ts) with every English key and register it in `dictionaries` under its primary subtag. The type checker rejects missing keys and mismatched `{placeholders}`.

## Time zone

Each call starts with the current time, the time zone and, if there was one, when the previous call of the conversation ended. The voice uses this to understand "yesterday" or "an hour ago". The zone is the system's unless `ADE_CALL_TIME_ZONE` sets another. The end of the previous call says nothing about whether a thread has been idle since.
