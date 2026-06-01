/**
 * Service pitch recommender for Troika Tech.
 *
 * Pure rule engine — given a lead's collected signals, returns the top N
 * Troika services to pitch with confidence (0-100) and the reasons why.
 *
 * Services:
 *   - website-redesign        — site is stale or technically outdated
 *   - ai-chat                 — no chat widget on a contact-heavy site
 *   - whatsapp-automation     — phone listed but no WhatsApp link
 *   - performance-marketing   — active campaigns + popups → can scale lead gen
 *   - crm-automation          — multiple intent signals or forms → leads need a system
 *
 * Returns: [{ service, displayName, confidence, reasons[] }]
 */

const SERVICE_META = {
    'website-redesign':       { displayName: 'Website Redesign',          icon: '🎨' },
    'ai-chat':                { displayName: 'AI Voice / Chat Agent',     icon: '🤖' },
    'whatsapp-automation':    { displayName: 'WhatsApp Automation',       icon: '💬' },
    'performance-marketing':  { displayName: 'Performance Marketing',     icon: '📈' },
    'crm-automation':         { displayName: 'CRM / Process Automation',  icon: '⚙️' },
};

const HIGH_INTENT = new Set([
    'admissions_open', 'hiring_now', 'booking_open', 'enrollment_open',
    'registration_open', 'applications_open', 'new_batch',
]);

export function recommendServices({
    freshnessYears = null,
    freshnessScore = 0,
    signals = [],
    mapsPhone = '',
    popupDetected = false,
    tech = {},
    leadScore = 0,
} = {}, { topN = 3, minConfidence = 50 } = {}) {
    const sigSet = new Set(signals || []);
    const highIntentHits = [...sigSet].filter((s) => HIGH_INTENT.has(s));
    const hasHighIntent = highIntentHits.length > 0;

    const candidates = [];

    // ── Website Redesign ──
    {
        let confidence = 0;
        const reasons = [];
        if (freshnessScore <= -3) {
            confidence += 50;
            reasons.push(`Site stale ~${freshnessYears}y (no updates)`);
        } else if (freshnessScore < 0) {
            confidence += 25;
            reasons.push(`Last updated ~${freshnessYears}y ago`);
        }
        if (tech.hasMobileViewport === false) {
            confidence += 30;
            reasons.push('No mobile viewport meta tag');
        }
        if (tech.jqueryVersion && /^1\./.test(tech.jqueryVersion)) {
            confidence += 20;
            reasons.push(`Old jQuery ${tech.jqueryVersion}`);
        }
        if (tech.cmsHints?.some((h) => /wordpress\s*[1-4]\.|drupal\s*[5-7]/i.test(h))) {
            confidence += 15;
            reasons.push('Outdated CMS detected');
        }
        if (confidence > 0) candidates.push({ service: 'website-redesign', confidence, reasons });
    }

    // ── AI Chat / Voice Agent ──
    {
        let confidence = 0;
        const reasons = [];
        if (tech.hasChatWidget === false) {
            confidence += 35;
            reasons.push('No chat widget on site');
            if (sigSet.has('contact_cta')) {
                confidence += 20;
                reasons.push('Page pushes "contact us" CTA');
            }
            if (hasHighIntent) {
                confidence += 25;
                reasons.push(`Active campaigns (${highIntentHits.slice(0, 2).join(', ')}) → high inquiry volume`);
            }
            if (tech.formCount >= 2) {
                confidence += 15;
                reasons.push(`${tech.formCount} contact forms — chat would convert faster`);
            }
        }
        if (confidence > 0) candidates.push({ service: 'ai-chat', confidence, reasons });
    }

    // ── WhatsApp Automation ──
    {
        let confidence = 0;
        const reasons = [];
        const hasPhone = !!(mapsPhone && mapsPhone.trim());
        if (hasPhone && tech.hasWhatsAppLink === false) {
            confidence += 50;
            reasons.push('Phone listed but no WhatsApp link');
            if (hasHighIntent) {
                confidence += 25;
                reasons.push('Active intent signals → instant WhatsApp would lift conversions');
            }
            if (sigSet.has('contact_cta') || sigSet.has('open_house')) {
                confidence += 15;
                reasons.push('Contact-heavy site, perfect for WA automation');
            }
        }
        if (confidence > 0) candidates.push({ service: 'whatsapp-automation', confidence, reasons });
    }

    // ── Performance Marketing / Lead Gen ──
    {
        let confidence = 0;
        const reasons = [];
        if (hasHighIntent && popupDetected) {
            confidence += 60;
            reasons.push(`Already running campaigns: ${highIntentHits.slice(0, 2).join(', ')}`);
            reasons.push('Popup/banner active → ad spend can be optimized');
        } else if (hasHighIntent) {
            confidence += 35;
            reasons.push(`Intent: ${highIntentHits.slice(0, 2).join(', ')} — but no campaign visibility`);
        }
        if (leadScore >= 5 && hasHighIntent) {
            confidence += 15;
            reasons.push(`Strong lead score (${leadScore}) — primed for paid scaling`);
        }
        if (sigSet.has('limited_seats') || sigSet.has('special_offer')) {
            confidence += 10;
            reasons.push('Urgency offers — perfect for retargeting funnel');
        }
        if (confidence > 0) candidates.push({ service: 'performance-marketing', confidence, reasons });
    }

    // ── CRM / Process Automation ──
    {
        let confidence = 0;
        const reasons = [];
        const intentCount = highIntentHits.length;
        if (intentCount >= 2) {
            confidence += 40;
            reasons.push(`${intentCount} intent signals → lots of inbound leads`);
        }
        if (tech.formCount >= 2) {
            confidence += 25;
            reasons.push(`${tech.formCount} forms — leads scattered across channels`);
        }
        if (sigSet.has('vacancies') || sigSet.has('hiring_now')) {
            confidence += 15;
            reasons.push('Hiring pipeline → recruiter CRM fit');
        }
        if (sigSet.has('admissions_open') || sigSet.has('enrollment_open')) {
            confidence += 15;
            reasons.push('Admissions intake → student CRM fit');
        }
        if (confidence > 0) candidates.push({ service: 'crm-automation', confidence, reasons });
    }

    // Cap, sort, slice, decorate
    return candidates
        .map((c) => ({
            ...c,
            confidence: Math.min(100, c.confidence),
            displayName: SERVICE_META[c.service].displayName,
            icon: SERVICE_META[c.service].icon,
        }))
        .filter((c) => c.confidence >= minConfidence)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, topN);
}
