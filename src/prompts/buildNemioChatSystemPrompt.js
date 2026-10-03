import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPrompt(name) {
  return readFileSync(join(__dirname, name), 'utf8');
}

/**
 * Kompletní system prompt pro /api/ai/chat.
 * makio-expertise-core.txt + nemio-chat-system.txt (placeholdery {{CURRENT_DATE}} …).
 */
export async function buildNemioChatSystemPrompt({
  currentDate,
  currentTime,
  referenceDateIso,
  clientsContext,
  historyBlock,
  activeClientName,
  brokerFirstName = '',
  marketContext = '',
  screenContext = '',
  feedbackLessons = '',
}) {
  let s = [
    readPrompt('makio-expertise-core.txt'),
    readPrompt('makio-broker-mastery.txt'),
    readPrompt('makio-expert-playbook.txt'),
    readPrompt('makio-deal-stages-comms.txt'),
    readPrompt('makio-client-comms.txt'),
    readPrompt('nemio-chat-system.txt'),
  ].join('\n\n');
  const safe = (v) => String(v ?? '');
  s = s.replace(/\{\{CURRENT_DATE\}\}/g, safe(currentDate));
  s = s.replace(/\{\{CURRENT_TIME\}\}/g, safe(currentTime));
  s = s.replace(/\{\{REFERENCE_DATE_ISO\}\}/g, safe(referenceDateIso));
  s = s.replace(/\{\{CLIENTS_CONTEXT\}\}/g, safe(clientsContext));
  s = s.replace(/\{\{CHAT_HISTORY\}\}/g, safe(historyBlock));
  s = s.replace(/\{\{ACTIVE_CLIENT_NAME\}\}/g, safe(activeClientName));
  s = s.replace(/\{\{BROKER_FIRST_NAME\}\}/g, safe(brokerFirstName));
  s = s.replace(/\{\{MARKET_CONTEXT\}\}/g, safe(marketContext));
  s = s.replace(/\{\{SCREEN_CONTEXT\}\}/g, safe(screenContext) || '—');
  s = s.replace(/\{\{FEEDBACK_LESSONS\}\}/g, safe(feedbackLessons) || '— (zatím žádné 👎 lekce)');
  return s.trim();
}
