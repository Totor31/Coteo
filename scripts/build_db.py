"""Reconstruit data/db.json depuis l'API TCGdex (cartes françaises + prix Cardmarket).

Lancé chaque semaine par .github/workflows/update-prices.yml.
Usage local : python scripts/build_db.py
"""
import json, os, sys, time, datetime
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote
import requests

BASE = "https://api.tcgdex.net/v2/fr"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "db.json")
S = requests.Session()
S.headers["User-Agent"] = "coteo-price-update (github.com/Totor31/coteo)"


def get(url, tries=4):
    for i in range(tries):
        try:
            r = S.get(url, timeout=30)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                return None
        except Exception:
            pass
        time.sleep(1.5 * (i + 1))
    return None


def r2(x):
    return None if x is None else round(float(x), 2)


def main():
    sets_list = get(BASE + "/sets") or []
    with ThreadPoolExecutor(8) as ex:
        sets = [d for d in ex.map(lambda s: get(BASE + "/sets/" + quote(s["id"], safe="")), sets_list) if d]
    # on retire les cartes du jeu mobile « Pocket »
    sets = [d for d in sets if (d.get("serie") or {}).get("id") != "tcgp"]
    sets.sort(key=lambda d: d.get("releaseDate") or "")
    sidx = {d["id"]: i for i, d in enumerate(sets)}
    ids = [c["id"] for d in sets for c in d.get("cards", [])]
    print(f"{len(sets)} séries, {len(ids)} cartes", flush=True)

    def fc(cid):
        return get(BASE + "/cards/" + quote(cid, safe=""))

    with ThreadPoolExecutor(12) as ex:
        details = list(ex.map(fc, ids))

    rar, ridx, cards, missing = [], {}, [], 0
    for cid, d in zip(ids, details):
        if not d:
            missing += 1
            continue
        s = (d.get("set") or {}).get("id")
        if s not in sidx:
            continue
        ra = d.get("rarity") or ""
        if ra not in ridx:
            ridx[ra] = len(rar)
            rar.append(ra)
        vd = d.get("variants_detailed") or []
        v = [str(x.get("type", "")).lower() for x in vd]
        flag = (1 if "normal" in v else 0) | (2 if "reverse" in v else 0) | (4 if "holo" in v else 0)
        if d.get("image"):
            flag |= 8  # une image existe chez TCGdex
        cm = None
        for x in vd:
            p = (x.get("pricing") or {}).get("cardmarket")
            if p:
                cm = p
                break
        cm = cm or ((d.get("pricing") or {}).get("cardmarket")) or {}
        row = [cid, d.get("name"), d.get("localId"), sidx[s], ridx[ra], flag,
               r2(cm.get("trend")), r2(cm.get("avg30")), r2(cm.get("trend-holo")), r2(cm.get("avg30-holo"))]
        while row and row[-1] is None:
            row.pop()
        cards.append(row)

    if len(cards) < 0.9 * len(ids):
        sys.exit(f"Trop de cartes manquantes ({missing}) : base non remplacée.")

    out = {
        "date": datetime.date.today().isoformat(),
        "sets": [[d["id"], d["name"], (d.get("cardCount") or {}).get("official"), (d.get("cardCount") or {}).get("total"),
                  (d.get("serie") or {}).get("name"), (d.get("releaseDate") or "")[:7], (d.get("serie") or {}).get("id")] for d in sets],
        "rar": rar,
        "cards": cards,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"OK : {len(cards)} cartes écrites ({missing} manquantes)")


if __name__ == "__main__":
    main()
