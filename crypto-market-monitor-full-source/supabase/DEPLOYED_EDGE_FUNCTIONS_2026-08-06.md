# מלאי פונקציות Supabase הפעילות — 6 באוגוסט 2026

פרויקט: `xabffbjifmnoogzcttyd`

זהו צילום מצב לצורך איתור פער בין הקוד הפרוס לבין GitHub. הוא אינו מחליף שמירת המקור המלא של כל פונקציה במאגר.

| פונקציה | גרסה | JWT | SHA-256 פריסה |
|---|---:|:---:|---|
| market-gateway | 6 | לא | `73ce48296c7c60965d9ed2b46f335819439cb26cfa95498e44d0d590ae0c0d19` |
| bybit-demo | 6 | כן | `09fcaf44e5e40b16c0b2aafd7e0893253486a38113cdfb684449146239f491ce` |
| bot-engine | 43 | לא | `1ae2d7e4509cb4b1916a4900318cab052038cfd4b9650f6fd598aed499510014` |
| bybit-connection-probe | 6 | כן | `4cef9aefe5ac3ea2edf72ab451f8724d957cd6cf2fce70a8ee7f07f3306fb3d5` |
| bot-order-status | 2 | לא | `2952caff94b37543e5fd08e71f57d0874dd81e7d18eba330a8891625d66fda7c` |
| bot-smoke-test | 3 | כן | `3a8dccc8564a41d7e7374585844f44884ea01428a988338c3c834c5650dd9283` |
| bot-cron-runner | 5 | לא | `d3acd96968a1aa4dd1fd13fb886e36e5163f6660419718157a7f7317836198b3` |
| bot-engine-v2 | 2 | לא | `5f96793e4a51c06ad78fc8cb5d1126c51ba40506202f0822a5b7335109f6c79f` |
| bot-protection-smoke-test | 3 | כן | `462353bf44ae185fb35fca01fc502db17b8b68477edba6c71f8b892a7c0b3b9a` |
| bot-private-stream | 2 | לא | `a48b8f0ddcb5acdcdb800d1f44132fd843bbc510ef5647ca502c61063ce0ebb0` |
| bot-engine-orchestrator | 2 | לא | `198ac0c7727a2f7f8eacad9b4a13a08647d55db0b3487b648b3e8f49a2b68bd7` |
| bot-smart-exit-manager | 5 | לא | `2286a058b4073a7c0f9d691caa778958c95be55c0915b4982fe7c7c9b674c376` |
| bot-pretrade-optimizer | 2 | לא | `04a665e910b1d27bca7f9641b02f3cbc0d54ab061154397177fed46c1a2d3606` |
| bot-smart-execution-engine | 2 | לא | `8313816501459d340d995a3f825ad3e72d7c3c7ca193e7ab23ff164fb01d48c9` |
| bot-shadow-stop-stream | 2 | לא | `56d4efe03b0d60e7ed981ab7ca10ccf420d2882aec1ed865f117139ab2c1eb49` |
| bot-orderbook-feature-stream | 2 | לא | `349ff2a589c775fe889fe582ca33ddb82906b975fe61fb77d26cdce00bfff2e9` |
| bot-master-controller | 3 | לא | `f4103035d01fbdf9d39fe0fd58d132eb7acf725f51e2ccd88270a6eab444a008` |
| bot-shadow-exit-engine | 2 | לא | `698710a0db7355f2cfcbea7b6c9df1945bf093abeb8d54b500ebf960bd59729e` |
| strategy-lab-runner | 2 | לא | `94a48c997446e4dde90e99cb524b8cf36beaf38042da89df0bf000633a40bc19` |
| futures-strategy-lab-runner | 2 | לא | `b38601fb37e30b1354a0b2b95acb262cc277eb8fb3cf85940c063050f1b7b7c0` |
| bybit-futures-demo-preflight | 2 | לא | `feb30ea42667d386670f0e16863b4a2b1036211b01f612565a7d9a53a1d505c0` |
| bybit-demo-account-audit | 2 | לא | `33b17ca16c72cff2c0e41e089f7d71b955c39bccfe39b7bf53a3129f42e338f1` |
| futures-demo-engine | 3 | לא | `38d50d8c32f260364dec60c238d72d985d7ce5cb7576b92ef7487e1e63cb20ec` |
| futures-demo-engine-router | 3 | לא | `c1326ac61c3914f29cd09b331433276849877c425b4c90450b7d9a539326ad29` |
| bybit-demo-live-snapshot | 3 | כן | `0aad7e4b31e783514b5c993a37e92bb90d5a519361fec216cfc3474be8319fb7` |
| bybit-demo-live-snapshot-cron | 2 | לא | `ca7f81abb63bed258224e7700d7104b271f87c101a7d36e38519216f08ccbe32` |
| strategy-lab-v3 | 2 | לא | `34b49613304bfa442a4842aed270a78458dde4ef08d6c1d77b80157736aad246` |
| bot-engine-v3 | 2 | לא | `290099c7b72ac67486ea02a27771459ec5454640620812da65cb0b552d7bb3b7` |

## שינויים שכבר הוחלו

- `bot-smoke-test` הועבר ל־`verify_jwt=true` ואינו מתוזמן ב־Cron.
- `bot-protection-smoke-test` הועבר ל־`verify_jwt=true` ואינו מתוזמן ב־Cron.
- `futures-demo-engine` יוצא במלואו ל־GitHub ותוקן לקריאה ישירה של `demo_futures`.
- `futures-demo-engine-router` אינו משנה עוד את `bot_configs.environment`.
- ריצת אימות ידנית וריצת Cron מתוזמנת הסתיימו בהצלחה וללא פעולות מסחר.
- המקורות שנשמרו במאגר אינם כוללים סודות.

## עדיפות לייצוא מקור שנותרה

1. `bot-engine-v3`
2. `bot-private-stream`
3. `bot-smart-exit-manager`
4. `bot-cron-runner`
5. `bybit-demo`
6. יתר הפונקציות לפי תלות וסיכון

אין להעתיק ל־GitHub ערכי סודות, מפתחות API או אסימוני Cron. כל ערך כזה יוחלף בקריאת `Deno.env` או באחסון פרטי מוגן.
