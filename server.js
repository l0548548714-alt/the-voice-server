const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// הגדרת CORS - קריטי לאבטחה!
// תחליף את הכתובת הזו בכתובת ה-Firebase האמיתית שלך אחרי שתעלה את האתר
const allowedOrigins = ['http://localhost:5000', 'https://your-firebase-app.web.app'];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

// מאפשר לשרת לקרוא מידע מסוג JSON
app.use(express.json());

// נקודת הקצה (Endpoint) שמקבלת את הבקשה מהדפדפן
app.post('/api/transcribe', async (req, res) => {
    try {
        // הנתונים שהדפדפן שולח אלינו
        const { apiKey, fileUri, mimeType, modelName, promptCtx } = req.body;

        if (!apiKey || !fileUri) {
            return res.status(400).json({ error: 'חסרים נתונים: מפתח API או URI של קובץ' });
        }

        const model = modelName || 'gemini-2.5-flash';

        // ------------------------------------------------------------------
        // כאן נמצא הסוד שלך! הפרומפט הזה חי רק בשרת ואף אחד לא יכול לראות אותו
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

        // פנייה לשרתים של גוגל באמצעות המפתח של הלקוח
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
        
        // שליחת התשובה המוכנה חזרה לדפדפן של הלקוח
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