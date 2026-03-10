const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config(); // טוען את המפתח הסודי מהכספת
const app = express();
app.use(cors()); // מאפשר לאתר שלך ב-Firebase לדבר עם השרת הזה
app.use(express.json());

// כאן השרת מקבל את הבקשה מהאתר שלך
app.post('/transcribe', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY; // המפתח נשלף מהשרת, לא מהדפדפן!
    
    // כאן נשים את הלוגיקה שמדברת עם גוגל...
    // בסוף מחזירים את הטקסט למשתמש
    res.json({ text: "הנה התמלול שלך" });
});

app.listen(3000, () => console.log("השרת באוויר!"));