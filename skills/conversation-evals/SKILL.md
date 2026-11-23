---
name: conversation-evals
description: Run, monitor and read the paid conversation evaluations (the battery) of ADE Call's voice model, to measure a prompt, model or setting change before it ships. Use when the owner asks to evaluate, benchmark, test the voice, run the battery, compare two runs, re-grade a run, or see how a change scores.
---

# Conversation evaluations

The harness and its options are documented in [docs/evals.md](../../docs/evals.md);
read it first. This skill is the procedure: how to run the battery without wasting
paid calls, and how to turn the results into a verdict.

## Before running

- **It is paid.** Every run is a voice call (GPT Realtime; Gemini Live with a
  `gemini-*` `--model`, which needs the Gemini key; or ElevenLabs Realtime with
  an `eleven_realtime_*` `--model`, which uses the ElevenLabs key) plus one judge request; a spoken
  line not yet in the cache is also an ElevenLabs synthesis. The battery
  ([evals/battery](../../evals/battery)) is about 50 scenarios, so `--repeat 3` is
  about 150 calls and takes roughly two and a half hours one call at a time. Say the
  number of calls and get the owner's go-ahead before any `run`. Re-grading
  (`judge`) and `report` make no calls (`judge` pays only the judge).
- **Use the owner's configuration and state.** Set `ADE_CALL_CONFIG` and
  `ADE_CALL_STATE` to the installed service's folders if they are not the defaults
  (the systemd unit shows them); keys come from there. Never print a key.
- **Build the branch under test** (`npm run build`), with Node 24. `ffmpeg` must be
  installed for phone-channel scenarios and recorded clips.
- **Read the baselines.** `$ADE_CALL_STATE/evals/BASELINES.md`, if it exists, holds the
  latest reference results (pass rates, run folders, known weak spots) to compare
  against. Update it after a run that becomes the new reference. It is private, like
  the runs: never commit it.
- `npm run check` must pass first: the prompt has a size limit and assertions, and a
  broken build only wastes the run.

## Running

1. **Iterate small, then run everything.** After a change, run only the scenarios it
   targets, two or three times: `run evals/battery --only id1,id2 --repeat 3 --label
   NAME`. Run the whole battery `--repeat 3` once those pass, to catch regressions.
2. **Run in the background** and send output to a file in your scratch folder, not
   the repository. If your environment stops background tasks after a time limit
   (often two hours), split the battery into chunks with `--only` or `--tag`, each
   with its own label, rather than one run that gets killed. `--parallel 2` halves
   the time at the cost of more provider load.
3. **Labels are single use.** `run` refuses a folder that already has results. Name
   them by version and part (`v6-x3`, `v6-x3-rest`).
4. **Watch for infrastructure failures.** A run marked `E` could not complete:
   network loss, provider error, judge error. It counts as a failure but says nothing
   about the model. If many runs fail together (for example every call after a
   point fails to connect), the network or the machine failed: check connectivity,
   then re-run only the `E` scenarios under a new label. A cheap way to tell later
   is a small loop logging time, load, free memory and an HTTP status from the
   provider every minute next to the run.

## Reading the results

- `report RUN_DIR [RUN_DIR...]` prints each scenario's passes per folder
  (`2/3 ★4.0`; `!` marks a failed critical check, `E` a run that did not complete). For one battery split across folders,
  read them together; compare versions side by side.
- Each run's `result.json` has `checks` (deterministic; `critical` ones fail the run
  whatever the judges say) and `judgements` (per criterion: `pass`, `severity`,
  `evidence`). A run fails on a critical check, or on a judge criterion that fails
  at major severity or above. Read the evidence of failing criteria before
  concluding anything; `run.json` has the full log and `audio.wav` the call.
- **Models are not deterministic.** Compare pass rates over `--repeat 3`; treat a
  one-run difference as noise. Sort failures into stable (0/3), flaky (1/3, 2/3) and
  harness problems, for example `turns[N].bargeIn` "not exercised" (the interruption
  hit a preamble before a tool call, so the scenario did not test what it meant to).
- When a judge criterion looks wrong, fix the scenario or `resources/eval_judge.txt`
  and re-grade with `judge RUN_DIR` instead of paying for new calls.
- Rewording a spoken turn needs a new synthesis on the next run.

## Reporting

Give the owner the overall pass rate (passes over runs, with `E` runs reported
separately), how it compares with the previous version, the stable and flaky
failures with the reason from the evidence, and what you would change next. Quote
short evidence only. Runs, audio, transcripts and private scenarios stay in
`$ADE_CALL_STATE/evals`: never commit them, attach them to a PR or paste them into a
public place. Old run folders grow to gigabytes; offer to delete superseded ones.
