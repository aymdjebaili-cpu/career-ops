# Mode: contacto — LinkedIn + Email Outreach

Given a job offer (URL or report), produce two ready-to-use outreach artifacts:
1. **LinkedIn connection request** (≤300 chars)
2. **Email draft** (ready to send, candidate reviews then sends)

---

## Step 1 — Find Contact Targets

Search via WebSearch:
- Hiring manager of the team
- Assigned recruiter
- 2-3 team peers (similar role)
- Any email addresses listed in the JD or company website

Priority order for email:
1. Email found directly in the JD (`careers@`, `jobs@`, `hr@`, hiring manager personal email)
2. Email found on company website (careers page, team page)
3. Constructed guess: `firstname.lastname@{company-domain}.com` (mark as unverified)
4. Fallback: `careers@{company-domain}.com`

---

## Step 2 — Classify Contact Type

- **Recruiter** — talent acquisition, sourcing, recruiting role
- **Hiring Manager** — leads the team that's hiring
- **Peer** — similar role to the one being applied for
- **Direct email only** — JD lists email with no named contact

---

## Step 3 — LinkedIn Message (≤300 chars)

Select primary target. Adapt framing by contact type:

### Recruiter
- **Line 1 (Fit)**: Direct match criteria — role, relevant experience, location/availability
- **Line 2 (Proof)**: One data point that answers their screening question before they ask ("Led ops for 100+ travel agencies, relocating to Berlin, available immediately")
- **Line 3 (CTA)**: "Happy to share my CV if this aligns with what you're looking for"

### Hiring Manager
- **Line 1 (Hook)**: Specific challenge their team faces (extracted from JD, company blog, or news)
- **Line 2 (Proof)**: Candidate's most relevant quantifiable achievement that shows they've solved similar problems
- **Line 3 (CTA)**: "Would love to hear how your team is approaching [specific challenge]"

### Peer (referral)
- **Line 1 (Interest)**: Genuine reference to their work — blog post, talk, open source, or publication
- **Line 2 (Connection)**: Something the candidate is working on in the same space (NOT a job pitch)
- **Line 3 (CTA)**: "I've been working on similar problems at iPro Booking, would love your take on [topic]"
- **Note**: Do NOT ask for a job. The referral happens naturally if the conversation flows.

### Interviewer (pre-interview)
- **Line 1 (Research)**: Reference to something specific from their work or background
- **Line 2 (Context)**: Light connection to the candidate's experience in that area
- **Line 3 (CTA)**: "Looking forward to our conversation on [date]"

---

## Step 4 — Email Draft

Read `cv.md` for metrics. NEVER hardcode numbers — read them fresh each time.

### If a direct email was found in the JD:

```
To: {email}
Subject: Application — {Role Title} | Aimene Djebaili

Hi {First Name or "Hiring Team"},

I'm writing to apply for the {Role Title} position. In my current role as Head of Customer Operations at iPro Booking (hospitality wholesale tech, Algeria/Tunisia), I {most relevant achievement with metric from cv.md — e.g. "recovered €1.6M+ in B2B receivables across 100+ travel agencies" or "converted 345 bookings from 1,271 leads generating €205K"}.

{1 sentence connecting that experience to what this company specifically needs — extract from JD, be concrete not generic.}

I'm relocating to Berlin and available immediately after arrival. CV attached.

Happy to jump on a call at your convenience.

Best regards,
Aimene Djebaili
aym.djebaili@gmail.com | linkedin.com/in/aimene-djebaili-b064141b8
```

### If no direct email was found (cold outreach):

```
To: {best email guess — flag as unverified if constructed}
Subject: {Role Title} — Operations & Hospitality Tech | Aimene Djebaili

Hi {Name or "Hiring Team"},

I came across the {Role Title} opening at {Company} and wanted to reach out directly. {1 sentence on why this specific company — reference something concrete: their tech stack, market position, a recent announcement.}

I lead customer operations at iPro Booking, a wholesale hospitality tech company — managing OTA workflows, B2B client relations, and {most relevant metric from cv.md}. I'm relocating to Berlin and would be a local hire by the time onboarding begins.

CV attached. Happy to connect for 15 minutes.

Best,
Aimene Djebaili
aym.djebaili@gmail.com | linkedin.com/in/aimene-djebaili-b064141b8
```

### For French-language companies (France roles):

```
Objet : Candidature — {Intitulé du poste} | Aimene Djebaili

Bonjour {Prénom ou "Madame, Monsieur"},

Je me permets de vous contacter au sujet du poste {Intitulé du poste}. Actuellement Head of Customer Operations chez iPro Booking (tech hôtelière B2B, Algérie/Tunisie), j'ai {accomplissement le plus pertinent avec métrique tirée de cv.md}.

{1 phrase reliant l'expérience aux besoins spécifiques de l'entreprise.}

Je m'installe à Berlin et suis disponible rapidement. CV joint.

Cordialement,
Aimene Djebaili
aym.djebaili@gmail.com | linkedin.com/in/aimene-djebaili-b064141b8
```

### For German-language companies (Germany roles in German):

```
Betreff: Bewerbung — {Stellenbezeichnung} | Aimene Djebaili

Sehr geehrte/r {Name oder "Damen und Herren"},

ich bewerbe mich auf die Stelle {Stellenbezeichnung}. Als Head of Customer Operations bei iPro Booking (B2B-Hospitality-Tech, Algerien/Tunesien) habe ich {relevanteste Leistung mit Kennzahl aus cv.md}.

{1 Satz, der die Erfahrung mit den konkreten Anforderungen des Unternehmens verbindet.}

Ich ziehe nach Berlin und stehe kurzfristig zur Verfügung. Lebenslauf im Anhang.

Mit freundlichen Grüßen,
Aimene Djebaili
aym.djebaili@gmail.com | linkedin.com/in/aimene-djebaili-b064141b8
```

---

## Step 5 — Output

Save everything to `output/outreach-{company-slug}-{date}.md`:

```markdown
# Outreach: {Company} — {Role}

**Date:** {date}
**Contact found:** {name or "not found"}
**Email:** {email or "not found — use placeholder"}
**Email verified:** {yes / no — constructed guess / found in JD}

---

## LinkedIn Message ({char count}/300)

{message text}

---

## Email Draft

**To:** {email}
**Subject:** {subject line}

{full email body}

---

## Alternative Contacts

| Name | Role | LinkedIn | Why |
|------|------|----------|-----|
```

---

## Rules

- Max 300 characters for LinkedIn (hard limit)
- Max 150 words in email body
- No corporate-speak: no "I am passionate about", no "I would love to leverage"
- Lead with evidence and metrics, not enthusiasm
- Always mention Berlin relocation + immediate availability
- Always read metrics fresh from cv.md — NEVER hardcode numbers
- NEVER auto-send anything — candidate reviews and sends manually
- Flag any constructed/guessed email addresses clearly
- Language follows the JD: EN default, DE for German JDs, FR for French JDs
