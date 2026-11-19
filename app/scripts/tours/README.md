# README walkthroughs

```bash
cd app
npm run tours              # every tour, into ../docs/media/walkthrough/
npm run tours -- tour3     # one of them
```

That is the whole job: it starts the dev server, records each tour in a hidden
window, encodes it and cleans up. Needs Python 3 with Pillow (`PYTHON` to pick
another interpreter). Close nothing: it never starts the app itself.

| File                     | What it is                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `record.mjs`             | The runner, and the list of finished tours (`TOURS`).                                                                                                              |
| `tour3.cjs`              | Tour 3, per-game auto-switching: its story, step by step, in milliseconds.                                                                                         |
| `tours-preload.js`       | Runs in the page first: the virtual clock, and the desktop host's answers the browser edition lacks (auto-switch, profiles).                                       |
| `tour-page.js`           | In the page: the cursor, the captions, the real switch popup (overlay.html) in a frame.                                                                            |
| `encode.py`, `mux.py`    | Frames to animated WebP. A still background is encoded as changes only (`--mode delta`); a moving one needs every frame whole (`--mode independent`, much bigger). |
| `tour1.cjs`, `tour2.cjs` | Tours 1 and 2, the mouse and the keyboard, on `harness.cjs` (their shared recorder) and `prep.cjs` (the devices' state before recording).                          |

To change a tour, edit its timeline (times, captions, what is clicked) and run
it again. Every frame is drawn on the virtual clock, so the result does not
depend on the machine's speed.
