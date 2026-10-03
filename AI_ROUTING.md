# AI routování v Nemio

Cíl: **Claude jen tam, kde přidá nejvíc hodnoty** — zbytek Gemini + GeoPas API.

## Proměnné (`nemio-backend/.env`)

| Proměnná | Výchozí | Účel |
|----------|---------|------|
| `CHAT_PROVIDER` | `gemini` | CRM chat, SMS, polish |
| `GEOPAS_CHAT_MODE` | `pipeline` | Dotazy na nemovitost v chatu |
| `GEOPAS_PIPELINE_GEMINI_WRAP` | `1` | Po GeoPas krátké Gemini shrnutí |
| `GEOPAS_CHAT_AUTO_CLAUDE` | `0` | V režimu `auto` povolit Claude agenta |
| `CLAUDE_DAILY_BUDGET` | `0` | Celkový denní limit Claude volání |
| `CLAUDE_BUDGET_GEOPAS` | `0` | Limit jen pro GeoPas agenta |
| `CLAUDE_BUDGET_CHAT` | `0` | Limit pro chat/SMS/polish |

## Režimy GeoPas chatu

- **`pipeline`** (doporučeno): `runPropertyAnalysis` → fakta z GeoPas → volitelně 1× Gemini text. **Bez Claude.**
- **`claude`**: Plný agent s nástroji — drahé; při chybě kreditu → automaticky pipeline.
- **`auto`**: Pipeline; Claude agent jen pokud `GEOPAS_CHAT_AUTO_CLAUDE=1` a budget.

## Kód

- `src/config/aiRouting.js` — pravidla
- `src/services/llmRouter.js` — volání Gemini/Claude + fallback při billing chybě
- `src/services/claudeBudget.js` — denní počítadlo
- `src/services/geopasChatHandler.js` — GeoPas v chatu

## Kontrola

```bash
curl http://localhost:3001/api/health
```

Pole `aiRouting` a `claudeUsageToday`.
