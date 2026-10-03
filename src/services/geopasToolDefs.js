/** Definice nástrojů pro Claude (GeoPas API). */
export const GEOPAS_TOOLS = [
  {
    name: 'geopas_search_entities',
    description:
      'Fulltext vyhledání v GeoPas — adresa, parcela, katastrální území. Vždy první krok. Term např. "Mánesova 12 Praha" nebo "2201/1 Vinohrady".',
    input_schema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'Hledaný text' },
        entities: {
          type: 'string',
          description: 'Volitelně: address,land,cadastral_area (výchozí všechny)',
        },
      },
      required: ['term'],
    },
  },
  {
    name: 'geopas_get_address',
    description: 'Detail adresy podle code z vyhledání (typ address). Vrací m.in. construction_land_kn_id pro parcelu.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'number', description: 'Kód adresy z entityByTerm' },
      },
      required: ['code'],
    },
  },
  {
    name: 'geopas_get_land',
    description: 'Detail parcely podle kn_id (land_kn_id z adresy nebo z vyhledání typu land).',
    input_schema: {
      type: 'object',
      properties: {
        kn_id: { type: 'number', description: 'Katastrální id parcely' },
      },
      required: ['kn_id'],
    },
  },
  {
    name: 'geopas_get_land_environment',
    description:
      'Paralelně: záplavové zóny, hluková mapa, POI v okolí (školy, MHD, služby). Vyžaduje land_kn_id; address_code volitelný pro POI.',
    input_schema: {
      type: 'object',
      properties: {
        land_kn_id: { type: 'number' },
        address_code: { type: 'number', description: 'Kód adresy pro poiByAddress' },
      },
      required: ['land_kn_id'],
    },
  },
  {
    name: 'geopas_get_wsdp_lv',
    description: 'LV, vlastník a zápisy z WSDP. Placené — může selhat bez WSDP účtu.',
    input_schema: {
      type: 'object',
      properties: {
        land_kn_id: { type: 'number' },
      },
      required: ['land_kn_id'],
    },
  },
];
