# תיקון נדרש לפני פריסת נתב Futures החדש

הפונקציה הפעילה `futures-demo-engine` מחפשת כיום את הגדרת הבוט כך:

```ts
.eq("environment", "demo")
.eq("category", "linear")
```

הנתב הישן עקף זאת באמצעות שינוי זמני של `bot_configs.environment` מ־`demo_futures` ל־`demo`, קריאה למנוע והחזרת הערך. דפוס זה יוצר חלון מרוץ מול פונקציות Spot שמחפשות רשומת `demo` יחידה.

## השינוי הנדרש במנוע

יש להחליף רק את מסנן סביבת ההגדרה:

```diff
- .eq("environment", "demo")
+ .eq("environment", "demo_futures")
```

אין לשנות את:

- `BASE_URL`, שחייב להישאר `https://api-demo.bybit.com`.
- `BYBIT_ENV`, שחייב להישאר `demo` כי זהו שם סביבת החיבור לבורסה.
- שדה `orders.environment`, שיכול להישאר `demo` לציון שהפקודה בוצעה בחשבון Demo.
- מגבלות 10–50 USDT, מינוף 1, Kill Switch או אימות TP/SL.

## סדר פריסה בטוח

1. לייצא את המקור המלא של `futures-demo-engine` ל־GitHub.
2. להחיל את שינוי המסנן לעיל בלבד.
3. להריץ בדיקה סטטית שאין כתובת Mainnet ושאין נתיב משיכה.
4. לפרוס את `futures-demo-engine` ולבדוק ריצה ידנית כשהבוט אינו חמוש.
5. להפעיל את המשתנה `FUTURES_ENGINE_ACCEPTS_DEMO_FUTURES=true`.
6. לפרוס את הנתב החדש.
7. לבדוק בלוגים של Spot ו־Futures במקביל.
8. רק לאחר הצלחה להחזיר את תזמון ה־Cron לשגרה.

## תנאי עצירה

אין לפרוס את הנתב החדש לפני תיקון המנוע. הנתב ב־PR נכשל במכוון במצב סגור (`fail closed`) כל עוד משתנה האישור אינו `true`.
