const express = require('express');
const cors = require('cors');
// הוספנו את זה כדי לפתור את קריסת השרת ולתמוך ב-fetch
const fetch = require('node-fetch'); 

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // מאפשר קבלת קבצי JSON גדולים (כמו היסטוריית תמלול)

// ==========================================
// 1. נתיב התמלול (גרסה משופרת ויציבה)
// ==========================================
app.post('/api/transcribe', async (req, res) => {
    // הגדלת זמן ה-Timeout של הבקשה הספציפית הזו בשרת (לדוגמה: 5 דקות)
    // מומלץ כי תמלול אודיו ארוך עלול לקחת זמן רב
    req.setTimeout(300000); 

    try {
        const { apiKey, fileUri, mimeType, modelName, promptCtx } = req.body;
        
        // ולידציה בסיסית
        if (!apiKey || !fileUri) {
            return res.status(400).json({ error: 'חסר מפתח API או File URI של הקובץ' });
        }

        const model = modelName || 'gemini-2.5-flash';
        
        // 1. העברת כל חוקי התמלול הנוקשים ל-System Instruction - בדיוק כמו שהיה לך!
        const systemInstructionText = `תפקיד: מומחה תמלול.
המטרה העיקרית היא להפיק תמלול מדויק של קובץ האודיו לשפה עברית תקנית ורצופה, ולפלט את התוצאה כקובץ SRT (כתוביות). הדגש הוא על דיוק סמנטי-פונטי: לשקף את המשמעות המילולית ואת הכתיב התקני של המילים בעברית מודרנית, ללא תלות בהגייה המקומית שנשמעה בקובץ. האודיו כולל שיחה או הרצאה בעברית שמשולבים בה מילים וביטויים רבים מ"לשון הקודש" (ארמית ועברית תלמודית/רבנית) עם הגייה מסורתית.

עקרון מפתח: נורמליזציה לכתיב תקני (Priority-One Directive)
יש ליישם תיקון אוטומטי של הגיית לשון הקודש חזרה לכתיב התקני העברי הסטנדרטי. כל סטייה מהכתיב התקני שנשמעת באודיו חייבת לעבור נורמליזציה:
תיקון עיצורים:
אם נשמעת הגיית 'ס' או 'ש' במקום 'כ' רפויה (לדוגמה: "כסיב" או "שבס"), יש לתמלל תמיד כתיב או שבת.
אם נשמעת הגיית 'ס' במקום 'ת' רפויה (לדוגמה: "בראסיס"), יש לתמלל תמיד בראשית.
אם הגיית 'ת' ו-'ט' נשמעת דומה (לדוגמה: "מיתרה"), יש לתמלל בהתאם לכתיב התקני של המילה בהקשרה (לדוגמה: מטרה).
תיקון תנועות:
קמץ כחולם/ו': אם מילה עם קמץ נשמעת עם הגיית חולם/ו' ארוכה (לדוגמה: "שולויים", "קוֹדוֹיש"), יש לתמלל שלום או קדוש (שמירה על האות המקורית).
חולם כ-"וי"/"אוי": אם מילה עם חולם נשמעת עם תוספת י' (לדוגמה: "סויד", "חוכמו"), יש לתמלל סוד או חכמה (הסרת הי' הנוספת).
צירה כ-"יי"/"איי": אם מילה עם צירה נשמעת עם תוספת י' (לדוגמה: "חילק", "אימת"), יש לתמלל חלק או אמת (הסרת הי' הנוספת).

מונחי מפתח וארמית (Mandatory Fixes): יש לתקן מונחים ספציפיים להלן:
'שבס קוידש' מתומלל שבת קודש.
'חוכמו' מתומלל חכמה.
'עוילם' מתומלל עולם.
'סויד' מתומלל סוד.
'עיון' (בהגייה שונה) מתומלל עיון.
חלקיק הקישור הארמי 'קא' מתומלל קא (יש לשמר את המילה הארמית כפי שהיא).
הפועל 'להוי' מתומלל להיות, אלא אם כן הוא חלק מציטוט ארמי מובהק שרצוי לשמר את מקורו.
מילים וביטויים כלליים בארמית או לשון הקודש (כגון השגחה פרטית ביטול היש אין סוף הלכה קבלה גמרא משנה ברכה) יתומללו בכתיב התקני העברי או הארמי המקובל תוך התחשבות במשמעות ההקשרית.

1. תקן שגיאות הגייה ודקדוק.
2. הפלט חייב להיות אובייקט JSON תקין בלבד, ללא שום טקסט נוסף וללא עיצוב, במבנה הבא בדיוק:
{
  "summary": "כתוב סיכום של התוכן בשפה העברית בלבד. הסיכום חייב להיות באורך של עד 25 מילים ולא מעבר לכך.",
  "subtitles": [{"start":"HH:MM:SS,mmm","end":"HH:MM:SS,mmm","text":"..."}]
}
3. קריטי: אסור להשתמש במרכאות כפולות (") בתוך ערכי הטקסט (summary או text). השתמש בגרש יחיד (') בלבד.
4. אל תרד שורות (Enter) בתוך ערכי הטקסט.`;

        // 2. בניית התוכן (Contents) שעליו המודל יעבוד: הקובץ + ההקשר (אם יש)
        const requestParts = [
            { fileData: { mimeType: mimeType || 'audio/mpeg', fileUri: fileUri } }
        ];
        
        // אם המשתמש סיפק הקשר, נוסיף אותו כטקסט מלווה לקובץ
        if (promptCtx) {
            requestParts.push({ text: `הקשר לאודיו זה שיעזור לך בתמלול: ${promptCtx}` });
        }

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: {
                    parts: [{ text: systemInstructionText }]
                },
                contents: [{ parts: requestParts }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });

        // טיפול נכון בשגיאות API (כמו שגיאת העומס 429) - מעביר אותן לאתר
        if (!response.ok) {
            const errText = await response.text();
            console.error('Google API Error:', errText);
            return res.status(response.status).json({ error: 'שגיאת API מגוגל', details: errText });
        }

        res.json(await response.json());

    } catch (error) {
        console.error('Transcription Error:', error);
        res.status(500).json({ error: 'אירעה שגיאה בתהליך התמלול', details: error.message });
    }
});

// ==========================================
// 2. נתיב הצ'אט החדש והסודי! (גרסה משופרת ובטוחה)
// ==========================================
app.post('/api/chat', async (req, res) => {
    try {
        const { apiKey, modelName, historyForApi, contextSubs, msgPrompt } = req.body;
        
        // 1. בדיקות תקינות (Validation) למניעת קריסות
        if (!apiKey) return res.status(400).json({ error: 'חסר מפתח API' });
        if (!historyForApi || !Array.isArray(historyForApi) || historyForApi.length === 0) {
            return res.status(400).json({ error: 'היסטוריית הצ\'אט חסרה או לא תקינה במבנה המצופה' });
        }

        const model = modelName || 'gemini-2.5-flash';

        // 2. הגדרת הוראות המערכת (System Instructions) בנפרד מההיסטוריה
        const systemInstructionText = `
        You are a smart assistant for a transcription app.
        Use the following transcript JSON for grounding: ${JSON.stringify(contextSubs || [])}.
        
        Instructions:
        1. Answer in Hebrew based ONLY on the transcript.
        2. If the answer is found in specific segments, citation is MANDATORY.
        3. Citation format: Append [[id:mm:ss]] to the relevant sentence. 
        4. Format lists using simple bullet points.
        5. DO NOT REPEAT THE TRANSCRIPT. Summarize and answer concisely.
        6. If the text contains [דובר] or [שואל], prefix your response with that tag to indicate who is speaking.
        `;

        // 3. יצירת עותק עמוק (Deep Copy) של ההיסטוריה למניעת מוטציות מסוכנות
        const safeHistory = JSON.parse(JSON.stringify(historyForApi));
        
        // הוספת שאלת המשתמש להודעה האחרונה בצורה בטוחה (אם היא לא קיימת שם כבר)
        const lastMessage = safeHistory[safeHistory.length - 1];
        if (msgPrompt && lastMessage.parts && lastMessage.parts[0]) {
             // שרשור השאלה הספציפית לטקסט הקיים במקום לדרוס אותו
             lastMessage.parts[0].text += `\n\nUser Question: "${msgPrompt}"`;
        }

        // 4. שליחה ל-Gemini עם הפרדה נקייה של הוראות המערכת (systemInstruction)
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                systemInstruction: {
                    parts: [{ text: systemInstructionText }]
                },
                contents: safeHistory 
            })
        });

        // טיפול נכון גם בשגיאות של ה-Chat API
        if (!response.ok) {
            const errText = await response.text();
            console.error('Google Chat API Error:', errText);
            return res.status(response.status).json({ error: 'שגיאת API מגוגל', details: errText });
        }
        
        res.json(await response.json());
        
    } catch (error) {
        console.error('Chat API Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// הפעלת השרת 
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});