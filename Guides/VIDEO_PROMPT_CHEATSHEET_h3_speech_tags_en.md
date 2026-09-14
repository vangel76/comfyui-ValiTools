# Hailuo 3 (H3) Speech-Tag Cheat-Sheet

Companion to `VIDEO_PROMPT_CHEATSHEET_base_en.md` / `..._ref_en.md`. Tags go **inside** the dialogue block: `<d>[English] ... </d>`.
Source: [r/StableDiffusion — "Pushing AI emotions is possible through..."](https://www.reddit.com/r/StableDiffusion/comments/1wap0rb/pushing_ai_emotions_is_possible_through/)

## Tags that work

### Pauses & breathing

| Tag | What it does | Example |
|---|---|---|
| `<pause>` | Short pause | `Okay, so. <pause> This is just me talking.` |
| `<long pause>` | Longer pause | `I mean... <long pause> I don't even know.` |
| `<breath>` | Breathing sound | `And then... <breath> it just happened.` |
| `<inhale>` / `<exhale>` | In / out breath | `<inhale> Alright, let's do this.` |
| `<catches breath>` | Out of breath | `Wait... <catches breath> hold on a sec.` |
| `<deep breath>` | Calming down | `<deep breath> Okay. I can do this.` |
| `<pant>` / `<pants>` | Panting | `Run... <pants> run now!` |
| `<phew>` | Relief | `<phew> That was close.` |

### Delivery / emphasis (paired tags)

| Tag | What it does | Example |
|---|---|---|
| `<i>word</i>` | Emphasize 1–4 words | `I was <i>not</i> expecting that.` |
| `<whisper>…</whisper>` | Whisper delivery | `<whisper> Don't tell anyone this.</whisper>` |
| `<softer>` | Quieter delivery | `<softer> I don't think I can say it.` |
| `<humming>…</humming>` | Humming a tune | `<humming> da-da-da-beautiful-day.</humming>` |
| `<stutter>` | Stutters the words | `<stutter> I ca can't believe that.` |

### Reactions & vocal sounds

| Tag | What it does | Example |
|---|---|---|
| `<laughs>` / `<chuckle>` | Laughing | `That's... <laughs> that's actually funny.` |
| `<sighs>` | Sigh | `<sighs> I really tried.` |
| `<gasp>` | Sharp intake | `<gasp> Oh my God.` |
| `<uh>` | Filler / hesitation | `So, like... <uh> what was I saying?` |
| `<mhm>` | Agreement sound | `Yeah, <mhm> exactly.` |
| `<coughs>` | Cough | `<coughs> Sorry, one sec.` |
| `<clears throat>` | Throat clear | `<clears throat> So anyway...` |
| `<sniff>` | Sniffing | `<sniff> It's just... really sad.` |
| `<smacks lips></smacks lips>` | Lip smack — leaving it unclosed makes it happen at the **end** of the sentence | `<smacks lips></smacks lips> Okay.` |

## Notes

- Many more tags work; test yourself.
- Combine with punctuation: `...` and `…` add hesitation on top of tags.
- Write stutters into the text too (`E-erase`), not only the tag.
- Skin at high res: model exaggerates saturation/wrinkles. Prompting "soft, even, natural color, pores visible without harsh contrast" helps only a little.

## Full example (structure from the post)

```text
[Shot 1] The shot begins from the source <Video 1>. Extreme close-up of <Subject 1>, head and shoulders, face to the lens, perfectly symmetrical, shot on an anamorphic lens: wide close-up. A soft key light hits one side of his face, a close fill holds the other side, and a backlight rims his hair and shoulders off the white. The light wraps. Highlights on the forehead and cheeks roll off gently. He is Frank Underwood, portrayed by Kevin Spacey, in a suit and a red tie; his skin and wrinkles match <Picture 1>, soft, even, natural color, pores visible without harsh contrast. Behind him the background is an infinite white cyclorama. His head and shoulders stay in that same place in the frame for the whole take. He is already looking into the lens.
He stays on the lens, colder. <Subject 1> (S1) says, <d>[English] <breath> I think you're... <i>sorry</i>. <pause> You had the <i>real thing </i>. The real <i>me</i>. <inhale> But... <inhale> you decided to cancel me. <stutter> E-erase me from anywhere you could see me. <catches breath> And now, with this… MiniMax… <chuckle> you've decided to bring me back to... <i>life</i>. <long pause> </d>
```

Pattern: `<Subject N> (SN) says, <d>[Language] <tag> text <tag> text </d>` — tags sit between words, emphasis tags wrap words.
