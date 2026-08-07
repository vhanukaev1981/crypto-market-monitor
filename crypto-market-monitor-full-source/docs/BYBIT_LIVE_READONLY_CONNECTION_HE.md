# חיבור Bybit Live — שלב קריאה בלבד

## מצב המערכת

- פונקציה: `bybit-live-readonly-probe`
- Endpoint: `https://api.bybit.com`
- נדרש JWT של המשתמש היחיד.
- אין נתיבי יצירת פקודה, ביטול פקודה, העברה או משיכה.
- `trading_enabled=false`
- `withdrawals_enabled=false`
- בוט Live מושבת, Kill Switch פעיל ו־Live Gate נעול.

## יצירת המפתח ב־Bybit

יש ליצור באתר Bybit מפתח Mainnet מסוג System-generated API Key.

בשלב זה המפתח חייב להיות:

- Read-only.
- ללא Spot Trade.
- ללא Contract Order או Position.
- ללא Withdraw.
- ללא Account Transfer או Subaccount Transfer.

אין להדביק את המפתח או הסוד בצ׳אט, בקוד או בקובץ Git.

## שמירת הסודות ב־Supabase

ב־Supabase Dashboard יש לפתוח Edge Functions → Secrets ולהוסיף:

- `BYBIT_LIVE_API_KEY`
- `BYBIT_LIVE_API_SECRET`

לא נדרשת פריסה מחדש לאחר שמירת הסודות.

## בדיקת החיבור

לאחר שמירת הסודות יש להפעיל מתוך משתמש מחובר את:

- `bybit-live-readonly-probe`

הפונקציה:

1. בודקת את זהות המשתמש.
2. מאמתת את חתימת Mainnet.
3. קוראת `/v5/user/query-api`.
4. דוחה מפתח שאינו Read-only או כולל הרשאות מסחר/העברה/משיכה.
5. קוראת סיכום יתרות בלבד.
6. מעדכנת את רשומת החיבור ל־`connected` תוך השארת המסחר והמשיכות כבויים.

## מעבר עתידי להרשאת מסחר

Supabase Edge Functions אינן מספקות כתובת egress קבועה. לפני שימוש במפתח מסחר עם IP Allowlist נדרש Outbound Proxy או Worker בעל כתובת IP קבועה.

לא מחליפים את מפתח הקריאה בלבד במפתח מסחר לפני השלמת:

- Execution Gateway יחיד.
- Idempotency ו־Reconciliation.
- Static egress proxy.
- Micro-Live Spot limits.
- אישור ידני ושער Live.
