const express = require('express');
const cors = require('cors');
// הוספנו את זה כדי לפתור את קריסת השרת ולתמוך ב-fetch
const fetch = require('node-fetch'); 

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // מאפשר קבלת קבצי JSON גדולים (כמו היסטוריית תמלול)

// ==========================================
// 1. נתיב התמלול (גרסה משופרת לסנכרון ואי-תרגום)
// ==========================================
app.post('/api/transcribe', async (req, res) => {
    // הגדלת זמן ה-Timeout של הבקשה הספציפית הזו בשרת (לדוגמה: 5 דקות)
    req.setTimeout(300000); 

    try {
        const { apiKey, fileUri, mimeType, modelName, promptCtx } = req.body;
        
        // ולידציה בסיסית
        if (!apiKey || !fileUri) {
            return res.status(400).json({ error: 'חסר מפתח API או File URI של הקובץ' });
        }

        const model = modelName || 'gemini-2.5-flash';
        
        // 1. ההנחיות המעודכנות: כוללות סנכרון לנגן ואי-תרגום שפות זרות
        const systemInstructionText = `תפקיד: מומחה תמלול וסנכרון כתוביות מקצועי.
המטרה: להפיק תמלול מדויק בפורמט JSON הכולל כתוביות (SRT style) וסיכום. האודיו כולל שיחה או הרצאה בעברית שמשולבים בה מילים וביטויים רבים מ"לשון הקודש" עם הגייה מסורתית.

חוקי שפה ותרגום (קריטי):
1. אין לתרגם שפות! אם הדובר עובר לאנגלית (או שפה זרה אחרת), תמלל את המילים בשפת המקור (באותיות לטיניות). אל תתרגם לעברית.
2. התיקון היחיד המותר הוא "נורמליזציה" של הגיית לשון הקודש לכתיב עברי תקני כמפורט בהמשך.

חוקי איכות התמלול והסנכרון (קריטי לנגן ולחוויית קריאה):
1. תמלול נקי (Clean Verbatim): התעלם לחלוטין ממילות מילוי ('אה', 'אממ', 'אהה'), גמגומים וחזרות מיותרות. אל תכתוב אותן. ספק טקסט רציף וקריא.
2. מניעת הזיות (Hallucinations): בשתיקות ארוכות, רעשי רקע או מוזיקה - אל תמציא טקסט! התעלם לחלוטין משקט. אם הדיבור אינו מובן כלל, השתמש בתגית [לא ברור].
3. אסתטיקת כתוביות: לעולם אל תסיים כתובית באות יחס (כמו 'ו', 'ב', 'ל', 'מ', 'ש') או בפסיק (,). נקודה (.) בסוף משפט תמיד תסיים את הכתובית הנוכחית.
4. מקטעים קצרים: כל כתובית צריכה להכיל בין 3 ל-7 מילים, או להימשך מקסימום 5 שניות.
5. דיוק זמנים: זמני ה-start וה-end חייבים להיות מדויקים פונטית לדיבור. פורמט: HH:MM:SS,mmm.

עקרון מפתח: נורמליזציה לכתיב תקני של לשון הקודש:
יש ליישם תיקון אוטומטי של הגיית לשון הקודש חזרה לכתיב התקני העברי הסטנדרטי:
- עיצורים: 'כסיב'/'שבס' -> כתיב/שבת. 'בראסיס' -> בראשית. 'מיתרה' -> מטרה.
- תנועות: 'שולויים'/'קוֹדוֹיש' -> שלום/קדוש. 'סויד'/'חוכמו' -> סוד/חכמה. 'חילק'/'אימת' -> חלק/אמת.
- מונחי מפתח: 'שבס קוידש' -> שבת קודש. 'עוילם' -> עולם. 'עיון' -> עיון. 'קא' נשאר קא. 'להוי' -> להיות.

כללי פלט JSON (Strict):
הפלט חייב להיות אובייקט JSON תקין בלבד, ללא שום טקסט נוסף או עיצוב (ללא סימון \`\`\`json).
קריטי: אסור להשתמש במרכאות כפולות (") בתוך ערכי הטקסט (summary או text). השתמש בגרש יחיד (') בלבד. אל תרד שורות בתוך הטקסט.
* שים לב: הדוגמה הבאה נועדה להמחשת המבנה, חיתוך הזמנים וניקוי הרעשים בלבד. התוכן, כמובן, יהיה שונה בהתאם לאודיו שתקבל.
דוגמת ביצוע (Few-Shot Example):
דוגמה לאודיו בו הדובר אומר: "אז... אהה... אנחנו לומדים היום על... שבס קוידש. ו... זה כמובן מאוד חשוב."
פלט מצופה:
{
  "summary": "הדובר פותח את השיעור ומציין שהיום נלמד על חשיבותה של שבת קודש.",
  "subtitles": [
    {"start":"00:00:01,000","end":"00:00:03,500","text":"אז אנחנו לומדים היום על"},
    {"start":"00:00:03,500","end":"00:00:05,200","text":"שבת קודש."},
    {"start":"00:00:06,000","end":"00:00:08,000","text":"וזה כמובן מאוד חשוב."}
  ]
}`;
        // 2. בניית התוכן
        const requestParts = [
            { fileData: { mimeType: mimeType || 'audio/mpeg', fileUri: fileUri } }
        ];
        
        if (promptCtx) {
            requestParts.push({ text: `הקשר לאודיו זה שיעזור לך בתמלול: ${promptCtx}` });
        }

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        // 3. השליחה לגוגל - תיקון המבנה של הפקודה
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemInstructionText }] },
                contents: [{ parts: requestParts }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });

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
// 2. נתיב הצ'אט (ללא שינוי)
// ==========================================
app.post('/api/chat', async (req, res) => {
    try {
        const { apiKey, modelName, historyForApi, contextSubs, msgPrompt } = req.body;
        
        if (!apiKey) return res.status(400).json({ error: 'חסר מפתח API' });
        if (!historyForApi || !Array.isArray(historyForApi) || historyForApi.length === 0) {
            return res.status(400).json({ error: 'היסטוריית הצ\'אט חסרה או לא תקינה במבנה המצופה' });
        }

        const model = modelName || 'gemini-2.5-flash';

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

        const safeHistory = JSON.parse(JSON.stringify(historyForApi));
        
        const lastMessage = safeHistory[safeHistory.length - 1];
        if (msgPrompt && lastMessage.parts && lastMessage.parts[0]) {
             lastMessage.parts[0].text += `\n\nUser Question: "${msgPrompt}"`;
        }

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                systemInstruction: { parts: [{ text: systemInstructionText }] },
                contents: safeHistory 
            })
        });

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
// ==========================================
// 3. נתיב השכמה (Ping) למניעת הירדמות מוחלטת
// ==========================================
app.get('/api/wakeup', (req, res) => {
    res.json({ status: 'awake', message: 'בוקר טוב! השרת התעורר ומוכן לעבודה.' });
});
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
