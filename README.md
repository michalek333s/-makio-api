# Nemio Backend

API server pro Nemio — proxy pro GeoPas, Gemini a OpenAI.

## Struktura projektu

```
nemio-backend/
├── src/
│   ├── index.js              ← Hlavní Express server
│   ├── routes/
│   │   ├── property.js       ← /api/property/* (GeoPas analýza)
│   │   ├── ai.js             ← /api/ai/* (chat, listing, vision)
│   │   ├── crm.js            ← /api/crm/* (klienti — TODO Supabase)
│   │   └── contracts.js      ← /api/contracts/* (smlouvy — TODO)
│   └── services/
│       ├── geopas.js         ← GeoPas API wrapper (všechna volání)
│       ├── scoring.js        ← Safety Score algoritmus
│       └── cache.js          ← In-memory cache (nahradit Redis v prod.)
├── REACT_API_CLIENT.js       ← Zkopírujte do React: src/services/api.js
├── .env.example              ← Šablona pro .env
└── package.json
```

## Quickstart

### 1. Naklonujte / zkopírujte do svého projektu

Doporučená struktura vedle vašeho React projektu:
```
váš-projekt/
├── nemio-frontend/   ← váš stávající React app
└── nemio-backend/    ← tento backend
```

### 2. Instalace závislostí

```bash
cd nemio-backend
npm install
```

### 3. Nastavení environment variables

```bash
cp .env.example .env
```

Otevřete `.env` a doplňte klíče:

| Klíč | Kde získat |
|------|-----------|
| `GEOPAS_API_KEY` | Napište na geopas.cz/o-projektu#contact |
| `GEMINI_API_KEY` | aistudio.google.com (zdarma) |
| `OPENAI_API_KEY` | platform.openai.com |
| `SUPABASE_URL` | supabase.com (zdarma) |
| `SUPABASE_ANON_KEY` | Supabase → Settings → API |

### 4. Spuštění (development)

```bash
npm run dev
```

Server běží na `http://localhost:3001`

Ověřte funkčnost:
```bash
curl http://localhost:3001/api/health
```

Očekávaná odpověď:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "services": {
    "geopas": true,
    "gemini": true,
    "openai": true,
    "supabase": false
  }
}
```

### 5. Napojení React frontendu

1. Zkopírujte `REACT_API_CLIENT.js` do vašeho React projektu jako `src/services/api.js`
2. Přidejte do `.env` vašeho React projektu:
   ```
   VITE_API_URL=http://localhost:3001
   ```
3. V `App.jsx` nahraďte přímá API volání:

```js
// PŘED (nebezpečné — klíč viditelný)
const url = `https://generativelanguage.googleapis.com/...?key=${apiKey}`;

// PO (bezpečné — volá váš backend)
import { sendChatMessage } from '../services/api';
const response = await sendChatMessage(userMessage, chatHistory);
```

4. Nahraďte `simulateKatastrFetch`:

```js
// PŘED
const simulateKatastrFetch = (clientName, address) => { /* setTimeout simulace */ };

// PO
import { analyzeProperty } from '../services/api';
const data = await analyzeProperty(address);
```

## API Endpoints

### Analýza nemovitosti
```
POST /api/property/analyze
Body: { "query": "Mánesova 12, Praha 2" }

GET /api/property/search?q=Praha+Vinohrady
```

### AI Asistent
```
POST /api/ai/chat
Body: { "message": "...", "history": [], "clientsContext": "..." }

POST /api/ai/listing
Body: { "propertyInfo": "...", "vibe": "...", "targetBuyer": "..." }

POST /api/ai/staging
Body: { "imageBase64": "...", "mimeType": "image/jpeg" }

POST /api/ai/valuation-strategy
Body: { "propertyAnalysis": {...}, "sellerGoal": "balanced" }
```

### Health
```
GET /api/health
```

## Deployment (produkce)

Doporučujeme **Railway.app** nebo **Render.com**:

1. Pushněte backend na GitHub
2. Připojte Railway k repo
3. Přidejte environment variables v Railway dashboard
4. Deploy je automatický

Railway free tier: 5 USD kredit/měsíc — pro development zdarma.

## TODO — Fáze 1

- [ ] Napojit Supabase (CRM routes)
- [ ] Přidat JWT autentizaci (každý makléř vidí jen své klienty)
- [ ] Nahradit in-memory cache Redis nebo Supabase tabulkou
- [ ] Přidat webhook pro GeoPas notifikace (změny na LV)
