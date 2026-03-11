const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // מאפשר קבלת קבצי JSON גדולים (כמו היסטוריית תמלול)

// ==========================================
// 1. נתיב התמלול (כבר עשינו)
// ==========================================
app.post('/api/transcribe', async (req, res) => {
    try {
        const { apiKey, fileUri, mimeType, modelName, promptCtx } = req.body;
        if (!apiKey || !fileUri) return res.status(400).json({ error: 'חסר מפתח או קובץ' });

        const model = modelName || 'gemini-2.5-flash';
        const systemPrompt = `תפקיד: מומחה תמלול שיעורי תורה בהגיה תלמודית ישיביתית לשון הקודש ארמית.
הוראה: מטרת המשימה ומהות התוצר

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
4. אל תרד שורות (Enter) בתוך ערכי הטקסט.
${promptCtx ? 'הקשר: ' + promptCtx : ''}`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt }, { fileData: { mimeType: mimeType || 'audio/mpeg', fileUri: fileUri } }] }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });

        if (!response.ok) throw new Error(await response.text());
        res.json(await response.json());
    } catch (error) {
        console.error('Transcription Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 2. נתיב הצ'אט החדש והסודי!
// ==========================================
app.post('/api/chat', async (req, res) => {
    try {
        const { apiKey, modelName, historyForApi, contextSubs, msgPrompt } = req.body;
        if (!apiKey) return res.status(400).json({ error: 'חסר מפתח API' });

        const model = modelName || 'gemini-2.5-flash';

        // ------------------------------------------------------------------
        // הפרומפט הסודי של הצ'אט! מוגן לחלוטין בשרת
        // ------------------------------------------------------------------
        const systemPrompt = `
        You are a smart assistant for a transcription app.
        Use the following transcript JSON for grounding: ${JSON.stringify(contextSubs)}.

        User Question: "${msgPrompt}"
        
        Instructions:
        1. Answer in Hebrew based ONLY on the transcript.
        2. If the answer is found in specific segments, citation is MANDATORY.
        3. Citation format: Append [[id:mm:ss]] to the relevant sentence. 
        4. Format lists using simple bullet points.
        5. DO NOT REPEAT THE TRANSCRIPT. Summarize and answer concisely.
        6. If the text contains [דובר] or [שואל], prefix your response with that tag to indicate who is speaking.
        `;

        // אנחנו מלבישים את הפרומפט הסודי על ההודעה האחרונה של המשתמש
        const lastUserMessage = historyForApi[historyForApi.length - 1];
        lastUserMessage.parts[0].text = systemPrompt;

        // שולחים לגוגל
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: historyForApi })
        });

        if (!response.ok) throw new Error(await response.text());
        res.json(await response.json());
    } catch (error) {
        console.error('Chat API Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));