# Sablontár

Tagsági weboldal: a vásárló havi díjért hozzáfér egy zárt sablonkönyvtárhoz (Insta/TikTok poszt-, Story- és Reel-sablonok), amely havonta bővül.

Az első, minimális verzió tartalma:

- **Bemutatkozó oldal** árral, előnyökkel és GYIK-kel (`/`)
- **Regisztráció és belépés** e-mail-címmel és jelszóval (`/regisztracio`, `/belepes`)
- **Havi előfizetés Stripe-pal**: Stripe Checkout fizetőoldal, lemondás és kártyacsere a Stripe ügyfélportálján (`/elofizetes`, `/fiok`)
- **Zárt tagi felület**: sablonok böngészése hónap és típus szerint, letöltés (`/tagoknak`)
- **Admin felület** a sablonok feltöltéséhez és törléséhez (`/admin`)
- Mobilra optimalizált, JavaScript nélkül is működő felület

## Technika

Node.js 22 + Express, SQLite (`better-sqlite3`), szerveroldali HTML, a Stripe hivatalos Node SDK-ja. Nincs külön frontend build: `npm start`, és fut.

| Mappa | Tartalom |
| --- | --- |
| `src/app.js` | útvonalak és jogosultság-ellenőrzés |
| `src/auth.js` | jelszó-hash (scrypt), munkamenetek, belépés-korlátozás |
| `src/billing.js` | Stripe Checkout, ügyfélportál, webhookok |
| `src/library.js` | sablonok tárolása |
| `src/views.js` | az oldalak HTML-je |
| `public/` | CSS és egy apró JS |
| `test/` | végponttól végpontig tartó tesztek (`npm test`) |

## Helyi futtatás

```bash
npm install
cp .env.example .env      # töltsd ki a Stripe-kulcsokat és az ADMIN_EMAILS-t
npm start                 # http://localhost:3000
```

A webhookok helyi fogadásához a [Stripe CLI](https://docs.stripe.com/stripe-cli) kell:

```bash
stripe listen --forward-to localhost:3000/webhook/stripe
```

A kiírt `whsec_...` titkot tedd a `.env` fájl `STRIPE_WEBHOOK_SECRET` sorába. Tesztkártya: `4242 4242 4242 4242`, tetszőleges jövőbeli lejárat és CVC.

Tesztek: `npm test`. A Stripe API-t a tesztek szimulálják, a webhook-aláírás ellenőrzése viszont a valódi SDK-kóddal fut.

## A Stripe beállítása

1. **Termék és ár**: Dashboard → Product catalog → új termék, *Recurring*, havi ár forintban. Az ár azonosítója (`price_...`) kerül a `STRIPE_PRICE_ID`-be.
2. **Ügyfélportál**: Settings → Billing → Customer portal → engedélyezd a lemondást és a fizetési mód frissítését. Lemondáskor a hozzáférés a kifizetett időszak végéig megmarad.
3. **Webhook**: Developers → Webhooks → új végpont: `https://<domain>/webhook/stripe`, ezekkel az eseményekkel:
   - `checkout.session.completed`
   - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - `customer.subscription.paused`, `customer.subscription.resumed`
4. Élesítéskor cseréld a teszt kulcsokat (`sk_test_`) élesekre (`sk_live_`), és hozd létre az árat és a webhookot éles módban is.

A hozzáférést mindig a Stripe-ban tárolt állapot dönti el: minden webhook után az alkalmazás újra lekéri az előfizetést, így a sorrendjükből kieső vagy ismételt események sem okoznak hibát. Hozzáférést az `active` és a `trialing` állapot ad.

**Miért Stripe és nem Barion?** A Stripe beépítetten kezeli a havi ismétlődő terhelést, a sikertelen fizetések újrapróbálását és a lemondást. Barionnál az ismétlődő terhelést (token alapú fizetés) nekünk kellene ütemezni és újrapróbálni, ez az első verzióhoz sok plusz munka.

## Sablonok feltöltése

Az `ADMIN_EMAILS`-ben megadott e-mail-címmel regisztrálj, és megjelenik az **Admin** menüpont. Minden sablonhoz meg kell adni egy címet, egy típust (Poszt, Story, Reel stb.) és egy hónapot, és vagy egy fájlt (legfeljebb 200 MB), vagy egy linket (például egy Canva-sablon megosztási linkjét). Előnézeti képet is feltölthetsz; álló, 4:5 arányú kép mutat a legjobban.

A fájlok nem nyilvánosak: csak bejelentkezett, aktív előfizetők tölthetik le őket.

## Élesítés

- Olyan tárhely kell, ahol **tartós lemez** van a `DATA_DIR` számára (SQLite-adatbázis és feltöltött fájlok): pl. egy VPS, Render vagy Railway tartós kötettel, Fly.io volume-mal. Az alkalmazás egy folyamatként fut.
- HTTPS kötelező. A `BASE_URL` legyen a végleges `https://` cím; ekkor a munkamenet-süti automatikusan `Secure` lesz. Fordított proxy mögött állítsd be: `TRUST_PROXY=1`.
- Mentsd rendszeresen a `DATA_DIR` mappát.

## Mi hiányzik még (következő lépések)

- **Elfelejtett jelszó** e-mailben: ehhez e-mail-küldő szolgáltatás kell (pl. Postmark, Brevo). Addig a Stripe Dashboardon és az adatbázisban lehet segíteni a felhasználónak.
- **Számlázás**: a Stripe csak nyugtát küld, magyar számlát nem állít ki. Ehhez számlázóprogram-integráció kell (pl. Számlázz.hu vagy Billingo), a Stripe `invoice.paid` eseményére.
- **Jogi oldalak**: ÁSZF, adatkezelési tájékoztató, süti-tájékoztató, impresszum. A fizetőoldalon az ÁSZF elfogadását a Stripe Checkout `consent_collection` beállításával lehet kérni.
- E-mail-cím megerősítése regisztrációkor, ingyenes próbaidőszak, éves csomag.
