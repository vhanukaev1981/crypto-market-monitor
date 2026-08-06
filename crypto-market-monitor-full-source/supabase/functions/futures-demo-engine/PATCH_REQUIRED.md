# תיקון נתב ומנוע Futures — הושלם

ב־6 באוגוסט 2026 תוקן חלון המרוץ שנגרם מכך שהנתב הישן שינה זמנית את `bot_configs.environment`.

## השינוי שבוצע

המנוע `futures-demo-engine` קורא כעת ישירות את הגדרת הבוט:

```ts
.eq("environment", CONFIG_ENVIRONMENT)
```

כאשר:

```ts
const CONFIG_ENVIRONMENT = "demo_futures";
```

הנתב `futures-demo-engine-router` אינו מבצע עוד `update` לטבלת `bot_configs` ואינו משנה את הסביבה, גם לא זמנית.

## בקרות שנשמרו

- כתובת הבורסה נשארה `https://api-demo.bybit.com`.
- `BYBIT_ENV` נשאר `demo`.
- מגבלת פקודה נשארה 10–50 USDT.
- המינוף נשאר 1.
- אימות Native Stop Loss ו־Take Profit נשאר פעיל.
- אימות אסימון Cron פרטי נשאר פעיל.
- Mainnet ומשיכות נשארו חסומים.

## אימות שבוצע

- `futures-demo-engine` נפרס כגרסה 3.
- `futures-demo-engine-router` נפרס כגרסה 3.
- ריצת אימות דרך `public.invoke_futures_demo_engine()` הסתיימה ב־HTTP 200.
- התגובה דיווחה `environment=demo_futures` וללא פעולות מסחר.
- מנוע Spot המשיך להשלים ריצות ללא כשל.
- ה־Private Stream נשאר מאומת וללא שגיאה.
- תזמון `futures_demo_engine_15m` הוחזר לפעילות לאחר האימות.

## בדיקות רגרסיה

הבדיקה `tests/futures-router-safety.test.mjs` מוודאת כי:

- הנתב אינו משנה את סביבת הבוט.
- הנתב מחפש `demo_futures` בלבד.
- המנוע קורא `demo_futures` ישירות.
- המנוע נשאר נעול לכתובת Bybit Demo.
- לא קיים נתיב משיכה.
