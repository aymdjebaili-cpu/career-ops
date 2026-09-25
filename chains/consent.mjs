/**
 * consent.mjs — accept the cookie banner, wherever it is hiding.
 *
 * Usercentrics and its kin render inside a shadow root, so `page.locator('button:has-text
 * ("Zustimmen")')` never sees them. Aldi's apply button simply did nothing until the banner
 * was answered, and REWE's click timed out against an invisible overlay (2026-09-16).
 * This walks the main document, every shadow root and every same-origin iframe.
 */
const ACCEPT = /^(alle akzeptieren|alles akzeptieren|akzeptieren|alle cookies akzeptieren|zustimmen|einverstanden|ich stimme zu|accept all|accept|agree|verstanden|ok)$/i;

export async function acceptCookies(page, { timeout = 12000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const out = [];
      const collect = (root) => {
        if (!root) return;
        for (const el of root.querySelectorAll('button, a[role="button"], input[type="button"], [role="button"]')) {
          const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          if (t && re.test(t)) out.push(el);
        }
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot);
      };
      collect(document);
      const el = out.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || out[0];
      if (!el) return null;
      const label = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      el.click();
      return label || '(unlabelled)';
    }, ACCEPT.source).catch(() => null);

    if (clicked) { await page.waitForTimeout(2500); return clicked; }

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const hit = await frame.evaluate((src) => {
        const re = new RegExp(src, 'i');
        const el = [...document.querySelectorAll('button, a[role="button"], [role="button"]')]
          .find(e => re.test((e.innerText || '').replace(/\s+/g, ' ').trim()));
        if (!el) return null;
        el.click();
        return (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      }, ACCEPT.source).catch(() => null);
      if (hit) { await page.waitForTimeout(2500); return `${hit} (iframe)`; }
    }
    await page.waitForTimeout(1200);
  }
  return null;
}
