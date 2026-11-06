# pi-promptimize

`/promptimize` for the [pi coding agent](https://github.com/earendil-works/pi): a popup where you type a rough prompt, pick a size and get an optimized prompt back in the editor.

## Install

```bash
pi install git:github.com/dimitritholen/pi-promptimize
```

## Use

Open the popup with `/promptimize [text]`, `ctrl+r` or `alt+p` (`alt+p` only when your terminal sends Option as Alt).

1. Type the rough prompt and choose a size:
   - **Small:** terse, 1 to 6 lines.
   - **Medium:** compact Markdown sections, about 100 to 250 words.
   - **Large:** a complete prompt with role, approach, constraints, edge cases, a self-check and an output contract.
2. Press Generate. When the prompt leaves real gaps, the model asks up to 4 questions per round, for at most 3 rounds. Enter answers, an empty Enter skips, Tab stops asking and generates.
3. The optimized prompt lands in pi's editor. Skipped details become `[INSERT X]` placeholders.

Keys: Tab moves between fields, ←/→ or 1-3 picks the size, Shift+Enter adds a newline, Esc cancels a running request or closes the popup.

It uses the session's active model.
