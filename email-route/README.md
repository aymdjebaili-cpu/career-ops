# email-route — applications sent by email

The portal pipeline (`daily-run.mjs` → `auto-apply.mjs` → the agent) applies through forms.
This folder applies by **email**, to the address a company publishes itself. Nothing is ever
sent: every run ends as a Gmail *draft*.

Built 2026-09-15. First run produced 13 drafts (10 posted jobs + 3 speculative).

## What it found, so you know what to expect

- 111 Munich/remote junior candidates (fit ≥ 2.5, last 21 days) → **10** publish an
  application address. All 10 postings required German above B1.
- 144 Munich companies posting English-language roles → **5** publish an address.

German Mittelstand prints `bewerbung@`; English-working companies route everything through
an ATS portal. That ratio is the reason this route is small, not a bug in the scripts.

## Run order

```bash
npm run emails            # candidates → published addresses → compact reports
                          # (= emails:candidates, emails:find, emails:reports)

node daily-run.mjs --skip-scan --skip-liveness --skip-eval --score=2.5
                          # letters + per-job tailored CV + output/email-NNN-*.md

npm run emails:spec-targets && npm run emails:spec    # speculative English applications

npm run emails:claims     # EVERY first-person sentence, for a human read — do not skip
npm run emails:verify     # recipient/attachments/figures/banned terms; --fix corrects labels
npm run emails:push       # save-drafts.mjs --score=2.5  → Gmail drafts
```

`npm run drafts` alone defaults to `--score=3.5` and silently skips most of these.

## The review step is not optional

The headless letter workers invent qualitative detail that no figure check catches. Found on
the first run, in 7 of 14 letters: "täglich"/"daily" routines, "davor"/"zwei Jahre" timelines
(the iPro role runs Dec 2024–present, concurrent with DJE Holidays since May 2026), contact
with "Behörden", "Preisverhandlungen", "Verträge gepflegt", "guest-facing experience",
"structured trainings", "expense accounting". One letter (Swissbit) invented an entire
settlement/reconciliation system build to fit a POS product role — it was set aside, not sent.

`emails:verify` checks recipients, attachments, banned terms and every figure against
`cv.md` / `cv-de.md` / `config/profile.yml` / `modes/_profile.md` / `article-digest.md`.
`emails:claims` prints the sentences a pattern cannot judge. Read them.

## Files

| Script | Does |
|---|---|
| `build-email-candidates.mjs` | pipeline.md → Munich/remote, junior, fit ≥ min, not already applied. Keeps login-walled postings: email bypasses the wall. |
| `find-emails.mjs` | dedupes, attaches an existing report, then `find-application-email.mjs` per company. Never guesses an address. |
| `write-light-reports.mjs` | compact honest report per job (verified address first, other addresses masked, German gap stated) so the letter/CV/draft steps have something to read. |
| `build-speculative-targets.mjs` | Munich companies posting English roles, agencies excluded, with their published address. |
| `speculative-drafts.mjs` | letter (`batch/speculative-en-worker-prompt.md`) + PDF + English tailored CV + `output/email-spec-*.md`. |
| `verify-drafts.mjs` | the gate before `emails:push`. `--fix` corrects address-provenance lines, `--claims` prints claim sentences. |

State lives in `output/email-route/*.json`; drafts in `output/email-*.md`.
