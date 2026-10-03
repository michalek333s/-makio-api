import { AiTask, pickLlmForTask } from '../config/aiRouting.js';
import { isClaudeBillingError, isClaudeQuotaError } from '../lib/aiErrors.js';
import { callClaudeMessages } from './claudeClient.js';
import { callGeminiJson, callGeminiText, parseGeminiJsonText } from './geminiChat.js';
import { canSpendClaude, recordClaudeSpend } from './claudeBudget.js';

/**
 * Textová odpověď (SMS, polish, GeoPas wrap).
 * @returns {{ text: string, provider: 'gemini'|'claude', fallback?: boolean }}
 */
export async function invokeTextLlm({ task, systemPrompt, userMessage, forceGemini = false }) {
  const wantClaude = !forceGemini && pickLlmForTask(task) === 'claude';

  if (wantClaude) {
    const budget = canSpendClaude(task);
    if (budget.ok) {
      try {
        const text = await callClaudeMessages(systemPrompt, userMessage, false);
        recordClaudeSpend(task);
        return { text, provider: 'claude' };
      } catch (e) {
        if (process.env.GEMINI_API_KEY && (isClaudeBillingError(e) || isClaudeQuotaError(e))) {
          console.warn(`[llm:${task}] Claude → Gemini:`, e.message);
          const text = await callGeminiText(systemPrompt, userMessage);
          return { text, provider: 'gemini', fallback: true };
        }
        throw e;
      }
    }
    console.warn(`[llm:${task}] Claude budget vyčerpán (${budget.reason}) → Gemini`);
  }

  const text = await callGeminiText(systemPrompt, userMessage);
  return { text, provider: 'gemini' };
}

/**
 * Strukturovaný JSON (CRM chat).
 * @returns {{ raw: string, provider: 'gemini'|'claude', parsed?: object, fallback?: boolean }}
 */
export async function invokeJsonLlm({ task, systemPrompt, userMessage, responseSchema }) {
  const wantClaude = pickLlmForTask(task) === 'claude';

  if (wantClaude) {
    const budget = canSpendClaude(task);
    if (budget.ok) {
      try {
        const raw = await callClaudeMessages(systemPrompt, userMessage, true);
        recordClaudeSpend(task);
        return { raw, provider: 'claude' };
      } catch (e) {
        if (process.env.GEMINI_API_KEY && (isClaudeBillingError(e) || isClaudeQuotaError(e))) {
          console.warn(`[llm:${task}] Claude JSON → Gemini:`, e.message);
          const raw = await callGeminiJson(systemPrompt, userMessage, responseSchema);
          return { raw, provider: 'gemini', fallback: true };
        }
        throw e;
      }
    }
    console.warn(`[llm:${task}] Claude budget → Gemini JSON`);
  }

  let raw = await callGeminiJson(systemPrompt, userMessage, responseSchema);
  try {
    parseGeminiJsonText(raw);
  } catch (e) {
    if (e?.code === 'AI_JSON_PARSE' || /JSON|Prázdná/i.test(e?.message || '')) {
      console.warn(`[llm:${task}] JSON parse fail → retry`, e.message?.slice?.(0, 120));
      const compactSystem = `${systemPrompt}\n\nKRITICKÉ: Vrať KRÁTKÝ validní JSON (chatResponse max 800 znaků, softData max 5 položek). Žádný markdown.`;
      raw = await callGeminiJson(compactSystem, userMessage, responseSchema);
    } else {
      throw e;
    }
  }
  return { raw, provider: 'gemini' };
}

export { AiTask };
