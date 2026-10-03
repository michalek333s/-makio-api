import { Router } from 'express';
import { LIMITS } from '../config/limits.js';
import { assertMaxLen, assertImagePayload, trimHistory } from '../lib/requestValidation.js';
import { normalizeCzechPersonName } from '../lib/czechPersonName.js';
import { eventDateLabelToIso } from '../lib/eventDates.js';
import { ensureChatEventFromMessage } from '../lib/extractCalendarEventFromMessage.js';
import { ensureSoftDataFromMessage } from '../lib/extractSoftDataFromMessage.js';
import { buildNemioChatSystemPrompt } from '../prompts/buildNemioChatSystemPrompt.js';
import {
  looksLikePropertyQuestion,
  resolvePropertyQuery,
  extractPropertyQuery,
  hasConcretePropertyTarget,
} from '../lib/extractPropertyQuery.js';
import { runPropertyAnalysis } from '../services/runPropertyAnalysis.js';
import { formatPropertyBrief, mergePropertyIntoChatResponse } from '../services/propertyBrief.js';
import { handleGeopasChatMessage } from '../services/geopasChatHandler.js';
import { invokeJsonLlm, invokeTextLlm, AiTask } from '../services/llmRouter.js';
import { parseGeminiJsonText, callGeminiJson } from '../services/geminiChat.js';
import { isGeopasChatMessage } from '../lib/isGeopasChatMessage.js';
import { extractLocalityProfileFromMessage } from '../lib/extractLocalityProfileFromMessage.js';
import {
  looksLikeLocalityInfoQuery,
  extractLocalityNameFromMessage,
} from '../lib/localityInfoQuery.js';
import { handleLocalityInfoChat } from '../services/localityInfoChat.js';
import { upsertLocalityProfile } from '../services/localityProfiles.js';
import { storeAiFeedback, getMemoryAiFeedback, buildFeedbackLessonsForPrompt, loadRecentAiFeedback, approveAiFeedbackForContext } from '../services/aiFeedback.js';
import { isRadarMarketQuery } from '../lib/chatIntent.js';
import { runRadarMarketBrief } from '../services/radarMarketChat.js';
import { buildMarketContextForPrompt } from '../services/brokerMarketContext.js';
import { enrichBrokerNextSteps } from '../services/brokerNextSteps.js';
import { applyIntentHelpIfNeeded } from '../lib/intentHelp.js';
import { isGeneralExpertQuery } from '../lib/generalExpertQuery.js';
import { generateDecor8Staging } from '../services/decor8Staging.js';
import { sanitizeBrokerGreeting } from '../lib/sanitizeBrokerGreeting.js';
import { ensureUsefulChatResponse } from '../lib/sanitizeChatVoice.js';

const router = Router();

function finalizeChatPayload(payload, brokerFirstName, message = '') {
  if (!payload || typeof payload !== 'object') return payload;
  ensureUsefulChatResponse(payload, message);
  if (payload.chatResponse && brokerFirstName) {
    payload.chatResponse = sanitizeBrokerGreeting(payload.chatResponse, brokerFirstName);
  }
  return payload;
}

function buildRadarChatPayload(radar, message, activeClientName, brokerFirstName = '', currentScreen = null, history = []) {
  return finalizeChatPayload(
    enrichBrokerNextSteps(
      {
        intent: 'market_scan',
        chatResponse: radar.brief,
        radarRegion: radar.region,
        radarPropertyType: radar.propertyType,
        radarLeads: radar.leads,
        radarCacheEmpty: radar.cacheEmpty,
        radarDataSource: radar.dataSource || null,
        radarCacheAsOf: radar.cacheAsOf || null,
        radarApifyBlocked: Boolean(radar.apifyBlocked),
        nextSteps: [],
      },
      { message, activeClientName, currentScreen, history },
    ),
    brokerFirstName,
    message,
  );
}

/** Sloučí textový screenContext + strukturovaný currentScreen pro prompt. */
function mergeScreenContext(screenContext, currentScreen) {
  const base = String(screenContext || '').trim();
  if (!currentScreen || typeof currentScreen !== 'object') return base;
  const type = String(currentScreen.type || '').trim();
  if (!type) return base;
  const bits = [
    `current_screen.type=${type}`,
    currentScreen.id && `id=${currentScreen.id}`,
    currentScreen.name && `name=${currentScreen.name}`,
    currentScreen.address && `address=${currentScreen.address}`,
    currentScreen.title && `title=${currentScreen.title}`,
    currentScreen.tab && `tab=${currentScreen.tab}`,
  ].filter(Boolean);
  const structured = `Strukturovaný current_screen: ${bits.join(' · ')}`;
  if (!base) return structured.slice(0, 4000);
  if (base.includes('current_screen.type=')) return base;
  return `${base}\n${structured}`.slice(0, 4000);
}

// ─── OpenAI klient (GPT-4o pro copywriting a Vision) ─────────────────────────
async function callOpenAI(messages, model = 'gpt-4o', maxTokens = 1500, temperature = 0.85) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY není na serveru nastaven (nemio-backend/.env).');
    err.status = 503;
    throw err;
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.error?.message || j.error?.type || '';
    } catch {
      detail = '';
    }
    const err = new Error(`OpenAI API chyba: ${res.status}${detail ? ` - ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content;
}

// ─── POST /api/ai/chat ─────────────────────────────────────────────────────────
// Hlavní AI asistent — Gemini na serveru, strukturovaný JSON pro CRM
router.post('/chat', async (req, res, next) => {
  try {
    const {
      message,
      history = [],
      clientsContext = '',
      currentDate = '',
      currentTime = '',
      referenceDateIso = '',
      activeClientName = '',
      brokerFirstName = '',
      screenContext = '',
      currentScreen = null,
    } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Chybí message.' });
    }

    assertMaxLen(message, LIMITS.CHAT_MESSAGE_CHARS, 'message');
    assertMaxLen(clientsContext, LIMITS.CLIENTS_CONTEXT_CHARS, 'clientsContext');
    assertMaxLen(currentDate, 200, 'currentDate');
    assertMaxLen(currentTime, 50, 'currentTime');
    assertMaxLen(referenceDateIso, 20, 'referenceDateIso');
    assertMaxLen(activeClientName, 500, 'activeClientName');
    assertMaxLen(brokerFirstName, 100, 'brokerFirstName');
    assertMaxLen(screenContext, LIMITS.SCREEN_CONTEXT_CHARS, 'screenContext');

    const mergedScreenContext = mergeScreenContext(screenContext, currentScreen);

    const safeHistory = trimHistory(history, LIMITS.CHAT_HISTORY_MAX_ITEMS);
    for (const m of safeHistory) {
      if (m?.text != null) assertMaxLen(m.text, LIMITS.CHAT_MESSAGE_CHARS, 'history.text');
    }

    const historyBlock = safeHistory
      .map((m) => `${m.role === 'user' ? 'Makléř' : 'Makio'}: ${m.text}`)
      .join('\n');

    // ── Info o lokalitě („co víš o Lískovci“) — před Radarem, NE katastr parcely
    if (looksLikeLocalityInfoQuery(message)) {
      const municipalityName =
        extractLocalityNameFromMessage(message) ||
        message.replace(/.*(?:lokalit[eě]|obec[i]?)\s+/iu, '').trim().slice(0, 60) ||
        'lokalita';
      console.log('[Locality info chat]', municipalityName.slice(0, 60));
      const info = await handleLocalityInfoChat({
        message,
        municipalityName,
        userId: req.user?.id || null,
        brokerFirstName,
      });
      return res.json(
        finalizeChatPayload(
          enrichBrokerNextSteps(
          {
            intent: 'locality_info',
            chatResponse: info.chatResponse,
            localityProfile: info.localityProfile || null,
            municipalityName: info.municipalityName,
            nextSteps: [
              {
                label: `Analyzovat konkrétní adresu — ${info.municipalityName}`,
                actionType: 'ANALYZE_PROPERTY',
                suggestedMessage: `${info.municipalityName} 310`,
              },
            ],
          },
          { message, activeClientName, currentScreen, history: safeHistory },
          ),
          brokerFirstName,
          message,
        ),
      );
    }

    // ── Radar / trh (město, investice, follow-up „v této lokalitě“) — okamžitě z cache
    if (isRadarMarketQuery(message, safeHistory)) {
      console.log('[Radar chat]', message.slice(0, 80));
      const radar = await runRadarMarketBrief(message, { history: safeHistory });
      return res.json(buildRadarChatPayload(radar, message, activeClientName, brokerFirstName, currentScreen, safeHistory));
    }

    // ── Soft profil lokality („Lískovec je klidná vesnice“)
    const localityNote = extractLocalityProfileFromMessage(message);
    if (localityNote && !isGeopasChatMessage(message) && !isRadarMarketQuery(message, safeHistory)) {
      const userId = req.user?.id || null;
      let saved = null;
      if (userId) {
        try {
          saved = await upsertLocalityProfile({
            userId,
            ...localityNote,
            source: 'broker',
          });
        } catch (e) {
          console.warn('[locality chat]', e.message);
        }
      }
      void storeAiFeedback({
        userId,
        input: message,
        aiOutput: `locality:${localityNote.placeKey}:${localityNote.vibe}`,
        correctedOutput: localityNote.notes || null,
        feedbackType: 'locality',
        meta: { placeKey: localityNote.placeKey, vibe: localityNote.vibe, source: 'chat_extract' },
      }).catch(() => {});
      const vibeLabel =
        localityNote.vibe === 'klidna_vesnice'
          ? 'klidná vesnice'
          : localityNote.vibe?.replace(/_/g, ' ') || 'lokalita';
      return res.json(
        enrichBrokerNextSteps(
          {
            intent: 'locality_profile',
            chatResponse: userId
              ? `Jasně — u **${localityNote.municipalityName}** si pamatuju profil **${vibeLabel}**. Příště u analýzy nemovitosti to uvidíš v reportu (hluk / vibe), ne jen Safety Score z POI.${
                  saved?.persisted === false
                    ? '\n\n_(Uloženo zatím v paměti serveru — spusť migraci `0029_locality_profiles.sql` pro trvalé uložení.)_'
                    : ''
                }`
              : `Beru **${localityNote.municipalityName}** jako **${vibeLabel}**. Až budeš přihlášený, uložím to trvale k lokalitě.`,
            localityProfile: saved || localityNote,
            nextSteps: [
              {
                label: `Analyzovat adresu v ${localityNote.municipalityName}`,
                actionType: 'ANALYZE_PROPERTY',
                suggestedMessage: `${localityNote.municipalityName}`,
              },
            ],
          },
          { message, activeClientName, currentScreen, history: safeHistory },
        ),
      );
    }

    // ── GeoPas v chatu (pipeline = levné | claude agent = drahé, viz GEOPAS_CHAT_MODE)
    if (isGeopasChatMessage(message) && process.env.GEOPAS_API_KEY) {
      console.log('[GeoPas chat]', message.slice(0, 80));
      const geopas = await handleGeopasChatMessage({
        message,
        historyBlock,
        activeClientName,
        brokerFirstName,
      });

      const propertyQuery = geopas.propertyQuery || extractPropertyQuery(message);
      const payload = {
        intent: 'property_analysis',
        chatResponse: geopas.chatResponse,
        geopasAgent: geopas.geopasMode === 'claude_agent',
        geopasMode: geopas.geopasMode,
        llmProvider: geopas.llmProvider,
        toolsUsed: geopas.toolsUsed,
        nextSteps: [],
      };

      if (geopas.propertyAnalysis) {
        payload.propertyAnalysis = geopas.propertyAnalysis;
      } else if (propertyQuery) {
        try {
          payload.propertyAnalysis = await runPropertyAnalysis(propertyQuery);
        } catch (e) {
          console.warn('[GeoPas chat] full analysis:', e.message);
        }
      }

      if (propertyQuery) {
        payload.propertyQuery = propertyQuery;
        payload.nextSteps.push({
          label: 'Otevřít detailní analýzu (graf, safety score)',
          actionType: 'ANALYZE_PROPERTY',
          suggestedMessage: propertyQuery,
        });
      } else {
        payload.nextSteps.push({
          label: 'Zkusit detailní analýzu v modalu',
          actionType: 'ANALYZE_PROPERTY',
          suggestedMessage: message,
        });
      }

      return res.json(
        finalizeChatPayload(
          enrichBrokerNextSteps(payload, { message, activeClientName, currentScreen, history: safeHistory }),
          brokerFirstName,
          message,
        ),
      );
    }

    const marketContext = await buildMarketContextForPrompt();
    const feedbackLessons = await buildFeedbackLessonsForPrompt({
      limit: 10,
    });
    const systemPrompt = await buildNemioChatSystemPrompt({
      currentDate,
      currentTime,
      referenceDateIso: referenceDateIso || '',
      clientsContext,
      historyBlock,
      activeClientName,
      brokerFirstName,
      marketContext,
      screenContext: mergedScreenContext,
      feedbackLessons,
    });

    const responseSchema = {
      type: 'OBJECT',
      properties: {
        intent: { type: 'STRING' },
        chatResponse: { type: 'STRING' },
        propertyQuery: { type: 'STRING' },
        targetClientName: { type: 'STRING' },
        isNewClient: { type: 'BOOLEAN' },
        addressTypeDetected: { type: 'STRING' },
        addressClarificationNeeded: { type: 'BOOLEAN' },
        client: {
          type: 'OBJECT',
          properties: {
            firstName: { type: 'STRING' },
            lastName: { type: 'STRING' },
            type: { type: 'STRING' },
            priority: { type: 'STRING' },
            interest: { type: 'STRING' },
            address: { type: 'STRING' },
            address_home: { type: 'STRING' },
            address_property_sell: { type: 'STRING' },
            address_property_buy: { type: 'STRING' },
            rc: { type: 'STRING' },
            idCard: { type: 'STRING' },
          },
        },
        updateFields: {
          type: 'OBJECT',
          properties: {
            phone: { type: 'STRING' },
            email: { type: 'STRING' },
            address: { type: 'STRING' },
            address_home: { type: 'STRING' },
            address_property_sell: { type: 'STRING' },
            address_property_buy: { type: 'STRING' },
            interest: { type: 'STRING' },
            budget: { type: 'STRING' },
            rc: { type: 'STRING' },
            idCard: { type: 'STRING' },
            context: { type: 'STRING' },
            softData: {
              type: 'ARRAY',
              items: { type: 'STRING' },
            },
          },
        },
        softData: {
          type: 'ARRAY',
          items: { type: 'STRING' },
        },
        event: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' },
            type: { type: 'STRING' },
            date: { type: 'STRING' },
            dateIso: { type: 'STRING' },
            time: { type: 'STRING' },
            location: { type: 'STRING' },
            meetingUrl: { type: 'STRING' },
          },
        },
        nextSteps: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              label: { type: 'STRING' },
              actionType: { type: 'STRING' },
              suggestedMessage: { type: 'STRING' },
            },
          },
        },
      },
    };

    const { raw: rawResponse, provider: chatLlmProvider } = await invokeJsonLlm({
      task: AiTask.CHAT_CRM,
      systemPrompt,
      userMessage: message,
      responseSchema,
    });

    let parsed;
    try {
      parsed = parseGeminiJsonText(rawResponse);
    } catch (e) {
      console.error('[ai/chat] JSON parse:', e.message, 'len=', String(rawResponse || '').length);
      return res.status(502).json({
        error:
          'AI vrátila nečitelnou odpověď. Zkuste zprávu znovu — kratší diktát obvykle pomůže.',
        code: 'AI_JSON_PARSE',
      });
    }
    parsed._llmProvider = chatLlmProvider;

    if (isGeneralExpertQuery(message)) {
      parsed.intent = 'general_chat';
      parsed.propertyQuery = '';
      delete parsed.propertyAnalysis;
    }

    // Normalizace softData (top-level + updateFields)
    const softNorm = (raw) =>
      (Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw] : [])
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .slice(0, 8);
    const softMerged = [
      ...softNorm(parsed.softData),
      ...softNorm(parsed.updateFields?.softData),
    ];
    if (softMerged.length) {
      const seen = new Set();
      const unique = [];
      for (const s of softMerged) {
        const k = s.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        unique.push(s.slice(0, 120));
      }
      parsed.softData = unique;
      parsed.updateFields = { ...(parsed.updateFields || {}), softData: unique };
    }

    if (parsed.targetClientName) {
      parsed.targetClientName = normalizeCzechPersonName(parsed.targetClientName);
    }
    if (parsed.client && typeof parsed.client === 'object') {
      if (parsed.client.firstName) {
        parsed.client.firstName = normalizeCzechPersonName(parsed.client.firstName);
      }
      if (parsed.client.lastName) {
        parsed.client.lastName = normalizeCzechPersonName(parsed.client.lastName);
      }
    }

    if (parsed.event && typeof parsed.event === 'object' && parsed.event.title) {
      const refIso = String(referenceDateIso || '').trim();
      const refDate =
        refIso && /^\d{4}-\d{2}-\d{2}$/.test(refIso)
          ? new Date(`${refIso}T12:00:00`)
          : new Date();
      const di = parsed.event.dateIso;
      if (!di || !/^\d{4}-\d{2}-\d{2}$/.test(String(di).trim())) {
        parsed.event.dateIso = eventDateLabelToIso(parsed.event.date || 'Brzy', refDate);
      } else {
        parsed.event.dateIso = String(di).trim();
      }
    }

    // Heuristika: LLM často vynechá event.title u „Naplánuj zítra hovor…“
    {
      const refIso = String(referenceDateIso || '').trim();
      const refDate =
        refIso && /^\d{4}-\d{2}-\d{2}$/.test(refIso)
          ? new Date(`${refIso}T12:00:00`)
          : new Date();
      ensureChatEventFromMessage(
        parsed,
        message,
        refDate,
        Array.isArray(req.body?.clients) ? req.body.clients : [],
      );
      ensureSoftDataFromMessage(parsed, message);
    }

    if (!parsed.chatResponse?.trim() || /zpracov[aá]no\.?\s*potřebujete/i.test(parsed.chatResponse)) {
      if (isRadarMarketQuery(message, safeHistory)) {
        console.log('[Radar chat] fallback po Gemini:', message.slice(0, 80));
        const radar = await runRadarMarketBrief(message, { history: safeHistory });
        return res.json(buildRadarChatPayload(radar, message, activeClientName, brokerFirstName, currentScreen, safeHistory));
      }
    }

    // Generická clarifikace / omluva / prázdná odpověď → odhad záměru + konkrétní kroky
    applyIntentHelpIfNeeded(parsed, message, { activeClientName, history: safeHistory });

    if (!parsed.chatResponse?.trim()) {
      if (/cen[auy]|nabídkov|strategi|hypoték|ltv|výnos|yield/i.test(message)) {
        parsed.chatResponse =
          'Z praxe: **nabídková cena** bývá o **5–12 %** nad očekávanou realizační. ' +
          'U **3+kk** nejdřív srovnejte Kč/m² v lokalitě (Radar / portály), pak nastavte cenu podle cíle ' +
          '(rychlý prodej vs. maximální výnos). Chcete, abych prošel aktuální nabídky v konkrétním městě?';
        parsed.intent = parsed.intent || 'general_chat';
      } else {
        parsed.intent = 'clarification_needed';
        applyIntentHelpIfNeeded(parsed, message, { activeClientName, history: safeHistory });
      }
    }

    const wantsProperty =
      !isGeneralExpertQuery(message) &&
      !isRadarMarketQuery(message, safeHistory) &&
      !looksLikeLocalityInfoQuery(message) &&
      hasConcretePropertyTarget(message, parsed);

    if (wantsProperty && process.env.GEOPAS_API_KEY) {
      const propertyQuery = resolvePropertyQuery(message, parsed);
      if (propertyQuery) {
        try {
          console.log(`[GeoPas+Chat] ${propertyQuery}`);
          const analysis = await runPropertyAnalysis(propertyQuery);
          const brief = formatPropertyBrief(analysis);
          parsed.propertyAnalysis = analysis;
          parsed.propertyQuery = propertyQuery;
          parsed.chatResponse = mergePropertyIntoChatResponse(parsed.chatResponse, brief);
          if (!parsed.nextSteps?.length) {
            parsed.nextSteps = [];
          }
          const hasAnalyze = parsed.nextSteps.some((s) =>
            /ANALYZE|KATASTR/i.test(s.actionType || ''),
          );
          if (!hasAnalyze) {
            parsed.nextSteps.unshift({
              label: 'Otevřít detailní analýzu (katastr, rizika, ceny)',
              actionType: 'ANALYZE_PROPERTY',
              suggestedMessage: propertyQuery,
            });
          }
        } catch (geoErr) {
          console.warn('[GeoPas+Chat]', geoErr.message);
          parsed.propertyAnalysisError = geoErr.message;
          parsed.chatResponse = mergePropertyIntoChatResponse(parsed.chatResponse, '', {
            error: geoErr.message,
          });
        }
      } else if (looksLikePropertyQuestion(message)) {
        parsed.chatResponse =
          `${parsed.chatResponse}\n\nUpřesněte prosím **adresu** (obec + číslo popisné, např. \`Lískovec 537\`) nebo **parcelu** (např. \`2201/1 Vinohrady\`).`.trim();
        parsed.addressClarificationNeeded = true;
      }
    } else if (wantsProperty && !process.env.GEOPAS_API_KEY) {
      parsed.chatResponse = `${parsed.chatResponse}\n\n⚠️ GeoPas není nakonfigurován — doplňte GEOPAS_API_KEY v nemio-backend/.env.`.trim();
    }

    res.json(
      finalizeChatPayload(
        enrichBrokerNextSteps(parsed, { message, activeClientName, currentScreen, history: safeHistory }),
        brokerFirstName,
        message,
      ),
    );
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/ai/sms-draft ─────────────────────────────────────────────────────
// Lidská personalizovaná SMS / WhatsApp — jádro clientComms
router.post('/sms-draft', async (req, res, next) => {
  try {
    const { client, purpose = '', brokerFirstName = '', channel = 'sms', dealStage = '' } = req.body;
    if (!client || typeof client !== 'object') {
      return res.status(400).json({ error: 'Chybí client (objekt).' });
    }

    assertMaxLen(JSON.stringify(client), 16_000, 'client');
    assertMaxLen(String(purpose || ''), 500, 'purpose');
    assertMaxLen(String(brokerFirstName || ''), 80, 'brokerFirstName');

    const { buildClientMessageSystemPrompt, sanitizeClientMessageOutput } = await import(
      '../services/clientComms.js'
    );

    const ch = ['sms', 'whatsapp'].includes(String(channel)) ? String(channel) : 'sms';
    const systemPrompt = buildClientMessageSystemPrompt({
      channel: ch,
      client,
      purpose,
      brokerFirstName,
      dealStage,
    });

    const { text: raw } = await invokeTextLlm({
      task: AiTask.SMS,
      systemPrompt,
      userMessage:
        'Napiš hotovou zprávu klientovi. Lidsky, konkrétně, s jedním next stepem. Žádný robotický úvod.',
    });

    const message = sanitizeClientMessageOutput(raw, { channel: ch });

    if (!message) {
      return res.status(500).json({ error: 'AI nevrátila text SMS.' });
    }

    res.json({ message, channel: ch });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/ai/email-draft ───────────────────────────────────────────────────
// Lidský e-mail klientovi (předmět + tělo)
router.post('/email-draft', async (req, res, next) => {
  try {
    const { client, purpose = '', brokerFirstName = '', dealStage = '' } = req.body;
    if (!client || typeof client !== 'object') {
      return res.status(400).json({ error: 'Chybí client (objekt).' });
    }

    assertMaxLen(JSON.stringify(client), 16_000, 'client');
    assertMaxLen(String(purpose || ''), 500, 'purpose');
    assertMaxLen(String(brokerFirstName || ''), 80, 'brokerFirstName');

    const { buildClientMessageSystemPrompt, sanitizeClientMessageOutput } = await import(
      '../services/clientComms.js'
    );

    const systemPrompt = buildClientMessageSystemPrompt({
      channel: 'email',
      client,
      purpose: purpose || 'follow-up e-mailem',
      brokerFirstName,
      dealStage,
    });

    const { text: raw } = await invokeTextLlm({
      task: AiTask.SMS,
      systemPrompt,
      userMessage:
        'Napiš e-mail klientovi ve formátu SUBJECT: … a BODY: …. Lidsky, bez korporátních frází.',
    });

    const full = sanitizeClientMessageOutput(raw, { channel: 'email' });
    if (!full) {
      return res.status(500).json({ error: 'AI nevrátila text e-mailu.' });
    }

    let subject = '';
    let body = full;
    const subjMatch = full.match(/^\s*SUBJECT:\s*(.+)$/im);
    const bodyMatch = full.match(/\bBODY:\s*([\s\S]*)$/i);
    if (subjMatch) subject = subjMatch[1].trim();
    if (bodyMatch) body = bodyMatch[1].trim();
    if (!subject) {
      const firstLine = full.split(/\n/).map((l) => l.trim()).find(Boolean) || '';
      subject = firstLine.slice(0, 60);
      body = full;
    }

    res.json({
      subject: subject.slice(0, 120),
      body,
      message: body,
      channel: 'email',
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/ai/polish-crm-text ───────────────────────────────────────────────
// Hrubá poznámka makléře → jedna profesionální věta (diakritika, názvy míst)
router.post('/polish-crm-text', async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) {
      return res.status(400).json({ error: 'Chybí text.' });
    }
    assertMaxLen(text, 4000, 'text');

    const systemPrompt = `
Jsi asistent pro realitní CRM v češtině. Makléř zadal hrubou poznámku o záměru nebo poptávce klienta (často z rychlého zápisu).

Přepiš ji do jedné věty nebo krátkého souvětí, které:
- začíná vhodně (např. „Klient hledá…", „Klient nabízí…", „Zájemce poptává…") podle kontextu
- má správnou českou diakritiku a velká písmena u geografických názvů (např. Frýdek-Místek místo „fm" nebo „frýdku-místku" bez diakritiky)
- zachovává význam, čísla (3+kk), rozpočet a zkratky
- je profesionální, vhodné do CRM

Vrať POUZE přepsaný text. Žádné uvozovky kolem, žádný markdown, žádný komentář.
    `.trim();

    const userMessage = `Poznámka makléře:\n${text.trim()}`;

    const { text: raw } = await invokeTextLlm({
      task: AiTask.POLISH,
      systemPrompt,
      userMessage,
    });

    const polished = String(raw || '')
      .replace(/^```[\s\S]*?\n?/i, '')
      .replace(/\n?```$/i, '')
      .replace(/^["']|["']$/g, '')
      .trim();

    if (!polished) {
      return res.status(500).json({ error: 'AI nevrátila upravený text.' });
    }

    res.json({ polished });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/ai/listing ──────────────────────────────────────────────────────
// Texty pro inzerát — primárně GPT-4o, při 429 fallback na Gemini
router.post('/listing', async (req, res, next) => {
  try {
    const { propertyInfo, vibe, targetBuyer } = req.body;

    if (!propertyInfo?.trim()) {
      return res.status(400).json({ error: 'Chybí propertyInfo.' });
    }
    assertMaxLen(propertyInfo, LIMITS.LISTING_PROPERTY_CHARS, 'propertyInfo');
    assertMaxLen(vibe ?? '', 2000, 'vibe');
    assertMaxLen(targetBuyer ?? '', 2000, 'targetBuyer');

    const prompt = `
Jsi elitní realitní copywriter a mistr empatie. Píšeš texty které se dotýkají srdce, 
ne jen uvádějí fakta. Tvým cílem je, aby si čtenář dokázal představit svůj život v té nemovitosti.

NEMOVITOST: ${propertyInfo}
ATMOSFÉRA A CÍLOVKA: ${vibe}
IDEÁLNÍ KUPEC: ${targetBuyer ?? 'urči sám na základě vibe'}

POKYNY:
- Piš v er-formě, přátelsky, s emocemi
- Začni příběhem nebo otázkou, ne parametry
- Používej smyslová slova (světlo, klid, vůně, teplo domova)
- Parametry uveď až ve druhé třetině textu, nenásilně
- Zvol si jednu silnou emoci a protkni jí celý text

Vytvoř JSON s těmito poli:
{
  "sreality_title": "titulek max 60 znaků",
  "sreality_text": "text 300-500 slov pro Sreality",
  "social_post": "post na Instagram/Facebook s emoji, max 150 slov",
  "email_draft": "osobní e-mail pro VIP databázi, 150-200 slov",
  "targetBuyerProfile": "popis ideálního kupce (2 věty)",
  "keyEmotion": "hlavní emoce celého inzerátu (1 slovo)"
}

Vrať pouze validní JSON, bez markdown backticks.
    `.trim();

    const listingSchema = {
      type: 'OBJECT',
      properties: {
        sreality_title: { type: 'STRING' },
        sreality_text: { type: 'STRING' },
        social_post: { type: 'STRING' },
        email_draft: { type: 'STRING' },
        targetBuyerProfile: { type: 'STRING' },
        keyEmotion: { type: 'STRING' },
      },
      required: [
        'sreality_title',
        'sreality_text',
        'social_post',
        'email_draft',
        'targetBuyerProfile',
        'keyEmotion',
      ],
    };

    let raw;
    const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
    const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
    if (!hasOpenAI && !hasGemini) {
      return res.status(503).json({
        error: 'Chybí OPENAI_API_KEY i GEMINI_API_KEY v nemio-backend/.env — copywriter nelze spustit.',
      });
    }

    try {
      if (hasOpenAI) {
        raw = await callOpenAI([{ role: 'user', content: prompt }], 'gpt-4o', 2000);
      } else {
        raw = await callGeminiJson(
          'Jsi elitní realitní copywriter. Vrať pouze validní JSON bez markdownu.',
          prompt,
          listingSchema,
        );
      }
    } catch (err) {
      // OpenAI kvóta/rate limit nebo výpadek: fallback na Gemini
      if (hasGemini && (Number(err?.status) === 429 || Number(err?.status) === 503 || hasOpenAI)) {
        try {
          raw = await callGeminiJson(
            'Jsi elitní realitní copywriter. Vrať pouze validní JSON bez markdownu.',
            prompt,
            listingSchema,
          );
        } catch (gErr) {
          throw gErr;
        }
      } else {
        throw err;
      }
    }

    let parsed;
    try {
      const cleaned = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'AI vrátila neplatný formát. Zkuste to znovu.' });
    }

    res.json(parsed);

  } catch (error) {
    next(error);
  }
});

// ─── POST /api/ai/staging ─────────────────────────────────────────────────────
// Analýza fotky nemovitosti — GPT-4o Vision
router.post('/staging', async (req, res, next) => {
  try {
    const { imageBase64, mimeType = 'image/jpeg' } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Chybí imageBase64.' });
    }
    assertImagePayload(imageBase64, mimeType);

    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
          {
            type: 'text',
            text: `Jsi expert na home staging a realitní fotografii. Analyzuj tuto fotku nemovitosti.

Vrať JSON:
{
  "overallImpression": "první dojem z fotky (1-2 věty)",
  "score": číslo 1-10 (tržní atraktivita fotky),
  "strengths": ["silná stránka 1", "silná stránka 2"],
  "improvements": [
    {"priority": "high/medium/low", "action": "co změnit", "impact": "proč to pomůže prodeji"}
  ],
  "stagingTips": ["konkrétní tip 1", "konkrétní tip 2", "konkrétní tip 3"],
  "estimatedPriceImpact": "odhad dopadu na cenu po stagingu (např. +5-8 %)",
  "photographyTips": ["tip na lepší fotku 1", "tip 2"]
}

Buď konkrétní a praktický. Vrať pouze validní JSON.`,
          },
        ],
      },
    ];

    const raw = await callOpenAI(messages, 'gpt-4o', 1200);
    let parsed;
    try {
      const cleaned = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'AI vrátila neplatný formát analýzy fotky. Zkuste to znovu.' });
    }
    res.json(parsed);

  } catch (error) {
    next(error);
  }
});

// ─── POST /api/ai/staging-detailed ──────────────────────────────────────────────
// Rozšířená analýza místnosti (Vision) — JSON na míru pro UI; klíč jen na serveru
router.post('/staging-detailed', async (req, res, next) => {
  try {
    const {
      imageBase64,
      mimeType = 'image/jpeg',
      priceRange = 'střední',
      sellerGoal = 'vyvážený',
    } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Chybí imageBase64.' });
    }
    assertImagePayload(imageBase64, mimeType);
    assertMaxLen(String(priceRange), 40, 'priceRange');
    assertMaxLen(String(sellerGoal), 40, 'sellerGoal');

    const priceContexts = {
      nízký: 'do 3M Kč — kupující jsou citliví na každou korunu, doporučuj levná řešení',
      střední: '3–8M Kč — prostor pro rozumné investice do stagingu s jasným ROI',
      vysoký: 'nad 8M Kč — staging musí odpovídat prémiové ceně',
    };
    const goalContexts = {
      maximální_cena: 'Cíl je co nejvyšší prodejní cena.',
      rychlý_prodej: 'Cíl je prodat do 30 dnů — jen úpravy s okamžitým efektem.',
      vyvážený: 'Vyvážený přístup — náklady vs. ROI a doba prodeje.',
    };

    const priceCtx = priceContexts[priceRange] || priceContexts.střední;
    const goalCtx = goalContexts[sellerGoal] || goalContexts.vyvážený;

    const textPrompt = `
Jsi expert na home staging na českém realitním trhu. Nikdy nepiš „jako expert“ ani velkolepé úvody — rovnou k věci.

KONTEXT PRODEJE:
- Cenový segment: ${priceCtx}
- Cíl: ${goalCtx}

ÚKOL: Z fotky odhadni typ místnosti a cílovou skupinu kupců. Doporučení přizpůsob segmentu a cíli.

PRAVIDLA:
1. Buď konkrétní (např. produkt + orientační cena v Kč z českých prodejen).
2. ROI realisticky pro ČR (typicky 2–5 %).
3. Prioritizuj must_do / should_do / nice_to_have.
4. NIKDY nenavrhuj bourání zdí ani velké stavební úpravy.
5. Vrať POUZE validní JSON (žádný markdown, žádný text před/po).

Schéma JSON:
{
  "overallScore": 1-10,
  "overallImpression": "string",
  "targetBuyerFit": "string",
  "strengths": [{ "point": "string", "whyItMatters": "string" }],
  "improvements": [{
    "priority": "must_do|should_do|nice_to_have",
    "title": "string",
    "problem": "string",
    "solution": "string",
    "products": ["string"],
    "estimatedCost": "string",
    "estimatedImpact": "string",
    "timeToImplement": "string"
  }],
  "priorities": { "must_do": "string", "should_do": "string", "nice_to_have": "string" },
  "photographyTips": ["string"],
  "totalCostEstimate": { "minimum": "string", "recommended": "string", "maximum": "string" },
  "roiEstimate": {
    "propertyValueIncrease": "string",
    "estimatedValueGain": "string",
    "timeToSellImpact": "string",
    "verdict": "string"
  },
  "sellerPitch": "string"
}
`.trim();

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: 'text', text: textPrompt },
        ],
      },
    ];

    const raw = await callOpenAI(messages, 'gpt-4o', 4096, 0.35);
    const cleaned = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'AI vrátila neplatný JSON. Zkuste jinou fotku nebo znovu.' });
    }

    res.json(parsed);
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/ai/valuation-strategy ──────────────────────────────────────────
// AI navrhne cenovou strategii na základě analýzy nemovitosti
router.post('/valuation-strategy', async (req, res, next) => {
  try {
    const { propertyAnalysis, sellerGoal } = req.body;
    // sellerGoal: 'maximum' | 'fast' | 'balanced'

    const paJson = JSON.stringify(propertyAnalysis ?? {});
    assertMaxLen(paJson, 120_000, 'propertyAnalysis');
    assertMaxLen(sellerGoal ?? '', 100, 'sellerGoal');

    const prompt = `
Jsi zkušený realitní stratég s 20 lety praxe. Na základě těchto dat navrhni cenovou strategii.

DATA NEMOVITOSTI: ${JSON.stringify(propertyAnalysis ?? {}, null, 2)}
CÍL PRODÁVAJÍCÍHO: ${sellerGoal ?? 'balanced'}

Navrhni konkrétní strategii pro každý scénář:
- Maximální cena (jak dlouho na trhu, jak komunikovat)
- Rychlý prodej (jaká sleva, jak prezentovat)
- Vyvážený přístup (zlatá střední cesta)

Vrať JSON:
{
  "recommendedStrategy": "maximum|fast|balanced",
  "reasoning": "proč tento přístup doporučuješ (2-3 věty)",
  "scenarios": {
    "maximum": {"price": "...", "timeframe": "...", "approach": "..."},
    "fast": {"price": "...", "timeframe": "...", "approach": "..."},
    "balanced": {"price": "...", "timeframe": "...", "approach": "..."}
  },
  "nextSteps": ["krok 1", "krok 2", "krok 3"],
  "redFlags": ["riziko 1 (pokud existuje)"]
}
    `.trim();

    const raw = await callOpenAI([{ role: 'user', content: prompt }], 'gpt-4o', 1500);
    const cleaned = raw.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
    res.json(JSON.parse(cleaned));

  } catch (error) {
    next(error);
  }
});

// ─── POST /api/ai/decor8-staging ─────────────────────────────────────────────
// Virtuální staging přes Decor8 AI (klíč jen na serveru).
router.post('/decor8-staging', async (req, res, next) => {
  try {
    const {
      imageUrl,
      imageBase64,
      mimeType = 'image/jpeg',
      roomType,
      designStyle,
      prompt,
      apiPrompt,
      numImages = 2,
    } = req.body || {};

    if (!imageUrl?.trim() && !imageBase64?.trim()) {
      return res.status(400).json({ error: 'Nahrajte fotku místnosti (imageBase64 nebo imageUrl).' });
    }
    if (imageBase64) assertImagePayload(imageBase64, mimeType);

    const customPrompt = String(prompt || '').trim();
    const optimizedPrompt = String(apiPrompt || '').trim();
    if (customPrompt.length > 0 && customPrompt.length < 10 && !optimizedPrompt) {
      return res.status(400).json({ error: 'Popis místnosti napište aspoň 10 znaků, nebo zvolte předvolby.' });
    }
    if (!customPrompt && !optimizedPrompt && (!roomType || !designStyle)) {
      return res.status(400).json({ error: 'Vyberte typ místnosti a styl, nebo napište vlastní popis.' });
    }

    const result = await generateDecor8Staging({
      imageUrl,
      imageBase64,
      mimeType,
      roomType,
      designStyle,
      prompt: customPrompt || undefined,
      apiPrompt: optimizedPrompt || undefined,
      numImages,
    });

    res.json({
      urls: result.urls,
      message: result.message,
      room_type: result.room_type,
      design_style: result.design_style,
      prompt: result.prompt,
      mode: result.mode,
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/ai/feedback — oprava / hodnocení AI výstupu ─────────────────────
router.post('/feedback', async (req, res, next) => {
  try {
    const {
      input,
      aiOutput,
      correctedOutput = null,
      feedbackType = 'chat',
      rating = null,
      meta = {},
    } = req.body || {};

    assertMaxLen(input, 8000, 'input');
    assertMaxLen(aiOutput, 16000, 'aiOutput');
    if (correctedOutput) assertMaxLen(correctedOutput, 16000, 'correctedOutput');
    if (!String(input || '').trim() || !String(aiOutput || '').trim()) {
      return res.status(400).json({ error: 'input a aiOutput jsou povinné' });
    }

    const result = await storeAiFeedback({
      userId: req.user?.id || null,
      input,
      aiOutput,
      correctedOutput,
      feedbackType,
      meta: { ...meta, rating: rating ?? meta?.rating ?? null },
      // Nikdy auto-schvalovat z UI — governance mezikrok
      isApprovedForContext: false,
    });

    res.json({
      ok: true,
      ...result,
      message:
        rating === 'down' || correctedOutput
          ? 'Uloženo do backlogu. Do modelu se propíše až po schválení garantem playbooku.'
          : 'Uloženo. Pozitivní příklady jdou do kontextu až po governance schválení.',
    });
  } catch (error) {
    next(error);
  }
});

/** Pending feedback pro governance (service key nebo FEEDBACK_GOVERNANCE_SECRET). */
router.get('/feedback/pending', async (req, res, next) => {
  try {
    assertFeedbackGovernance(req);
    const items = await loadRecentAiFeedback({ limit: 40, pendingOnly: true });
    res.json({ items, count: items.length });
  } catch (error) {
    next(error);
  }
});

/** Schválení feedbacku do system promptu. */
router.post('/feedback/:id/approve', async (req, res, next) => {
  try {
    assertFeedbackGovernance(req);
    const id = String(req.params.id || '').trim();
    const approved = req.body?.approved !== false;
    const result = await approveAiFeedbackForContext({
      id,
      approved,
      approvedBy: req.user?.id || null,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

function assertFeedbackGovernance(req) {
  const secret = String(process.env.FEEDBACK_GOVERNANCE_SECRET || '').trim();
  const provided = String(req.get('x-feedback-governance-key') || req.body?.governanceKey || '').trim();
  if (secret && provided && provided === secret) return;
  // Dev bez secret: jen mimo production + AUTH_ALLOW_ANON_DEV
  if (
    process.env.NODE_ENV !== 'production' &&
    String(process.env.AUTH_ALLOW_ANON_DEV || '') === '1' &&
    !secret
  ) {
    return;
  }
  if (secret && provided !== secret) {
    const err = new Error('Neplatný governance klíč');
    err.status = 403;
    throw err;
  }
  if (!secret) {
    const err = new Error('Nastavte FEEDBACK_GOVERNANCE_SECRET pro schvalování feedbacku');
    err.status = 503;
    throw err;
  }
}

// Dev/debug: poslední feedback z paměti (bez citlivých dat klientů)
router.get('/feedback/recent', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ items: getMemoryAiFeedback(30) });
});

// ─── POST /api/ai/nurturing-triggers ───────────────────────────────────────────
// AI Smart Triggery z CRM + agendy (heuristika + Gemini obohacení)
router.post('/nurturing-triggers', async (req, res, next) => {
  try {
    const { clients = [], events = [], referenceDateIso } = req.body || {};
    const now = referenceDateIso
      ? new Date(`${String(referenceDateIso).slice(0, 10)}T12:00:00`)
      : new Date();

    const { buildLocalNurturingTriggers, enhanceNurturingWithAi } = await import(
      '../services/nurturingTriggers.js'
    );

    const local = buildLocalNurturingTriggers({
      clients: Array.isArray(clients) ? clients : [],
      events: Array.isArray(events) ? events : [],
      now,
    });

    if (local.length === 0) {
      return res.json({ triggers: [], source: 'local' });
    }

    try {
      const enhanced = await enhanceNurturingWithAi({
        clients: Array.isArray(clients) ? clients : [],
        events: Array.isArray(events) ? events : [],
        localTriggers: local,
        invokeTextLlm,
        AiTask,
      });
      return res.json({
        triggers: enhanced.length ? enhanced : local,
        source: enhanced.length > local.length ? 'ai' : 'ai_merge',
      });
    } catch {
      return res.json({ triggers: local, source: 'local' });
    }
  } catch (error) {
    next(error);
  }
});

export default router;
