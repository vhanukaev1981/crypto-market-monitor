# מרכז השליטה הרב־בורסאי — תפקיד ותכנית מעבר

## החלטה ארכיטקטונית

מרכז השליטה הוא ה־Control Plane של המערכת. הוא אינו פונה ישירות לבורסה ואינו שולח פקודות מסחר.

הפרדה מחייבת:

- **Trading OS / מנועי Legacy** — מבצעים כיום את מסחר Bybit Demo.
- **Platform V2 / Control Plane** — מציג בורסות, חשבונות, בוטים, אסטרטגיות, סיכון, Runtime ונעילות.
- **Execution Gateway עתידי** — יהיה הרכיב היחיד שמורשה להעביר פקודות למתאמי הבורסות.

## מצב שלב 1 — Observation בלבד

`platform_legacy_bot_mapping` קורא את מצב המנועים הפעיל ישירות מ־`bot_configs`:

- סטטוס ריצה.
- Enabled.
- Kill Switch.
- זמן ריצה אחרון.
- סביבת Legacy וקטגוריית המסחר.
- סטטוס סנכרון.

שדות השליטה של `bot_instances` נשארים נעולים:

- `enabled = false`
- `kill_switch = true`
- `runtime_status = stopped`
- `platform_core_controls_execution = false`

לכן Platform V2 יכול לצפות במנועים הקיימים, אך אינו שולט בהם ואינו יכול ליצור פקודות.

## סטטוסי סנכרון

- `legacy_active_observed` — מנוע Legacy פעיל ונצפה על ידי Platform.
- `legacy_inactive_observed` — מנוע Legacy קיים אך אינו חמוש או אינו רץ.
- `live_locked` — הגדרת Mainnet קיימת אך נעולה ומושבתת.
- `missing_legacy_bot` — המיפוי מצביע על בוט שאינו קיים.
- `platform_controls_execution` — שמור לשלב עתידי בלבד.

## שלב 2 — Runtime Observation

יש להוסיף תצוגה מאוחדת עבור:

- Heartbeat אמיתי של כל מנוע.
- ריצה מוצלחת וכושלת אחרונה.
- שגיאה פעילה אחרונה.
- פוזיציות ופקודות פתוחות לפי חשבון ובורסה.
- סטטוס Private Stream ו־Smart Exit.

גם בשלב זה אין כתיבה למנועים.

## שלב 3 — Change Requests

שינוי מהמסך לא יעדכן טבלאות ריצה ישירות. הוא ייצור בקשת שינוי מבוקרת הכוללת:

- הפעולה המבוקשת.
- המצב הקודם והחדש.
- המשתמש המאשר.
- סיבת השינוי.
- תוקף הבקשה.
- Audit מלא.

שירות שרת יאמת את הבקשה ויחיל אותה רק לאחר בדיקות בטיחות.

## שלב 4 — Execution Intents

אסטרטגיות ייצרו `execution_intents` בלבד. כל Intent יכלול:

- בוט, חשבון ובורסה.
- סביבה: Shadow, Demo או Live.
- סימול, צד, כמות וסוג פקודה.
- פרופיל סיכון.
- `idempotency_key` ייחודי.
- דרישות Stop Loss ו־Take Profit.

ה־Execution Gateway יבדוק סיכון, כפילויות, Kill Switch, שער Live והרשאות לפני העברה ל־Exchange Adapter.

## שלב 5 — Multi-Exchange

רק לאחר יציבות Bybit Micro-Live Spot יופעל הדגל `multi_exchange_connections` ויצורף Adapter נוסף.

כל Adapter יממש חוזה אחיד:

- `getBalances`
- `getPositions`
- `getOrders`
- `placeOrder`
- `cancelOrder`
- `getExecutions`
- `setNativeProtection`
- `getApiPermissions`

## נעילות קבועות

- משיכות נשארות Hard Locked.
- Mainnet אינו מופעל מתוך ממשק הדפדפן.
- אין מפתח API בקוד או בטבלאות Public.
- אין פקודה ללא Idempotency ורשומת Intent עמידה.
- אין Live ללא אישור ידני, פרופיל סיכון והקצאת חשבון מוגבלת.
