# Full-Reference Cheat-Sheet

Companion to `VIDEO_PROMPT_WRITING_GUIDE_ref_en.md`. Shot/camera/speaker basics: see `VIDEO_PROMPT_CHEATSHEET_base_en.md`.

## Six sections, this order

```text
subject_definitions:
<Subject 1> is ...
<Picture 2> is ...        ← only if image = concrete frame anchor
<Video 1> is ...
<Audio 1> is ...

summary:
[task type + task type] ...

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - ...
<Audio 1>: fully_copy - ...

detailed_description:
<style sentence(s)>        ← BEFORE [Shot 1] (diff from base)
[Shot 1] ... <Subject 1> (S1) says, <d>[English] ...</d>

overall_soundscape: ...
non_diegetic_music: ... or N/A
```

## Labels

| Label | For |
|---|---|
| `<Subject N>` | reusable visible content (people, scenes, props, styles, actions) |
| `<Picture N>` | image = first/key/last frame, anchor, or storyboard |
| `<Video N>` | whole-video: edited source, continuation, or structure reference |
| `<Audio N>` | copied/referenced audio signal |

- Label meaning fixed once assigned, same across all sections.
- Image only defining a subject → cite inside its `<Subject N>` line, no standalone line.
- People/actions from a video → `<Subject N>`, not `<Video N>`.
- `<Video N>` / `<Audio N>` numbered independently; sound-in-file ≠ `<Audio N>`.
- Speaker-bound audio reuses `(Sx)`: `<Audio 1> is the voice-timbre reference for <Subject 1> (S1).`

## Task types (summary prefix)

| Type | Trigger |
|---|---|
| `keyframe completion` | image = concrete frame anchor |
| `reference generation` | asset guides character/scene/style/camera, not a frame or source |
| `video editing` | source video directly modified |
| `video continuation` | extends/resumes an existing video |
| `audio reuse` | same signal reused (full or part) |
| `audio reference` | only style/timbre/content/beat referenced |

Combine with ` + `, no repeats. Presence of a file alone creates no type. Editing + audio kept → add `audio reuse`. Editing summary opens: `The target video is an edited version of <Video 1>.` No new labels here.

## Retention markers

| Visible | Audio |
|---|---|
| `fully_preserved` | `fully_copy` |
| `partially_preserved` | `partially_copy` |
| `attribute_transfer` | `reference` |
| `weak_reference` | `weak_reference` |

Marker within role defined in `subject_definitions`. No `(Sx)` here. New target-video events ≠ fidelity loss.

## detailed_description diffs vs base

- Field renamed; style before `[Shot 1]`; insert labels at first appearance + where roles apply; cite `<Audio N>` where active (copied vs referenced).
- Generation: 350–500 words (dialogue-dense → fit timeline first). Editing: scale with source.
- Frame anchors: `the shot begins from <Picture 1>` / `... keyframe corresponds to <Picture 2>` / `... ends on <Picture 3>`.

## Speakers + labels

```text
<Subject 2> (S1) turns toward the woman and says, <d>[English] ...</d>
```

- Cue inside directly reused BGM, no independent vocal source → source is `<Audio N>`, no invented `(Sx)`.
- Reused reference dialogue → exact source words in `<d>`; unintelligible → `[unclear]`; standardize punctuation to `,` `.` `?` `!`; strip tildes/emoji/decorative marks.
- Timbre-only reference → do not carry original words.
- `(Sx)` assigned by order of actual vocal events, reused everywhere, never in `retention_analysis` or independently in `<Audio N>` definitions.

## Sound sections

Relationships stated only in the matching layer: ambience/SFX → `overall_soundscape`; score → `non_diegetic_music` (both if one audio provides both). Dialogue/lyrics only inside `<d>`.
