# Deep Cut

A daily football trivia game where **obvious answers score low and rare-but-correct answers score high**.

- **Daily:** everyone gets the same 7 prompts each day, with 25 seconds per prompt, max 700 points. Wrong answers aren't submitted: you're told why and keep guessing until your first correct answer locks in, or the whistle goes. Every point rolls a ball up the football pyramid, from Sunday League to the Ballon d'Or, with a promotion banner each time you go up a level. At full time you see the level you reached, how your score compares with everyone else's, each prompt's Hidden Gem, and a spoiler-free emoji grid to share.
- **Infinite:** endless prompts on a single 45-second clock. Correct answers add time (+5s for a Tap-in, up to +15s for a Hidden Gem). You can't use the same answer twice in a run.

It's plain HTML, CSS and JavaScript (ES modules). There's no build step, no backend and no accounts.

## Running it

Browsers won't let a page loaded from `file://` fetch `questions.json`, so serve the folder:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

**GitHub Pages:** in the repo's **Settings → Pages**, choose *Deploy from a branch*, then `main` and `/ (root)`. The game will be at `https://tobyweekes-ctrl.github.io/daily-niche-football-l/`. All paths are relative, so any static host works too.

## Files

| Path | What it is |
|---|---|
| `index.html` | Markup, How-to-play and stats dialogs |
| `css/style.css` | Floodlit-pitch theme (original artwork only, with no crests, logos or photos) |
| `js/app.js` | Screens, timers, scoring, sharing |
| `js/match.js` | Answer matching (normalising, aliases, surnames, typos) |
| `js/daily.js` | Deterministic daily selection |
| `js/rank.js` | Pyramid levels and the score model behind "You vs the world" |
| `js/storage.js` | localStorage persistence (stats, streaks, mid-game state, unverified answers) |
| `js/config.js` | Optional answer-log URL (empty by default, so nothing leaves the device) |
| `backend/` | Free Google Sheets answer log and setup guide |
| `tools/retier.mjs` | Suggests tiers from logged answers |
| `questions.json` | The question bank |
| `tests/test.mjs` | Validates the bank and tests matching and daily selection |

## Adding a prompt

Add an object to the `prompts` array in `questions.json`:

```json
{
  "id": "ucl-final-scorers",
  "prompt": "Name a player who has scored in a Champions League final (1993–2025, not shoot-outs)",
  "category": "Champions League",
  "asOf": "2025-06-01",
  "answerType": "person",
  "closedSet": true,
  "_comment": "needs fact-check",
  "answers": [
    {"name": "Cristiano Ronaldo", "aliases": ["Ronaldo", "CR7", "Cristiano"], "tier": "Tap-in"},
    {"name": "Vinícius Júnior", "aliases": ["Vinicius", "Vini Jr"], "tier": "Solid", "surname": false},
    {"name": "Dmitri Alenichev", "tier": "Hidden Gem"}
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique and stable. **Don't rename ids once live:** the daily schedule and saved games refer to them. |
| `prompt` | yes | The question as shown. **It must include a year or date range** ("1993–2025", "1992/93–2024/25"), so the prompt stays true after the next season or final; the tests enforce this. When you refresh a bank, move the range forward. |
| `category` | yes | Short label shown on the card. |
| `asOf` | yes | `YYYY-MM-DD` date the answers are correct to. Shown in the game as "Correct as of …". It matters most for prompts based on current data, such as this season's League One clubs. |
| `answerType` | yes | `person`, `club`, `country`, `stadium` or `other`. Only `person` gets automatic surname-only matching. |
| `closedSet` | no | `true` only when the bank lists **every** correct answer, such as all PL Golden Boot winners. Then an unknown answer is a miss. On open prompts (anything without `closedSet`), an unknown answer scores **Not verified**: 0 points for now, but not marked wrong, and logged so you can add it. Leave the flag off if you're not sure the list is complete. The tests warn when an open prompt has fewer than 50 answers. |
| `_comment` | no | Free text. Every starter prompt is marked `"needs fact-check"`. Change it to something like `"checked 2026-11-01"` once you've verified it. |
| `answers` | yes | See below. |

Each answer has:

- `name`: the canonical name shown in reveals and results.
- `tier`: one of `Tap-in`, `Solid`, `Good Shout`, `Proper Fan`, `Deep Cut`, `Hidden Gem`.
- `aliases` (optional): other spellings and nicknames, e.g. `["Man Utd", "Man United", "MUFC"]`.
- `surname` (optional, people only): `"Park"` replaces the automatic surname, which is useful for names like *Park Ji-sung*, where the last word isn't the surname. `false` turns surname-only matching off for that answer.

### Assigning tiers

| Tier | Points | Infinite bonus | Use for |
|---|---|---|---|
| Tap-in | 10 | +5s | The answer everyone gives first |
| Solid | 25 | +7s | Common answers |
| Good Shout | 40 | +9s | Less obvious |
| Proper Fan | 60 | +11s | Uncommon: you need to really follow the game |
| Deep Cut | 85 | +13s | Very obscure |
| Hidden Gem | 100 | +15s | **Exactly one per prompt**, hand-picked as the rarest |

Some rules of thumb:

- Tier by **how often people would say it**, not by how good the player is. Pelé is a Tap-in; the 1930 scorer Pablo Dorado is the Hidden Gem.
- Keep Tap-ins to a handful (3–7). If half the bank is Tap-in or Solid, the scoring loses its tension.
- Pick a Hidden Gem that's rare but fair: once a player sees it on the results screen, they should think "of course!" rather than "who?".
- A rough shape for a 50-answer bank is 5 Tap-in, 10 Solid, 15 Good Shout, 12 Proper Fan, 7 Deep Cut and 1 Hidden Gem.

### Then run the checks

```sh
node tests/test.mjs
```

This fails if a prompt is missing a field, has an invalid tier, doesn't have exactly one Hidden Gem, has duplicate answers, or contains an answer that can't be matched by typing its own name. It warns if an alias is shadowed by another answer's name, or if an open prompt has fewer than 50 answers.

## How answers are matched

1. **Normalised:** comparisons ignore case, accents (Ødegaard = Odegaard), punctuation, hyphens, extra spaces, and the words "FC" and "The".
2. Matching tries the **exact name** first, then **aliases**, then the **surname alone** (people only; "van Persie" and "Persie" both work). A higher level always wins.
3. If several answers tie at the same level (for example "Neville" when the bank has Gary *and* Phil, or "Ronaldo" when it has both Ronaldos), the player is asked to **be more specific**. This doesn't use up their answer. In Infinite mode, answers already used are skipped first, so "Neville" after Gary resolves to Phil.
4. **Misspellings are never marked wrong when it's clear who you meant.** The game shows "Did you mean **Martin Ødegaard**?", and you can tap the name or press Shoot again to confirm. It doesn't cost you your answer.
   - **How many typos are allowed** depends on the *shorter* of the typed word and the name it's compared with: 5–6 letters allow 1, 7–11 allow 2, and 12+ allow 3. Names of 4 letters or fewer must be exact. So a short alias ("Arena") can't absorb a long wrong answer ("Arsenal"). A swapped pair of letters ("Gerrrad", "Hnery") counts as one typo.
   - **Only when it's clear:** a suggestion appears only when one answer is clearly closest. If two are close ("Nevlle": Gary or Phil?), you're asked to be more specific instead.
   - **On the buzzer:** if the clock runs out with a clear misspelling in the box, it counts.
   - **Tested:** a test drops a letter from every answer in the bank and checks that it never suggests a different answer.
   - **Optional words:** for stadiums and clubs, filler words are optional: "Liberty" = "Liberty Stadium", "Brugge" = "Club Brugge".
   - **Cities are never stadiums.** `questions.json` has a top-level `cities` list. Typing one ("Düsseldorf") on a stadium prompt is "a city, not a stadium". If dropping "Stadium" from a name would leave only a city ("Cologne Stadium"), the full name is required. Add a city to that list whenever you add a stadium named after one.
5. **Wrong answers aren't submitted.** You're told why ("isn't in our bank", "is a city, not a stadium") and can try again while the clock runs. Your first correct answer is the one that scores. Every wrong try is logged, and the results screen notes how many you needed. If time runs out after an answer scored "Not verified", that's the result for the prompt instead of a blank.
6. **Right name, wrong kind of thing:** the game knows every club, stadium, country and person in the whole bank. A club typed for a stadium prompt ("Arsenal" for Highbury), a stadium typed for a player ("Wembley"), or a country typed for a club is marked wrong, with a reason such as "“Arsenal” is a club, not a stadium". It's never suggested, and never scored "Not verified". A stadium's real name still counts even when it contains a club name ("Arsenal Stadium" = Highbury). Avoid aliases that are just "[club] Stadium" unless the ground really was called that.
7. In Infinite mode, an answer you've already given for that prompt is blocked with a message, and doesn't cost you a go.
8. If nothing matches: on a `closedSet` prompt it's a miss. On an open prompt, anything of 3+ letters is **Not verified**. It scores 0 (giving points would let anyone type nonsense), shows as ❔ in the share grid, and is saved for review. You can find saved answers under **Stats → Copy for review**, or in the answer log if that's switched on.

Whatever is in the box when the daily clock hits zero is submitted "on the buzzer". It counts only if it's a clean match.

## How the daily set is chosen

`js/daily.js` picks prompts deterministically from the date, so every player gets the same set without a server:

- Each prompt is ranked for a given day by a hash of `day|id`, so the order of `questions.json` doesn't matter.
- The schedule replays every day since `EPOCH` (puzzle #1, 2026-10-24), and a prompt isn't picked again within **30 days**.
- **With only 30 prompts that rule can't hold:** 30 days × 7 prompts needs at least 217 prompts. Until the bank reaches that size, the picker tops up each day with the least recently used prompts. With 30 prompts each one returns roughly every 4–5 days. Grow the bank and the 30-day gap takes over automatically.
- **Variety:** a day has at most 2 prompts from one category, and at most 2 club, stadium or country prompts. Two prompts in a row never share a category, or a club/stadium/country answer type. The tests check this across a full year of dailies.
- The 7 prompts are shuffled into a seeded order for the day.
- The puzzle flips at the player's local midnight.

Editing `questions.json` changes the schedule from then on, for everyone loading the new file. A player who has already started today keeps the set they started with, because it's saved locally.

## The answer animation

Every answer plays a short shot on a mini pitch (`js/shot.js`), and the rarer the answer, the further out it's struck from:

| Tier | Shot |
|---|---|
| Tap-in | 6 yards: tapped in |
| Solid | 12 yards: from the spot |
| Good Shout | 18 yards: edge of the box |
| Proper Fan | 25-yard rocket |
| Deep Cut | 35-yard screamer |
| Hidden Gem | from the halfway line |

The ball rolls back up the pitch while the yardage ticks up, like a depth meter. Then it's struck into the top corner: the net bulges, "GOAL!" flashes, the points count up and the pyramid ball moves. A wrong answer goes over the bar, and an answer that's not verified goes to a "VAR" check.

Tap the card once to skip the animation, and tap again to move on. If the device is set to reduce motion, it shows the result straight away.

## The pyramid and "You vs the world"

These are set in `js/rank.js`:

| Level | Points | Roughly reached by |
|---|---|---|
| Sunday League | 0+ | everyone |
| Non-League | 50+ | 90% |
| League Two | 100+ | 66% |
| League One | 150+ | 44% |
| Championship | 200+ | 28% |
| Premier League | 270+ | top 13% |
| Champions League | 350+ | top 4% |
| Ballon d'Or | 450+ | top 0.4% |

There are no live results to compare against, so the percentile comes from a **probability model**. Players are a mix of casual (40%), regular (40%) and expert (20%). Each type has its own chance of a miss, a Tap-in and so on, up to a Hidden Gem, on every prompt. The game works out the exact spread of 7-prompt totals for that mix. The results screen shows "Top X%", plus a chart of the spread with your score marked; tap a bar for its numbers.

To tune it, edit `PLAYER_TYPES` in `js/rank.js`. Once the answer log has data, you can measure these shares instead of guessing them. If you move the level thresholds, the "reached by" column is easy to recompute with `percentile()`.

## Setting tiers from real data

The starter tiers are educated guesses. To base them on what players actually type, switch on the optional answer log: a Google Sheet with about 10 minutes of setup and no server to run. Then run `node tools/retier.mjs`, which suggests a tier for each answer from how often it was given, and lists the unverified answers worth adding. See [`backend/README.md`](backend/README.md).

## Testing tools

While `ALLOW_DAILY_REPLAY` is `true` in `js/config.js`, the daily results screen shows two extra buttons:
- **Replay today** plays the same 7 prompts again.
- **Try another set** deals 7 different prompts, chosen with the same variety rules.

Replays never change your stats, since only the first completed game of a day counts. Set the flag to `false` before you share the game widely.

## What's saved (localStorage)

Everything is saved under one key, `deepcut.v1`:

- streak, best streak, games played, average and best score, and score history by date
- the day's in-progress game. The 25-second deadline is stored as a timestamp, so **refreshing doesn't pause the clock**.
- an in-progress Infinite run. After a refresh it resumes **paused**, with the prompt hidden until you tap Resume.
- whether you've seen How to play (shown automatically on your first visit)
- the last 300 unverified answers you gave (for **Stats → Copy for review**)

If storage is blocked (some private-browsing modes), the game still runs but forgets everything when the tab closes.

## A note on the starter bank

There are 81 prompts (about 2,700 answers), and all are flagged `"needs fact-check"`. Most were written from memory. The 2025/26 and 2026 updates were checked against news reports in October 2026:
- **2025/26 season:** Arsenal champions, Haaland Golden Boot, Coventry, Ipswich and Hull promoted, Bruno Fernandes PFA.
- **Cups:** Man City won the FA Cup and the League Cup.
- **European finals:** PSG won the Champions League (Havertz and Dembélé scored), Aston Villa the Europa League, and Crystal Palace the Conference League.
- **World Cup 2026:** Spain won, and Ferran Torres scored the only goal of the final.
- **Elsewhere:** Senegal won AFCON 2025, and Flamengo the 2025 Libertadores.

Not yet updated, because sources conflicted or the event hadn't happened yet:
- **England's 2026 World Cup scorers:** `england-wc-scorers` still ends at 2022.
- **Spain's 2026 squad:** `wc-winning-squads` still ends at 2022.
- **The 2026 Ballon d'Or:** the ceremony is on 26 October 2026.
- **The 2026 FA Cup-winning manager.**

The prompts span the Premier League and EFL, Scottish, European, South American, MLS and international football, women's football, badges and kits, shirt sponsors, nicknames and derbies, famous games, records, transfers and managers.

The ones most likely to need correcting:
- **Badges and kits (`bird-crests`, `yellow-home-kits`, `red-white-stripes`):** crests and kits change, so these are dated 2025/26.
- **`kit-manufacturers` and `pl-shirt-sponsors`:** long, open lists, where the obscure entries are the ones to check.
- **`wc-2026-teams`:** I couldn't confirm the two intercontinental play-off winners. DR Congo and Iraq are listed, and the prompt is left open, so a correct team I've missed scores "Not verified" rather than wrong.
- **`saudi-pro-league-signings`:** transfer details.

- **Current data:** `efl-l1-l2-2025-26` (division membership) and `pl-100-club` (as of June 2025; Erling Haaland will have joined since).
- **Squad edge cases:** `ucl-english-winners` (unused substitutes in finals), and fringe appearances in `title-seasons-blackburn-leicester`. `wc-winning-squads` now lists all seven full squads (1998–2022) and is marked as a closed set.
- **Caretaker managers:** `big-club-managers`.
- **"Whole career" claims:** `one-club-men`, where youth or amateur spells are easy to get wrong.
- **Transfer histories:** `real-madrid-and-england` and `barcelona-and-england`, where a short loan can make or break an answer.
