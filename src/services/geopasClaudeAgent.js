import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEOPAS_TOOLS } from './geopasToolDefs.js';
import { runGeopasToolSafe } from './geopasToolRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const MAX_AGENT_TURNS = 10;

function loadSystemPrompt({ historyBlock, activeClientName }) {
  const template = fs.readFileSync(
    path.join(__dirname, '../prompts/geopas-agent-system.txt'),
    'utf8',
  );
  return template
    .replace('{{CHAT_HISTORY}}', historyBlock || '(prázdné)')
    .replace('{{ACTIVE_CLIENT_NAME}}', activeClientName || '—');
}

async function callClaudeMessagesApi(body) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY není nastaven — GeoPas agent vyžaduje Claude.');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try {
      detail = JSON.parse(raw).error?.message || detail;
    } catch {
      /* ignore */
    }
    throw new Error(`Claude ${res.status}: ${detail}`);
  }
  return JSON.parse(raw);
}

/**
 * Agentní smyčka: Claude volá GeoPas nástroje, dokud stop_reason !== tool_use.
 */
export async function runGeopasClaudeAgent({
  message,
  historyBlock = '',
  activeClientName = '',
}) {
  const system = loadSystemPrompt({ historyBlock, activeClientName });
  const messages = [{ role: 'user', content: message.trim() }];
  const toolsUsed = [];

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const response = await callClaudeMessagesApi({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
      system,
      tools: GEOPAS_TOOLS,
      messages,
    });

    const assistantContent = response.content || [];
    messages.push({ role: 'assistant', content: assistantContent });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      const textBlocks = assistantContent.filter((b) => b.type === 'text');
      const text = textBlocks.map((b) => b.text).join('\n').trim();
      return {
        chatResponse:
          text ||
          'Nepodařilo se sestavit odpověď. Zkuste upřesnit adresu nebo parcelu včetně města / KÚ.',
        toolsUsed,
        stopReason: response.stop_reason,
      };
    }

    if (response.stop_reason !== 'tool_use') {
      break;
    }

    const toolUses = assistantContent.filter((b) => b.type === 'tool_use');
    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        toolsUsed.push(tu.name);
        const result = await runGeopasToolSafe(tu.name, tu.input || {});
        return {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result,
        };
      }),
    );

    messages.push({ role: 'user', content: toolResults });
  }

  return {
    chatResponse:
      'Analýza trvala příliš dlouho — zkuste dotaz zúžit (konkrétní adresa nebo parcela + město).',
    toolsUsed,
    stopReason: 'max_turns',
  };
}
