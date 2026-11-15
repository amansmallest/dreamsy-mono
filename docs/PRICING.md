# Dreamsy pricing (coins)

Live on prod since 2026-11-15. Every amount is in **coins**: **10,000 coins = $0.10**, so 1,000,000 coins = $10.
Coins are free for now. Buying coins with real money and creator cash-out come next.

## The four parties
| Party | Who |
|---|---|
| **Platform** | Dreamsy |
| **Creator** | made the original game |
| **Spin-off creator** | remixed someone's game into their own |
| **Player** | plays games |

## Prices
| Action | Player pays | Who receives it |
|---|---|---|
| New account | — | **+1,000,000 coins ($10)** starter grant (100 plays, or up to 10 games made) |
| **Play** someone's game | 10,000 ($0.10) | creator **9,000** · Dreamsy 1,000 |
| **Play a spin-off** | 10,000 ($0.10) | spin-off creator **8,000** · original creator **1,000 royalty** · Dreamsy 1,000 |
| **Remix / spin off** a game | 25,000 ($0.25) | **100% to the original game's owner** |
| **Create** a game (first build) | 100,000 ($1.00) | Dreamsy. Refunded automatically if the build fails with no playable version. |
| Edits, tweaks, sprite edits | free | — |
| In-game store items | item price | creator 90% · Dreamsy 10% |

## Free cases
- Playing your **own** games.
- **Replays within 30 minutes**: a paid play opens a 30-minute pass for that game, so reloads, crashes, rematches and multiplayer rejoins aren't charged again.
- **Drafts** shared to your family/friends group, so members can test them.
- Remixing your own game. Spinning off your own game also pays no royalty to yourself (you keep the full 9,000 per play).

## Royalties go one level deep
A spin-off of a spin-off pays the royalty to the **first spin-off's creator**, not the original's.
Example: A makes *Orb Duel* → B remixes it into *Orb Duel+* → C remixes that into *Orb Duel++*.
- A play of *Orb Duel+* pays B 8K and A 1K.
- A play of *Orb Duel++* pays C 8K and **B** 1K. A gets nothing from it.

## Unit economics (measured 2026-11-15)
| | Model cost today | Charged |
|---|---|---|
| Small game | ~$3.50 | $1.00 |
| Big 1–2 h game (multi-round, Opus fast) | ~$14–28 | $1.00 |
| Big game (GPT) | ~$7–14 | $1.00 |
| Edit | ~$0.25 | free |

Creation is **subsidised** for now. The ways we close the gap: kit templates, cheaper content workers, retrieval memory with sprite reuse, caching, and standard speed instead of fast mode for background rounds.
Playing costs us almost nothing to serve: a static engine plus a tiny game package. Paid plays are where creators earn.
A creator gets back a $7–28 build in about **80–310 paid plays** (at $0.09 per play).

## Notifications
Every earning sends a **"You got paid"** notification to the in-app inbox. It also sends a push on iPhone, and the app shows a coin toast. Examples:
- "@maharshicus played Orb Duel — +9K coins ($0.09)"
- "@judge_demo remixed Orb Duel — +25K coins ($0.25)"
- "@x played Orb Duel (remix), a spin-off of your Orb Duel — +1K coins royalty ($0.01)"

## Config (API env)
`PLAY_PRICE=10000` · `CREATOR_SHARE=0.9` · `PLAY_PASS_MINUTES=30` · `CREATE_PRICE=100000` · `REMIX_PRICE=25000` · `SPINOFF_ROYALTY=1000` · `STARTER_STARS=1000000`
The spec is in DREAMSY.MD §11.6.

## Known limits (v1)
- The pay gate is checked in the app. The server doesn't yet refuse to send the game's files without a play pass.
- There's no real-money top-up or cash-out yet.
