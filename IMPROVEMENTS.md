# Usprawnienia projektu custom-rss

## Priorytet wysoki

1. Błąd wykrywania zmian może gubić aktualizacje artykułów
- W obu skryptach zapis XML jest pomijany, jeśli nie ma nowych ID, nawet gdy istniejący artykuł wrócił jako HTTP 200 (czyli treść mogła się zmienić).
- Efekt: zmieniona treść może nie trafić do pliku.
- Miejsca:
  - `fetch-rss.js:236`
  - `fetch-rss.js:256`
  - `fetch-eurogamer.js:156`
  - `fetch-eurogamer.js:187`

2. Niespójny klucz identyfikacji w fallbacku (`fetch-rss.js`)
- W fallbacku jest `existingArticles.has(item.link)`, a główny klucz to `item.guid || item.id || item.link`.
- Efekt: możliwe błędne rozpoznawanie nowych/starych wpisów.
- Miejsca:
  - `fetch-rss.js:146`
  - `fetch-rss.js:246`

## Priorytet średni

3. Brak timeoutu HTTP w `fetch-eurogamer.js`
- `fetch-rss.js` ma default timeout, a `fetch-eurogamer.js` nie.
- Efekt: potencjalnie długie zawieszenia workflow przy problematycznych hostach.
- Miejsce:
  - `fetch-eurogamer.js:33`

4. Zbyt ciężkie wyciąganie linku z RSS content
- `extractHrefFromContent` używa rozbudowanej konfiguracji JSDOM, choć potrzebny jest tylko pierwszy `href`.
- Efekt: większa złożoność i koszt CPU/RAM.
- Sugestia: zamiana na `cheerio` dla samej ekstrakcji linku.
- Miejsce:
  - `fetch-rss.js:100`

5. Brak kontrolowanej równoległości pobierania artykułów
- Artykuły są przetwarzane sekwencyjnie.
- Sugestia: dodać limitowaną współbieżność (np. 4-6 równoległych requestów) z zachowaniem retry.
- Miejsca:
  - `fetch-rss.js:145`
  - `fetch-eurogamer.js:110`

## Priorytet niski

6. Duplikacja logiki między skryptami
- Powielone funkcje: `fetchWithRetry`, `loadExistingItems`, `addDcCreatorToXml`, `removeStylesAndImages`.
- Sugestia: wydzielić wspólne utility (np. `lib/feed-utils.js`).
- Miejsca:
  - `fetch-rss.js`
  - `fetch-eurogamer.js`

7. Niespójność wersji Node w dokumentacji i konfiguracji
- README: `18+`, `package.json`: `>=20`, workflow: `22`.
- Sugestia: ujednolicić wymagania i dokumentację.
- Miejsca:
  - `README.md:6`
  - `package.json:7`
  - `.github/workflows/fetch-rss.yml:26`
