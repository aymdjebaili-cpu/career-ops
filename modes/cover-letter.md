# Mode: cover-letter — Tailored Cover Letter Generator

Generates a single formal cover letter (350–450 words) for one already-evaluated job. Output is a markdown file ready to (a) paste into an application form, (b) be appended to a Gmail draft body via `save-drafts.mjs`, or (c) be converted to PDF via the existing PDF pipeline.

## When to invoke

- Manually: user pastes a report path or report number, asks for a cover letter
- Automatically: `daily-run.mjs` calls this mode for every report with `score >= 3.5`

## Inputs

- `report_path` (required) — `reports/{num}-{slug}-{date}.md`
- Implicitly read:
  - `cv.md` — proof points and experience
  - `config/profile.yml` — candidate info, narrative, compensation, location
  - `modes/_profile.md` — adaptive framing per archetype
  - `article-digest.md` (optional) — extra quantified proof points

## Output

`output/cover-letters/{num}-{company-slug}-{lang}.md` with this exact structure:

```markdown
---
COMPANY: {company}
ROLE: {role}
REPORT: {num}
JD_URL: {url from report header}
LANGUAGE: {EN|DE|FR}
WORD_COUNT: {n}
GENERATED: {YYYY-MM-DD}
---

{Greeting line}

{Paragraph 1 — Hook}

{Paragraph 2 — Motivation + fit}

{Paragraph 3 — Value-add with quantified proof points}

{Paragraph 4 — Close}

{Sign-off}
AIMENE DJEBAILI
Aym.djebaili@gmail.com
```

## Workflow

```text
1. READ report → extract company, role, JD URL, score, JD language, key responsibilities (Block A), CV match notes (Block B), public signals (Block G)
2. READ cv.md → grab top 2-3 quantified proof points relevant to this role's responsibilities
3. READ profile.yml → narrative.exit_story, narrative.superpowers, narrative.proof_points, candidate name/email
4. DETECT language from JD content + report header → EN, DE, or FR (German for DE-language postings is preferred when posting is in DE)
5. WRITE 4-paragraph letter (see structure below)
6. ENFORCE 350-450 words; trim or expand as needed
7. SAVE to output/cover-letters/{num}-{company-slug}-{lang}.md
```

## Paragraph structure (target 350–450 words)

### §1 — Hook (~80 words)
- Name the company specifically (not "your company")
- Cite ONE concrete public signal from Block G (recent product launch, market position, mission statement)
- State the role title and why it fits *now*
- Avoid clichés: do not write "I am writing to apply for...", "I came across your job posting...", "I am a passionate..."

### §2 — Motivation + Fit (~110 words)
- Bridge from the exit story (config/profile.yml → narrative.exit_story) to this role's responsibilities (report Block A)
- Mention the strongest archetype match from `modes/_profile.md` "Adaptive Framing" table
- Stay specific: name 2–3 responsibilities from the JD and connect them to the candidate's recent work
- Mention finance-and-digital-economics background if relevant (transferable analytical skill)

### §3 — Value-Add with Proof (~130 words)
- Lead with 2 quantified results from `profile.yml` → `narrative.proof_points` or `cv.md`, e.g.:
  - "Recovered €1.6M in B2B receivables through 100+ structured follow-ups with tourism partners"
  - "Converted 345 verified bookings from 1,271 leads (€205K booking value) in the Algerian hospitality market"
  - "Founded SafiNest, a pre-MVP hospitality platform for short-term rentals"
- Tie each result to a specific outcome the role exists to deliver (NOT a generic "I am results-oriented")
- If role mentions OTA/booking systems → emphasize iPro Booking experience
- If role mentions revenue/finance → emphasize €1.6M recovery + tax inspector exposure
- If role mentions product/platform → emphasize SafiNest founder track

### §4 — Close (~70 words)
- Confirm availability: "Available for full relocation to Germany in 2026"
- Note: "EU Blue Card eligible"
- Offer a clear next step: "I would welcome the chance to discuss how my hospitality-operations background can support [Company]'s [specific goal from JD]."
- Sign-off matched to language (EN: "Best regards," / DE: "Mit freundlichen Grüßen," / FR: "Cordialement,")

## Language detection rules

| Signal | Language |
|--------|----------|
| Report header `Language:` field is set | use it |
| JD body contains >40% German tokens (über, wir, Stelle, Bewerbung, Praktikum, Werkstudent, Anschreiben) | DE |
| JD body contains >40% French tokens (nous, postuler, candidature, alternance, stage) | FR |
| Default | EN |

If language = DE → use `modes/de/_shared.md` vocabulary and address as "Sehr geehrte Damen und Herren," unless a contact name is in Block G.

## Strict rules

- **No invented numbers.** Only metrics from `cv.md` or `profile.yml` are allowed.
- **No "Dear Hiring Manager" boilerplate** if a real recruiter name appears in Block G — use it.
- **No claims of skills not in cv.md.** If the JD asks for SQL and the CV has none, frame around "I learn fast and have used analytical tools (Excel pivot, n8n automation)" — don't lie.
- **No "I am passionate about..." anywhere.**
- **One sentence per idea.** Cut anything that doesn't earn its place.
- **Word count enforced.** If draft is <350, expand §2 and §3. If >450, trim §1 first.

## Quality gates before saving

1. Company name appears at least 2 times (once in §1, once in §4 close)
2. At least 2 quantified proof points in §3
3. Blue Card / 2026 relocation mentioned in §4
4. Word count in [350, 450]
5. Salutation language matches LANGUAGE metadata
6. No first-person filler ("I think", "I believe", "I feel")

If any gate fails → revise before saving.

## Example skeleton (English, OTA Operations role)

```
Dear [Recruiter or Hiring Team],

{Specific hook tying [Company]'s recent move (e.g., expansion into vacation-rental supply, new partner-portal launch) to the role.}

My background sits exactly at the intersection of operations and hospitality technology. As Head of Customer Operations at iPro Booking, I run B2B2C booking workflows across Algeria and Tunisia — exactly the kind of partner-and-customer interface the [Role Title] description outlines: {1–2 JD responsibilities verbatim}. {Connection to finance background.}

Two outcomes from that work map directly to what [Company] needs: I recovered €1.6M in B2B receivables across 100+ tourism partners through structured follow-up and negotiation, and converted 345 verified bookings from 1,271 leads (€205K total value) by tightening lead qualification and OTA workflow. Alongside this I founded SafiNest, a pre-MVP hospitality platform, which gives me first-hand product instincts for the supply side of OTAs.

I am EU Blue Card eligible and available for full relocation to Germany in 2026. I would welcome the chance to discuss how this operational track can support [Company]'s {specific JD goal}.

Best regards,
AIMENE DJEBAILI
Aym.djebaili@gmail.com
```
