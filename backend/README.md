# Answer log (optional)

Out of the box, Deep Cut sends nothing anywhere. If you switch this on, every Daily and Infinite answer is appended to a Google Sheet you own. That gives you two things:

1. **Answers to review.** On open-ended prompts, a correct answer that isn't in `questions.json` yet scores "Not verified" (0 points, not marked wrong). The sheet shows you what people typed, so you can add the good ones.
2. **Tiers from real data.** `tools/retier.mjs` counts what share of players gave each answer and suggests tiers, instead of relying on the starter guesses.

Each row holds the timestamp, puzzle date, mode, prompt id, the text typed, the answer it matched, and the result. Nothing identifies the player.

## Setup (about 10 minutes, free)

1. Create a new Google Sheet, for example *Deep Cut answers*.
2. Open **Extensions → Apps Script**, delete the sample code, paste in all of `google-apps-script.js`, and save.
3. Click **Deploy → New deployment**. Choose the type **Web app**, set *Execute as* to **Me** and *Who has access* to **Anyone**, then click **Deploy**. Approve the permissions prompt.
4. Copy the web app URL. It looks like `https://script.google.com/macros/s/…/exec`.
5. Paste it into `js/config.js`:
   ```js
   export const ANSWER_LOG_URL = 'https://script.google.com/macros/s/…/exec';
   ```
6. Commit and push. Once the change is live, an `answers` tab appears in the sheet with the first answer submitted.

When the URL is set, the How to play screen also tells players that answers are recorded anonymously.

**Note:** anyone who finds the URL can read the logged answers or post junk rows. The data holds no personal information, and the retier script ignores prompts with too few answers. Even so, treat the counts as a guide rather than gospel.

## Using the data

**Review unverified answers.** In the sheet, filter the `status` column to `unverified`. If an answer is correct, add it to that prompt in `questions.json` with a tier, plus any spellings people used as `aliases`.

**Suggest tiers.** Download the sheet with **File → Download → CSV**, or pass the web app URL directly:

```sh
node tools/retier.mjs answers.csv            # report only
node tools/retier.mjs answers.csv --write    # also update tiers in questions.json
node tests/test.mjs                          # then check the bank
```

- **What's counted:** only Daily answers, because Infinite lets people retry. A prompt needs at least 50 Daily answers before its tiers are touched (`--min` changes this).
- **Thresholds:** a tier is set by the share of all answers to that prompt that named it: 20%+ is a Tap-in, 8%+ Solid, 3%+ Good Shout, 1%+ Proper Fan, and anything rarer is a Deep Cut. You can change these at the top of the script.
- **Hidden Gems:** these stay hand-picked. The report only warns when one is given by 1% or more of players.
- **Unrecognised answers:** the report also lists the most common answers that weren't on the list. For closed prompts these were marked wrong, which is a hint that the "complete" list might be missing something.
