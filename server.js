const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// מאפשר לכל אתר לפנות לשרת הזה (בהמשך נוכל להגביל את זה רק לאתר שלך)
app.use(cors());

// מאפשר לשרת לקרוא מידע מסוג JSON
app.use(express.json());

// נקודת הקצה שמקבלת את הבקשה מהדפדפן של הלקוח
app.post('/api/transcribe', async (req, res) => {
    try {
        // הנתונים שהדפדפן שולח אלינו (מפתח ה-API והקובץ שכבר הועלה לגוגל)
        const { apiKey, fileUri, mimeType, modelName, promptCtx } = req.body;

        if (!apiKey || !fileUri) {
            return res.status(400).json({ error: 'חסרים נתונים: מפתח API או URI של קובץ' });
        }

        const model = modelName || 'gemini-2.5-flash';

        // ------------------------------------------------------------------
        // הסוד שלך! הפרומפט הזה חי רק בשרת ואף אחד לא יכול לראות או להעתיק אותו
        // ------------------------------------------------------------------
        const systemPrompt = `תפקיד: מומחה תמלול.
הוראה: תמלל את האודיו לעברית תקנית.
כללים:
1. תקן שגיאות הגייה ודקדוק.
2. הפלט חייב להיות אובייקט JSON תקין בלבד, ללא שום טקסט נוסף וללא עיצוב, במבנה הבא בדיוק:
{
  "summary": "כתוב סיכום של התוכן בשפה העברית בלבד. הסיכום חייב להיות באורך של עד 25 מילים ולא מעבר לכך.",
  "subtitles": [{"start":"HH:MM:SS,mmm","end":"HH:MM:SS,mmm","text":"..."}]
}
3. קריטי: אסור להשתמש במרכאות כפולות (") בתוך ערכי הטקסט (summary או text). השתמש בגרש יחיד (') בלבד.
4. אל תרד שורות (Enter) בתוך ערכי הטקסט.
${promptCtx ? 'הקשר: ' + promptCtx : ''}`;

        // פנייה לשרתים של גוגל באמצעות המפתח של הלקוח אבל עם הפרומפט שלך
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: systemPrompt },
                        { fileData: { mimeType: mimeType || 'audio/mpeg', fileUri: fileUri } }
                    ]
                }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`שגיאה מגוגל: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        
        // שליחת התשובה המוכנה (התמלול) חזרה לדפדפן של הלקוח
        res.json(data);

    } catch (error) {
        console.error('שגיאת שרת:', error);
        res.status(500).json({ error: error.message });
    }
});

// הפעלת השרת
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});