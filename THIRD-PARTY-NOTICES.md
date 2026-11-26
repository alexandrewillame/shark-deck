# Third-party notices

Shark Deck is GPL-3.0-or-later (see [LICENSE](LICENSE)). It includes data
from, and was informed by, the projects below.

## Data included in Shark Deck

### sharkfin — keyboard rows Driver v4 does not describe

- Project: <https://github.com/dniminenn/sharkfin> (by JR, @dniminenn)
- Licence: GPL-3.0-or-later
- Used: the rows of 16 Attack Shark keyboards the vendor's Driver v4 3.2.20
  does not list, and the key layouts of 7 boards it draws from pictures
  rather than key grids, as imported from sharkfin's registry at commit
  `8c999ba7d44254f5206fb0ff25ed7cea6ebbb496`, kept in
  `app/scripts/data/keyboard-rows-outside-v4.json` until an owner's report
  or a newer Driver v4 replaces them. The rest of the keyboard registry comes
  from Shark Deck's own reading of Driver v4
  (`app/scripts/extract-keyboard-registry.ts`).

## Protocol references (facts only, no code copied)

Each driver's protocol document under [`docs/protocol/`](docs/protocol/) names
the sources of every fact it relies on, with their licences. Where a source
has no licence, or one that is not compatible with Shark Deck's (AGPL-3.0),
only the protocol facts it documents were used; Shark Deck's implementation is
its own.

| Source | Licence | Facts used for | Document |
|---|---|---|---|
| [sharkfin](https://github.com/dniminenn/sharkfin) `docs/PROTOCOL.md` | GPL-3.0-or-later | the yc500 command set, the 2.4 GHz receiver relay | [keyboard-yc500.md](docs/protocol/keyboard-yc500.md), [receiver-relay.md](docs/protocol/receiver-relay.md) |
| [dnim.dev](https://dnim.dev/blog/royuan-keyboard-protocol) — "ROYUAN keyboard protocol" | (article) | the yc500 command set | [keyboard-yc500.md](docs/protocol/keyboard-yc500.md) |
| [Dorsal](https://github.com/Zelozzzz/dorsal) | MIT | the Hub mice's model table and PAW3955 DPI records; the JXC protocol | [README.md](docs/protocol/README.md), [mouse-jxc.md](docs/protocol/mouse-jxc.md) |
| [OpenMouse mouse-protocol](https://github.com/OpenMouse-Project/mouse-protocol) | AGPL-3.0 — facts only | the GearHub and JXC protocols, the Beken notes | [mouse-gearhub.md](docs/protocol/mouse-gearhub.md), [mouse-jxc.md](docs/protocol/mouse-jxc.md), [mouse-beken.md](docs/protocol/mouse-beken.md) |
| [innox2-mac](https://github.com/codewithwan/innox2-mac) | MIT | the GearHub relay and options block | [mouse-gearhub.md](docs/protocol/mouse-gearhub.md) |
| The Attack Shark X11 community tools (HarukaYamamoto0, HolyJoey, clevim, devmarciordg, akawazak, blak0p, cyberps96: MIT; KaiSta, xb-bx: no licence — facts only) | as listed | the Beken notes | [mouse-beken.md](docs/protocol/mouse-beken.md) |
