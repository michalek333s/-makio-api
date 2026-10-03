# Tagy pro advokátní šablony Makio

Používejte pouze `{{snake_case}}` v jednom souvislém textovém běhu Wordu (bez formátování uprostřed tagu).
Makio **negeneruje** právní text — pouze vyplní tyto placeholdery z CRM.

| Tag | Popis |
|-----|-------|
| `{{client_name}}` | Celé jméno klienta (primární / Party A fallback) |
| `{{client_first_name}}` | Křestní jméno |
| `{{client_last_name}}` | Příjmení |
| `{{client_email}}` | E-mail |
| `{{client_phone}}` | Telefon |
| `{{client_address}}` | Adresa / trvalá adresa klienta |
| `{{address_property_sell}}` | Adresa nemovitosti k prodeji (z CRM) |
| `{{address_property_buy}}` | Lokalita / poptávka (co klient hledá) |
| `{{client_rc}}` | Rodné číslo |
| `{{client_id_card}}` | Číslo občanského průkazu |
| `{{client_interest}}` | Záměr (např. 3+kk) |
| `{{client_budget}}` | Rozpočet |
| `{{client_type}}` | Typ (Kupující, …) |
| `{{client_status}}` | Stav v CRM |
| `{{client_priority}}` | Priorita (hot/warm/cold) |
| `{{client_last_contact}}` | Poslední kontakt |
| `{{client_context}}` | Poznámka / kontext |
| `{{property_address}}` | Adresa nemovitosti (z formuláře) |
| `{{property_lv}}` | List vlastnictví (LV) |
| `{{property_parcel}}` | Parcela / k.ú. |
| `{{property_area_m2}}` | Výměra m² |
| `{{property_disposition}}` | Dispozice (2+kk…) |
| `{{date_today_cs}}` | Dnešní datum (cs-CZ) |
| `{{date_iso}}` | Dnešní datum YYYY-MM-DD |
| `{{datetime_now_iso}}` | Datum a čas ISO |
| `{{year}}` | Rok (číslo) |
| `{{jmeno_kupujiciho}}` | Alias: celé jméno (české šablony) |
| `{{jmeno}}` | Alias: křestní jméno |
| `{{prijmeni}}` | Alias: příjmení |
| `{{email}}` | Alias: e-mail |
| `{{telefon}}` | Alias: telefon |
| `{{adresa_trvala}}` | Alias: trvalá adresa |
| `{{adresa_klienta}}` | Alias: adresa klienta |
| `{{rodne_cislo}}` | Alias: rodné číslo |
| `{{cislo_op}}` | Alias: číslo občanského průkazu |
| `{{predmet_nemovitosti}}` | Alias: předmět / nemovitost |
| `{{adresa_nemovitosti}}` | Alias: adresa nemovitosti |
| `{{party_a_name}}` | Strana A — jméno |
| `{{party_a_first_name}}` | Strana A — křestní |
| `{{party_a_last_name}}` | Strana A — příjmení |
| `{{party_a_email}}` | Strana A — e-mail |
| `{{party_a_phone}}` | Strana A — telefon |
| `{{party_a_address}}` | Strana A — adresa |
| `{{party_a_rc}}` | Strana A — rodné číslo |
| `{{party_a_id_card}}` | Strana A — číslo OP |
| `{{party_b_name}}` | Strana B — jméno |
| `{{party_b_first_name}}` | Strana B — křestní |
| `{{party_b_last_name}}` | Strana B — příjmení |
| `{{party_b_email}}` | Strana B — e-mail |
| `{{party_b_phone}}` | Strana B — telefon |
| `{{party_b_address}}` | Strana B — adresa |
| `{{party_b_rc}}` | Strana B — rodné číslo |
| `{{party_b_id_card}}` | Strana B — číslo OP |
| `{{klient_name}}` | Klient — jméno |
| `{{klient_first_name}}` | Klient — křestní |
| `{{klient_last_name}}` | Klient — příjmení |
| `{{klient_email}}` | Klient — e-mail |
| `{{klient_phone}}` | Klient — telefon |
| `{{klient_address}}` | Klient — adresa |
| `{{klient_rc}}` | Klient — rodné číslo |
| `{{klient_id_card}}` | Klient — číslo OP |
| `{{prodavajici_name}}` | Prodávající — jméno |
| `{{prodavajici_first_name}}` | Prodávající — křestní |
| `{{prodavajici_last_name}}` | Prodávající — příjmení |
| `{{prodavajici_email}}` | Prodávající — e-mail |
| `{{prodavajici_phone}}` | Prodávající — telefon |
| `{{prodavajici_address}}` | Prodávající — adresa |
| `{{prodavajici_rc}}` | Prodávající — rodné číslo |
| `{{prodavajici_id_card}}` | Prodávající — číslo OP |
| `{{kupujici_name}}` | Kupující / zájemce — jméno |
| `{{kupujici_first_name}}` | Kupující / zájemce — křestní |
| `{{kupujici_last_name}}` | Kupující / zájemce — příjmení |
| `{{kupujici_email}}` | Kupující / zájemce — e-mail |
| `{{kupujici_phone}}` | Kupující / zájemce — telefon |
| `{{kupujici_address}}` | Kupující / zájemce — adresa |
| `{{kupujici_rc}}` | Kupující / zájemce — rodné číslo |
| `{{kupujici_id_card}}` | Kupující / zájemce — číslo OP |
| `{{pronajimatel_name}}` | Pronajímatel — jméno |
| `{{pronajimatel_first_name}}` | Pronajímatel — křestní |
| `{{pronajimatel_last_name}}` | Pronajímatel — příjmení |
| `{{pronajimatel_email}}` | Pronajímatel — e-mail |
| `{{pronajimatel_phone}}` | Pronajímatel — telefon |
| `{{pronajimatel_address}}` | Pronajímatel — adresa |
| `{{pronajimatel_rc}}` | Pronajímatel — rodné číslo |
| `{{pronajimatel_id_card}}` | Pronajímatel — číslo OP |
| `{{najemce_name}}` | Nájemce — jméno |
| `{{najemce_first_name}}` | Nájemce — křestní |
| `{{najemce_last_name}}` | Nájemce — příjmení |
| `{{najemce_email}}` | Nájemce — e-mail |
| `{{najemce_phone}}` | Nájemce — telefon |
| `{{najemce_address}}` | Nájemce — adresa |
| `{{najemce_rc}}` | Nájemce — rodné číslo |
| `{{najemce_id_card}}` | Nájemce — číslo OP |
| `{{agency_name}}` | Název realitní kanceláře |
| `{{agency_ico}}` | IČO kanceláře |
| `{{agency_address}}` | Sídlo kanceláře |
| `{{broker_name}}` | Jméno makléře |
| `{{broker_phone}}` | Telefon makléře |
| `{{broker_email}}` | E-mail makléře |
| `{{commission_pct}}` | Provize % |
| `{{commission_amount}}` | Provize Kč |
| `{{exclusivity}}` | Exkluzivita (ano/ne / text) |
| `{{contract_term_months}}` | Doba trvání smlouvy (měsíce) |
| `{{reservation_deposit}}` | Rezervační záloha |
| `{{reservation_deposit_words}}` | reservation_deposit_words |
| `{{reservation_deadline}}` | Lhůta rezervace |
| `{{purchase_price}}` | Kupní cena |
| `{{purchase_price_words}}` | purchase_price_words |
| `{{rent_monthly}}` | Měsíční nájem |
| `{{rent_monthly_words}}` | rent_monthly_words |
| `{{deposit_amount}}` | Kauce |
| `{{deposit_amount_words}}` | deposit_amount_words |
| `{{lease_start}}` | Začátek nájmu |
| `{{lease_end}}` | Konec nájmu |
| `{{payment_day}}` | Den splatnosti nájmu |
| `{{services_fee}}` | services_fee |
| `{{services_fee_words}}` | services_fee_words |
| `{{lease_account}}` | lease_account |
| `{{max_occupants}}` | max_occupants |
| `{{property_item_a}}` | property_item_a |
| `{{property_item_b}}` | property_item_b |
| `{{property_item_c}}` | property_item_c |
| `{{property_municipality}}` | property_municipality |
| `{{property_ku}}` | property_ku |
| `{{property_unit}}` | property_unit |
| `{{property_cp}}` | property_cp |
| `{{property_district}}` | property_district |
| `{{parcel_a_area}}` | parcel_a_area |
| `{{parcel_b}}` | parcel_b |
| `{{parcel_b_area}}` | parcel_b_area |
| `{{prodavajici_identity}}` | prodavajici_identity |
| `{{kupujici_identity}}` | kupujici_identity |
| `{{pronajimatel_identity}}` | pronajimatel_identity |
| `{{najemce_identity}}` | najemce_identity |
| `{{escrow_lawyer_name}}` | escrow_lawyer_name |
| `{{escrow_lawyer_address}}` | escrow_lawyer_address |
| `{{escrow_lawyer_ico}}` | escrow_lawyer_ico |
| `{{escrow_cak_number}}` | escrow_cak_number |
| `{{escrow_account}}` | escrow_account |
| `{{escrow_bank}}` | escrow_bank |
| `{{place_of_signing}}` | place_of_signing |
| `{{template_id}}` | ID šablony (interní) |
| `{{template_version}}` | Verze šablony |
| `{{contract_type_label}}` | Název typu smlouvy |

## Typy smluv (vlna 1)

### Smlouva o zprostředkování (`brokerage`)
Povinné: `party_a_name`, `agency_name`, `broker_name`, `property_address`, `commission_pct`, `date_today_cs`

### Rezervační smlouva (`reservation`)
Povinné: `kupujici_name`, `prodavajici_name`, `property_lv`, `purchase_price`, `reservation_deposit`, `reservation_deadline`, `date_today_cs`

### Nájemní smlouva (`lease`)
Povinné: `pronajimatel_name`, `najemce_name`, `property_unit`, `rent_monthly`, `deposit_amount`, `lease_start`, `date_today_cs`

### Kupní smlouva (`purchase`)
Povinné: `prodavajici_name`, `kupujici_name`, `property_lv`, `purchase_price`, `date_today_cs`
