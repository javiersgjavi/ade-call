# Text for the models

Every text a model reads lives here, not in the code: the voice instructions, the
parts specific to each ADE, tool schemas, tool errors and the message delivered to a
T3 agent. `src/resources.mts` loads these files and fills `{{name}}` placeholders; a
placeholder without a value throws instead of reaching the model. The files are read
from this directory at runtime, and some are cached per process: restart the service
after editing them. No rebuild is needed.

| File | Contents | Used by |
| --- | --- | --- |
| [system_prompt_voice.txt](system_prompt_voice.txt) | Instructions for a voice call. | `src/direct/prompt.mts` |
| [voice_language.json](voice_language.json) | The first sentence of the `LANGUAGE` rule (language chosen in the settings, the browser's, or unknown) and the language and accent reminder sent before each response the server requests. `{{language}}` and `{{variety}}` are English names computed from a BCP 47 tag, such as "Spanish" and "Spanish (Spain)". | `src/direct/prompt.mts` |
| [ade_prompts.json](ade_prompts.json) | The ADE-specific parts of those instructions, for `t3` and `orca`. | `src/direct/t3.mts`, `src/direct/orca.mts` |
| [tools.json](tools.json) | Each tool's description and parameters. | `src/adapters/**`, `src/direct/*.mts` |
| [error_messages.json](error_messages.json) | Errors the tools return to the model. | `src/adapters/**`, `src/direct/*.mts` |
| [eval_judge.txt](eval_judge.txt) | Instructions and general rubric of the LLM judges of the [conversation evaluations](../docs/evals.md). | `src/eval/judge.mts` |
| [eval_texts.json](eval_texts.json) | The other texts of the conversation evaluations: the history the voice gets in a scenario, and the frame of the judge's input (`{{id}}`, `{{description}}`, `{{history}}`, `{{world}}`, `{{criteria}}`, `{{log}}`, `{{list}}`), and the lines of the world and call log it reads (`world_*`, `log_*`). | `src/eval/judge.mts`, `src/eval/runner.mts` |
| [t3_delivery_prompt_main.txt](t3_delivery_prompt_main.txt), [t3_delivery_prompt_existing.txt](t3_delivery_prompt_existing.txt) | The message a T3 agent receives with an accepted send, to the project's main thread or to an existing thread. | `src/adapters/t3/coordinator.mts` |

## Instruction placeholders

`{{ade}}` is the ADE's name. `{{role}}`, `{{target}}`, `{{source}}`,
`{{destination}}`, `{{evidence}}`, `{{limits}}` and `{{ids}}` come from
`ade_prompts.json`, and so does `{{search}}`, the optional `search` part (T3 only:
which threads to look at first), empty when an ADE has none; `{{Target}}` is `target` capitalized. `{{sending}}` lists the
ADE's sending tools. `{{spoken_language}}` comes from `voice_language.json`. `{{call_start}}` and `{{ade_capabilities}}` are JSON computed
when the call opens.

## Tools and errors

Each key in `tools.json` is the tool name the model sees, except `read_document`,
which serves both `t3_read_document` and `orca_read_document`, and `_orca_adapter`,
which holds Orca adapter operations the voice does not see directly. A parameter is
a JSON Schema fragment plus three fields of its own: `required`, `description` and an
optional `example`. `toolSchema` in `src/resources.mts` turns that into the schema
the model receives, appending the example to the description:

```json
{ "threadId": { "type": "string", "minLength": 1, "required": true,
  "description": "Short thread ID, from the catalog or a search", "example": "7b2d40e9" } }
```

A value that is only a placeholder (`"maximum": "{{max}}"`) becomes the number the
code passes. Example IDs have the real shape (8 characters, or `s` plus 7) but match
nothing, so a copied example fails with "does not match any ID" and runs nothing.
There is no example for `model`: model identifiers are never invented.

In `error_messages.json`, `{{when}}`, `{{where}}` and `{{check}}` are fragments the
code composes, such as "2 min ago" or "read that thread now with t3_read_thread".

## Language

The text is in English, but it does not fix the language of the call. The
`LANGUAGE` rule in `system_prompt_voice.txt` makes the voice speak the user's
language with its native accent (`{{spoken_language}}` names the starting language
from `voice_language.json`, never a fixed one), and the delivery prompts ask the T3 agent to write in the language of the
request or of the thread. Keep new text in English and do not add rules that tie the
conversation to one language.

## What stays in the code

- The reference line appended to each T3 send (`referenceLine` in
  `src/adapters/t3/coordinator.mts`). Delivery verification searches threads for it
  with a regular expression, so it is not editable text.
- The text of tool results (catalog, receipts, read headers) and server errors the
  model never sees.

`npm test` checks that every key the code uses exists, that none is unused, and that
the instructions render with no placeholder left.
