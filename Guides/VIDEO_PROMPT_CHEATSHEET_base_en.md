# Base Cheat-Sheet (T2VA / I2VA / FL2VA / L2VA)

Companion to `VIDEO_PROMPT_WRITING_GUIDE_base_en.md`.

## Modes

| Mode | Asset | Write |
|---|---|---|
| T2VA | none | no instruction line |
| I2VA | first frame | develop forward from `<Picture 1>` = Shot 1 |
| FL2VA | first + last | interpolate; prefer single shot; last frame reached by final `[Shot N]` |
| L2VA | last frame only | infer opening; `<Picture 1>` belongs to last `[Shot N]` |

## Output skeleton

```text
<INSTRUCTION (I2VA/FL2VA/L2VA only)>   ← line 1, then blank line

integrated_multimodal_description: [Shot 1] <style>, <opening>...

overall_soundscape: ...

non_diegetic_music: ... or N/A
```

Instruction lines (verbatim):

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.
How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
```

`N` = final shot index · `S.SS` = duration, exactly 2 decimals.

## Timeline & camera

- `[Shot 1]` no timestamp, style + opening composition here. Later: `[Shot 2] At 00:03.500, the shot cuts to...` (strictly increasing).
- Cut verbs: `cuts to` / `transitions to` / `changes to` / `switches to` (prefix `the camera` or `the shot`). Fade/dissolve/wipe only if requested. Cut must add new information; else use camera motion.
- Motion = type + optional `with small/large amplitude` + optional `at slow/fast speed`, as natural action. Types: Zoom/Push/Pan/Truck/Tilt/Pedestal In-Out-Left-Right-Up-Down, Arc, Tracking, Static, Shake Slightly/Strongly, POV, Roll CW/CCW.

```text
The camera pushes in with small amplitude at slow speed toward the letter in her hands.
```

## Dialogue

- IDs `(S1)`…; compound `(S1,S2)`; stable across shots; no ID for silent characters.
- Identity info (voice, age, gender…) **outside** `<d>`; inside: language tag + verbatim user words only.

```text
The young woman with a quiet, breathy voice (S1) says: <d>[English] I get off at the next station.</d>
```

- Voiceover: `says in an off-screen voiceover:` + `while his lips remain completely closed.`
- Line crosses cut → `<scenetrans>` both sides + `continues seamlessly across the cut` (or similar). End truncation → `<cutoff>`.

## Sound split

| Section | Content | Rule |
|---|---|---|
| multimodal description | visuals, actions, dialogue, singing, diegetic audio | main body |
| `overall_soundscape` | ambience, physical sounds, non-verbal human sounds | 1–4 sentences; no dialogue/singing/diegetic music; `N/A` = explicit total silence |
| `non_diegetic_music` | audience-only score: instruments, tempo, rhythm, dynamics | 1–3 sentences; no mood words; `N/A` if none |

On-screen text → English double quotes, verbatim, no translation.
