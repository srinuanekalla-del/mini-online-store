require('dotenv').config();
const { openDb } = require('./db');
const { createApp } = require('./app');

const db = openDb();
const app = createApp(db);
const port = Number(process.env.PORT) || 3000;

app.listen(port, () => console.log(`Mini Online Store running at http://localhost:${port}`));
